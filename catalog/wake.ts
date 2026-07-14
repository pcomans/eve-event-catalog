import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";

import type { Subscription, SubscriptionStatus, WakePayload } from "./types.ts";
import {
  getSubscription,
  listSubscriptions,
  listSubscriptionsByStatus,
  tryTransitionToDelivering,
  updateSubscription,
} from "./registry.ts";
import { findEventType, getProvider } from "./catalog.ts";
import { logCatalog } from "./log.ts";
import { recordEvent } from "./history.ts";

const redis = Redis.fromEnv();

// Arming still uses a single-process claim guard: all callers (the
// turn.completed handler, chiefly) live in this one Node process today, and
// arm-racing is out of Phase 1's scope (docs/plan-vercel-production.md —
// fenced leases for the *connector*'s watcher tier are a Phase 2 concern). A
// Set with a synchronous check-then-set (no `await` between them) is enough
// to make "claim, then do the async work" atomic, since nothing else can run
// on the event loop between those two lines.
const armClaimed = new Set<string>();

// Delivery claims, in contrast, are Redis leases (SET NX PX), not an
// in-process Set: correctness prerequisite 4 (claim-then-publish is a dual
// write) requires the claim to survive a process crash, so a *different*
// process (or the same one, restarted) can find a stranded "delivering"
// subscription and finish delivering it — see sweepStrandedDeliveries below.
const DELIVERY_LEASE_KEY = (subscriptionId: string) => `catalog:lease:delivery:${subscriptionId}`;
// Generous relative to a localhost wake POST (ms). NOTE: unlike a plain
// mutex, a lease TTL shorter than an in-flight delivery does NOT stay
// safe — it lets a second caller acquire the lease and become a concurrent
// "owner" while the first is still working. What actually bounds the damage
// from that is the wake-delivered marker below (route-side dedupe by
// subscriptionId): the one thing that truly must never happen twice — the
// agent actually being woken — is deduped there, independent of how many
// callers momentarily believe they hold the lease.
const DELIVERY_LEASE_TTL_MS = 30_000;

/** True if this process (or another) currently holds the delivery lease for `subscriptionId`. */
async function isDeliveryLeaseHeld(subscriptionId: string): Promise<boolean> {
  return (await redis.get(DELIVERY_LEASE_KEY(subscriptionId))) !== null;
}

/**
 * Atomically claims the delivery lease under a caller-chosen `ownerToken`
 * (a fresh random value per acquisition attempt — see deliverWake). Returns
 * false if another caller already holds it.
 */
export async function acquireDeliveryLease(subscriptionId: string, ownerToken: string): Promise<boolean> {
  const result = await redis.set(DELIVERY_LEASE_KEY(subscriptionId), ownerToken, {
    nx: true,
    px: DELIVERY_LEASE_TTL_MS,
  });
  return result === "OK";
}

// Compare-and-delete: releases the lease ONLY if it still holds this exact
// ownerToken. A plain unconditional DEL would let a slow original deliverer
// (e.g. one whose lease already expired and was reacquired by a resuming
// sweep) delete its successor's still-active lease out from under it — this
// Lua script makes "is this still mine?" and "delete it" one atomic
// round-trip, closing that gap.
const RELEASE_LEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

/** Releases the delivery lease only if `ownerToken` still matches the current holder. A no-op otherwise. */
export async function releaseDeliveryLease(subscriptionId: string, ownerToken: string): Promise<void> {
  await redis.eval(RELEASE_LEASE_SCRIPT, [DELIVERY_LEASE_KEY(subscriptionId)], [ownerToken]);
}

// Route-side dedupe by subscriptionId (correctness prerequisite 4: "queue
// consumers dedupe by subscriptionId"). This is a separate mechanism from
// the delivery lease above: the lease arbitrates *who attempts* delivery;
// this marker records whether the agent was *actually woken* — the one
// side effect that must never happen twice, independent of however many
// processes momentarily raced on the lease. It's two-phase because a plain
// "sent" flag can't tell "nobody has tried yet" apart from "someone is
// trying RIGHT NOW" — without that distinction, two processes racing a
// crash-recovery resume could both pass a naive check and both call send().
//   1. "sending" — claimed via SET NX (only one caller ever wins this),
//      short TTL: a crash between claiming and actually sending must not
//      block recovery for long, since nothing else knows to retry it until
//      this expires.
//   2. "sent" — upgraded (unconditional SET, since only the claim holder
//      reaches this point) once send() has actually succeeded, carrying the
//      exact firedAt the agent's envelope saw. Long TTL: this must outlive
//      any conceivable delivering-recovery gap, not just "be generous".
// Checked by both deliverWake (a fast path: skip re-POSTing entirely once
// "sent" is known) and the /catalog/wake route itself (the authoritative
// claim/upgrade, since only the route knows whether `send()` actually
// succeeded — see agent/channels/catalog.ts).
const WAKE_DELIVERY_MARKER_KEY = (subscriptionId: string) => `catalog:wake-delivered:${subscriptionId}`;
// Raised from an initial 60s: that was tight relative to realistic send()
// latency variance, and a claim expiring mid-send lets a retry re-claim and
// re-send while the original call is still in flight. 5 minutes gives
// generous headroom. ACCEPTED LIMIT, not engineered further (AGENTS.md rule
// 1): a send() that genuinely outlasts this can still produce a duplicate
// wake once the claim expires and a retry re-sends — it surfaces loudly via
// the alreadyDelivered/alreadyInFlight log lines rather than silently, and
// that's judged an acceptable trade for this POC.
const WAKE_CLAIM_TTL_SECONDS = 300;
const WAKE_SENT_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface WakeDeliveryMarker {
  phase: "sending" | "sent";
  /** Present only during "sending" — the owner token from claimWakeDelivery, used by the token-CAS upgrade/clear below. */
  token?: string;
  firedAt?: string;
}

/**
 * Phase 1: claims the right to send this subscription's wake exactly once.
 * Returns a fresh owner token on success (pass it to markWakeSent /
 * clearWakeClaim later — see the token-CAS comment below), or `null` if
 * another caller already claimed it (still sending, or already sent) — the
 * caller must not call `send()` in that case.
 */
export async function claimWakeDelivery(subscriptionId: string): Promise<string | null> {
  const token = randomUUID();
  const result = await redis.set(
    WAKE_DELIVERY_MARKER_KEY(subscriptionId),
    { phase: "sending", token } satisfies WakeDeliveryMarker,
    { nx: true, ex: WAKE_CLAIM_TTL_SECONDS },
  );
  return result === "OK" ? token : null;
}

export async function getWakeDeliveryMarker(subscriptionId: string): Promise<WakeDeliveryMarker | null> {
  return redis.get<WakeDeliveryMarker>(WAKE_DELIVERY_MARKER_KEY(subscriptionId));
}

// Token-CAS for the upgrade/clear operations below: only the caller holding
// the exact token CURRENTLY stored may upgrade or clear the claim — a slow
// original route call (e.g. one whose own claim already expired and was
// re-claimed by a retry) can never clobber a successor's claim. This checks
// the token as a plain-text substring of the raw stored JSON
// (`"token":"<token>"`) rather than decoding it: registry.ts's
// tryTransitionToDelivering already found decoding+re-encoding through
// Lua's cjson corrupts data on Upstash's actual sandbox (empty objects
// silently become arrays, a null-workaround marker can collide with real
// data) — a substring search never touches cjson, and the actual new value
// is built in JS (JSON.stringify) rather than reconstructed in Lua.
function tokenFragment(token: string): string {
  return `"token":"${token}"`;
}

const MARKER_TOKEN_UPGRADE_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if raw == false then return 0 end
if string.find(raw, ARGV[1], 1, true) == nil then return 0 end
redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
return 1
`;

const MARKER_TOKEN_CLEAR_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if raw == false then return 0 end
if string.find(raw, ARGV[1], 1, true) == nil then return 0 end
redis.call("DEL", KEYS[1])
return 1
`;

/**
 * Phase 2: upgrades a claim to "sent" — but ONLY if `token` still matches
 * the current claim holder (see the token-CAS comment above). Call after
 * `send()` has actually succeeded. Returns false if the CAS missed (the
 * claim was no longer this caller's, e.g. it expired and was re-claimed) —
 * the route treats that as a loud, non-fatal "markerUpgradeFailed" case,
 * never as a reason to report the wake itself as failed (the agent's
 * session already resumed; that's the fact that matters).
 */
export async function markWakeSent(subscriptionId: string, firedAt: string, token: string): Promise<boolean> {
  const newValue = JSON.stringify({ phase: "sent", firedAt } satisfies WakeDeliveryMarker);
  const result = await redis.eval<[string, string, string], number>(
    MARKER_TOKEN_UPGRADE_SCRIPT,
    [WAKE_DELIVERY_MARKER_KEY(subscriptionId)],
    [tokenFragment(token), newValue, String(WAKE_SENT_TTL_SECONDS)],
  );
  return result === 1;
}

/**
 * Releases a claim on a known `send()` failure (not a crash — an actual
 * caught error) — but ONLY if `token` still matches the current claim
 * holder — so a retry doesn't have to wait out the claim's TTL. Honest
 * limitation, not eliminated: there is still a narrow window between
 * `send()` succeeding and markWakeSent landing where a crash would leave
 * the claim in place until its TTL expires, then allow a duplicate send —
 * closing that fully would need `send()` and the marker upgrade to be one
 * atomic operation, which they aren't; accepted per AGENTS.md rule 1. What
 * this two-phase design DOES close is the much more likely case: a crash
 * between claiming and sending (recovered within the claim TTL, no
 * duplicate) and a crash right after a successful send but before the
 * subscription's own status reaches a terminal value (the "sent" marker's
 * stored firedAt lets a resuming caller complete that transition without
 * resending).
 */
export async function clearWakeClaim(subscriptionId: string, token: string): Promise<void> {
  await redis.eval<[string], number>(MARKER_TOKEN_CLEAR_SCRIPT, [WAKE_DELIVERY_MARKER_KEY(subscriptionId)], [
    tokenFragment(token),
  ]);
}

const TERMINAL_STATUSES = new Set<SubscriptionStatus>(["fired", "expired", "failed"]);

/**
 * Console log line + append-only history entry, together — every wake.ts
 * transition gets both. The history write is best-effort: a Redis hiccup
 * writing history must not fail the caller's own transition (e.g. mark an
 * armed subscription "failed", or strand a delivery lease) just because
 * observability plumbing hiccuped — the console log line still lands
 * unconditionally either way.
 */
export async function logAndRecord(
  action: string,
  sub: Pick<Subscription, "conversationId" | "id" | "provider" | "event" | "status">,
  extra: Record<string, unknown> = {},
): Promise<void> {
  logCatalog(action, sub, extra);
  try {
    await recordEvent(action, sub, extra);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logCatalog("history-write-failed", sub, { action, error: message });
  }
}

// Wake delivery has exactly one implementation: the POST /catalog/wake route
// in agent/channels/catalog.ts, which owns `send()` and the session-id-match
// check. Internal callers (expiry timers, provider ticks) go through that
// same route over HTTP rather than duplicating its logic — the channel route
// and internal callers share one code path, just as an external synthetic
// wake (AT-2) would.
/**
 * Pure precedence logic for CATALOG_BASE_URL (Codex gate finding, fix round
 * p4c, MED): the plain `?? localhost:$PORT` fallback this replaced is
 * correct ONLY in local dev — a deployed Vercel Function has nothing
 * listening on localhost, so a schedule/wake loopback with no explicit
 * override used to throw before the route it's calling could even run (only
 * the outer task failure was observable). Precedence:
 * (a) an explicit CATALOG_BASE_URL always wins;
 * (b) on Vercel, `VERCEL_URL` is injected automatically (hostname only, no
 *     protocol — Vercel's own convention), so this derives
 *     `https://${VERCEL_URL}`;
 * (c) local dev falls back to `http://localhost:$PORT` (PORT itself
 *     defaulting to 2000, eve's own default).
 * `env` is passed in so this is testable without touching process.env — see
 * catalog/wake-base-url.test.ts (kept out of wake.test.ts on purpose: that
 * file's other tests exercise deliverWake/delivering state and aren't safe
 * to run solo, per this project's process rules — a pure function like this
 * one shouldn't be bundled into that same all-or-nothing file).
 */
export function resolveCatalogBaseUrl(env: Record<string, string | undefined>): string {
  if (env.CATALOG_BASE_URL) return env.CATALOG_BASE_URL;
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  return `http://localhost:${env.PORT ?? 2000}`;
}

// Exported for agent/schedules/market-open.ts, the other internal caller
// that self-POSTs into this same running server (see that file's own
// comment) — one definition of "how do we reach ourselves," not duplicated.
export const CATALOG_BASE_URL = resolveCatalogBaseUrl(process.env);

const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Starts (or restarts) the expiry timer for an armed subscription. No-op if it has no `expiresAt`. */
export function scheduleExpiry(sub: Subscription): void {
  if (!sub.expiresAt) return;
  cancelExpiry(sub.id);
  const delayMs = new Date(sub.expiresAt).getTime() - Date.now();
  const timer = setTimeout(() => void expire(sub.id), Math.max(delayMs, 0));
  expiryTimers.set(sub.id, timer);
}

export function cancelExpiry(subscriptionId: string): void {
  const timer = expiryTimers.get(subscriptionId);
  if (timer) {
    clearTimeout(timer);
    expiryTimers.delete(subscriptionId);
  }
}

async function expire(subscriptionId: string): Promise<void> {
  const sub = await getSubscription(subscriptionId);
  // Already delivered or disarmed by the time the timer ran: nothing to do.
  if (!sub || sub.status !== "armed") return;
  await deliverWake(sub, { reason: "expired" });
}

export interface DeliverOptions {
  reason: "fired" | "expired";
  snapshot?: Record<string, unknown>;
}

/** Builds the stable WakePayload envelope handed to /catalog/wake. Pure — no I/O. */
export function buildWakePayload(
  sub: Subscription,
  options: DeliverOptions,
  firedAt: string,
): WakePayload {
  return {
    subscriptionId: sub.id,
    provider: sub.provider,
    event: sub.event,
    resource: sub.resource,
    snapshot: options.snapshot,
    firedAt,
    reason: options.reason,
  };
}

/**
 * Builds the exact top-level shape sent to /catalog/wake and, folded into
 * the message, shown to the agent: {subscribedAt, firedAt, payload, guidance}.
 * `payload` is nested, not spread — a payload containing fields literally
 * named `subscribedAt`/`firedAt`/`guidance` lands inside `envelope.payload`,
 * never able to overwrite the channel-generated top-level ones. `guidance`
 * is likewise a sibling of `payload`, never sourced from it — see
 * resolveWakeGuidance's doc comment for why that separation is the whole
 * point. Pure — no I/O.
 */
export function buildWakeEnvelope(
  subscribedAt: string,
  firedAt: string,
  payload?: Record<string, unknown>,
  guidance?: string,
): { subscribedAt: string; firedAt: string; payload?: Record<string, unknown>; guidance?: string } {
  return { subscribedAt, firedAt, payload, guidance };
}

// Shown for reason: "expired", regardless of event type — an edge-triggered
// predicate that never crossed means the same thing no matter what it was
// watching, so unlike a "fired" wake's guidance this isn't looked up per
// provider/event in catalog.json.
const EXPIRED_GUIDANCE =
  "This subscription's condition never triggered before it expired. Expiry only proves the tracked " +
  "transition never happened during the window you were watching — not what the underlying value was " +
  "doing the whole time (e.g. a threshold could already have been past it before you started watching, " +
  "or never gone near it). Close the loop with the user conversationally without asserting where things " +
  "actually stood, and do not act as though the event happened.";

/**
 * Resolves the prompt-shaped guidance a wake carries. SECURITY BOUNDARY: the
 * returned text always originates from catalog.json (via `sub.provider`/
 * `sub.event` — the subscription's own fields, fixed and Ajv-validated at
 * subscribe() time) or the hardcoded constant above; it is never read from
 * `options.snapshot`, which is provider-supplied, external, untrusted data.
 * The subscription's provider/event are used only as a lookup KEY into
 * repo-owned text, never as the guidance content itself — see AGENTS.md.
 * Pure.
 */
export function resolveWakeGuidance(sub: Subscription, options: DeliverOptions): string | undefined {
  if (options.reason === "expired") return EXPIRED_GUIDANCE;
  return findEventType(sub.provider, sub.event)?.onWake;
}

/**
 * True if a raw /catalog/wake request body tries to supply its own
 * `guidance` field. The route must reject these outright (400), not just
 * ignore them: `guidance` is the one field the agent is told to treat as
 * trusted instructions rather than data, and the route is unauthenticated —
 * silently overwriting a caller-supplied value would still mean the wire
 * carried it, and a future refactor could accidentally start trusting it
 * again. Checked by key presence, not truthiness (`{guidance: null}` must
 * still be rejected). Pure.
 */
export function rejectsCallerSuppliedGuidance(body: Record<string, unknown>): boolean {
  return "guidance" in body;
}

/**
 * The route-side counterpart to resolveWakeGuidance: looks up the
 * subscription a wake request claims to be about and resolves its guidance
 * from catalog.json, entirely server-side. This is what makes it safe for
 * /catalog/wake to stay unauthenticated — a caller can say "subscriptionId X
 * fired" but can never supply the guidance text itself, only trigger a
 * lookup of what this repo already says about X. Returns undefined for a
 * synthetic wake with no real subscription (AT-2), an unknown
 * subscriptionId, or a missing reason.
 */
export async function resolveGuidanceForWakeRequest(
  subscriptionId: string | undefined,
  reason: DeliverOptions["reason"] | undefined,
): Promise<string | undefined> {
  if (!subscriptionId || !reason) return undefined;
  const sub = await getSubscription(subscriptionId);
  if (!sub) return undefined;
  return resolveWakeGuidance(sub, { reason });
}

async function disarmSafely(sub: Subscription): Promise<void> {
  try {
    await getProvider(sub.provider).disarm(sub);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logCatalog("disarm-failed", sub, { error: message });
  }
}

/**
 * Outcome of one deliverWake call:
 * - "completed" — the wake was actually sent (or already had been) and the
 *   subscription reached fired/expired.
 * - "failed" — a DEFINITIVELY PERMANENT error: the subscription is now
 *   "failed" and the sweep will never retry it. Reserved for the two route
 *   responses that can never succeed on retry (400 guidance-rejected, 404
 *   unknown-conversation) — see PermanentWakeError.
 * - "deferred" — this call attempted real work (a send, or the terminal
 *   write) and hit a RETRYABLE error (network failure, 5xx, a transient
 *   marker-read failure, a response-parse failure, or the terminal write
 *   itself failing) — the subscription is left exactly as "delivering" so
 *   the next sweep round retries it.
 * - "skipped" — this call did no work at all: lost the race for the
 *   delivering intent or the lease, the subscription was already terminal,
 *   or the route reported a claim collision (alreadyInFlight).
 *
 * A 4-way enum rather than a boolean so a caller (sweepStrandedDeliveries)
 * can tell these apart without re-reading Redis — critically, "deferred"
 * must never be conflated with "failed": Codex's counterexample was a
 * transient getWakeDeliveryMarker() failure terminalizing the subscription
 * as "failed" before any POST even went out — and since
 * sweepStrandedDeliveries only ever scans status "delivering", a "failed"
 * subscription is invisible to recovery FOREVER. See PermanentWakeError.
 */
export type DeliverOutcome = "completed" | "failed" | "deferred" | "skipped";

/**
 * Thrown ONLY for the two route responses that are DEFINITIVELY PERMANENT —
 * 400 (guidance-rejected: a caller bug that can never succeed on retry) and
 * 404 (unknown-conversation: the conversation record is genuinely gone).
 * This is the ONLY error type deliverWake's catch block will terminalize a
 * subscription as "failed" for. Everything else that can go wrong inside
 * the try block below — a network error, any other HTTP status, a
 * response-parse failure, a transient getWakeDeliveryMarker() failure, or
 * even the terminal-status updateSubscription() call itself failing — is
 * infra noise, not proof the wake can never be delivered, and must leave
 * the subscription retryable (see the catch block's own comment).
 */
class PermanentWakeError extends Error {}

/**
 * armed -> delivering -> fired | expired | failed. Cancels any pending
 * expiry timer first.
 *
 * The armed/pending -> delivering transition is now a single atomic Lua
 * script (registry.ts's tryTransitionToDelivering), not a plain
 * read-then-write: two callers with *different* reasons (e.g. an expiry
 * timer and a provider tick) racing on the same one-shot subscription used
 * to be able to both write their own deliverReason, with whichever wrote
 * last silently overwriting the other's — worse, a sufficiently delayed
 * write could even regress an already-terminal subscription back to
 * "delivering". Now exactly one caller ever establishes deliverReason;
 * every other caller (whether racing at the same instant, or resuming a
 * stranded delivery much later) reads back that SAME established
 * reason/snapshot rather than trying to inject its own.
 *
 * The delivery lease (SET NX PX under a fresh per-call ownerToken, released
 * via compare-and-delete) is a second, separate mechanism layered on top:
 * it arbitrates *who actually attempts* the wake POST once the delivering
 * intent is established, and survives a process crash so a *different*
 * process (or the same one restarted) can find a stranded "delivering"
 * subscription and finish delivering it — see sweepStrandedDeliveries.
 *
 * The wake-delivery marker is a third mechanism: once the lease is won, a
 * resume that already knows (via the marker) the agent was actually woken
 * skips the HTTP POST entirely and completes the terminal-status write
 * using the marker's own recorded firedAt — never sending a second wake for
 * a one-shot subscription, and never inventing a firedAt the agent's
 * envelope never actually saw.
 */
export async function deliverWake(sub: Subscription, options: DeliverOptions): Promise<DeliverOutcome> {
  // ownerToken is only assigned once the lease is actually acquired (below),
  // so `finally` knows whether it holds anything worth releasing — see its
  // own comment.
  let ownerToken: string | null = null;

  try {
    const transitioned = await tryTransitionToDelivering(sub.id, options.reason, options.snapshot ?? null);

    let deliveringSub: Subscription;
    if (transitioned) {
      deliveringSub = transitioned;
      cancelExpiry(sub.id);
      await logAndRecord("delivering", deliveringSub, { reason: deliveringSub.deliverReason });
    } else {
      // Either already terminal (an earlier caller finished first), or
      // another caller already established the delivering intent — re-read
      // to find out which. If it's the latter, resume using THEIR
      // established reason/snapshot: the atomic transition above is the
      // single source of truth for what this subscription is actually being
      // delivered for, never re-derived from this call's own (losing) options.
      const current = await getSubscription(sub.id);
      if (!current || TERMINAL_STATUSES.has(current.status)) return "skipped";
      if (current.status !== "delivering" || !current.deliverReason) return "skipped"; // defensive; shouldn't happen
      deliveringSub = current;
    }

    const attemptToken = randomUUID();
    const acquired = await acquireDeliveryLease(sub.id, attemptToken);
    if (!acquired) return "skipped"; // another caller already owns delivery for this subscription
    ownerToken = attemptToken;

    const reason = deliveringSub.deliverReason as "fired" | "expired";
    const snapshot = deliveringSub.deliverSnapshot ?? undefined;

    let firedAt: string;
    const marker = await getWakeDeliveryMarker(sub.id);
    if (marker?.phase === "sent" && marker.firedAt) {
      // Already fully delivered by an earlier attempt that crashed before
      // writing the terminal status — reuse ITS firedAt (the one the
      // agent's envelope actually carried), never a fresh timestamp.
      firedAt = marker.firedAt;
    } else {
      firedAt = new Date().toISOString();
      const payload = buildWakePayload(sub, { reason, snapshot }, firedAt);
      const res = await fetch(`${CATALOG_BASE_URL}/catalog/wake`, {
        method: "POST",
        // POST /catalog/wake requires the same bearer secret as any other
        // caller (AT-10) — deliverWake is just another client of its own
        // route, not a trusted bypass.
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.CATALOG_API_SECRET}`,
        },
        // firedAt is passed explicitly so the timestamp stored on the
        // subscription below and the one the agent actually sees are the
        // same value, not two independent `new Date()` calls a few ms apart.
        // subscriptionId + reason let the route resolve guidance itself
        // (resolveGuidanceForWakeRequest) from catalog.json — deliverWake
        // never sends the resolved guidance text over the wire, and
        // `guidance` is the one field the agent trusts as instructions rather
        // than data.
        body: JSON.stringify({
          conversationId: sub.conversationId,
          payload,
          subscribedAt: sub.armedAt,
          firedAt,
          subscriptionId: sub.id,
          reason,
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text();
        const message = `wake POST ${res.status}: ${bodyText}`;
        // Only these two route responses are DEFINITIVELY PERMANENT (see
        // agent/channels/catalog.ts: 400 = guidance-rejected, a caller bug
        // that will never succeed on retry; 404 = unknown-conversation, the
        // conversation record is genuinely gone). Every other status —
        // 401/403 (a misconfigured secret), 5xx, or anything else — is
        // retryable infra noise, not evidence this wake can never be sent.
        if (res.status === 400 || res.status === 404) throw new PermanentWakeError(message);
        throw new Error(message);
      }
      const body = (await res.json()) as {
        alreadyDelivered?: boolean;
        alreadyInFlight?: boolean;
        firedAt?: string;
      };
      if (body.alreadyInFlight) {
        // Route-level claim collision: another process's attempt is
        // actively sending right now (a crash-recovery race narrower than
        // the lease alone catches — see the marker's own doc comment). This
        // attempt did no useful work; leave the subscription "delivering"
        // for the next sweep round rather than guessing at an outcome.
        return "skipped";
      }
      if (body.alreadyDelivered && body.firedAt) firedAt = body.firedAt;
    }

    const finalStatus = reason === "expired" ? "expired" : "fired";
    const updated = await updateSubscription(sub.id, {
      status: finalStatus,
      firedAt,
      deliverReason: null,
      deliverSnapshot: null,
    });
    await disarmSafely(updated);
    await logAndRecord("deliver", updated, { reason });
    return "completed";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (err instanceof PermanentWakeError) {
      // The terminal "failed" write itself is not exempt from infra flakes —
      // if IT throws, that's not proof the permanent classification was
      // wrong, just that this attempt couldn't record it. Fall through to
      // the retryable path below instead of letting it escape uncaught: the
      // subscription stays "delivering", and the next sweep round re-runs
      // this same wake POST, which will hit the same 400/404 and get
      // another chance to write "failed" — see the module's PermanentWakeError comment.
      try {
        const updated = await updateSubscription(sub.id, {
          status: "failed",
          lastError: message,
          deliverReason: null,
          deliverSnapshot: null,
        });
        // Without this, a failed delivery leaves the subscription live in the
        // provider's own bookkeeping forever — it never got the disarm() call
        // above, since that's on the success path only. For a poll-coalescing
        // provider (edgar) that means the CIK's watch never sees its
        // subscriber count drop to zero and keeps polling; for a push
        // provider (alpaca) it means a dead stream subscription lingers.
        // disarmSafely already swallows/logs its own errors, matching the
        // success-path call above.
        await disarmSafely(updated);
        await logAndRecord("deliver-failed", updated, { error: message });
        return "failed";
      } catch (writeErr) {
        const writeMessage = writeErr instanceof Error ? writeErr.message : String(writeErr);
        logCatalog("deliver-retryable-error", sub, {
          error: `permanent-failure terminal write itself failed: ${writeMessage} (original: ${message})`,
        });
        return "deferred";
      }
    }

    // Everything else is retryable: a transient tryTransitionToDelivering()/
    // getSubscription()/acquireDeliveryLease() failure BEFORE delivering was
    // ever established, a transient getWakeDeliveryMarker() failure, a
    // network error, a non-permanent HTTP status, a response-parse failure,
    // or even the terminal-status updateSubscription() call a few lines up
    // itself failing. One honest caveat for the earliest of these: if
    // tryTransitionToDelivering() itself never completed, the subscription
    // is still "armed", not "delivering" — sweepStrandedDeliveries only
    // scans "delivering", so THIS specific tick's failure isn't picked up by
    // the sweep; it's recovered only if some later trigger (another provider
    // tick, or expiry) re-arms/re-fires the same subscription. A sustained
    // Redis outage spanning that window is a real gap — Phase 2's
    // gap-replay-on-reconnect is the intended fix, not more retries here
    // (AGENTS.md rule 1: no defensive engineering beyond what the POC needs).
    //
    // Otherwise, leave the subscription's status exactly as it is (still "delivering",
    // deliverReason/deliverSnapshot intact) — the next sweep round will
    // find it and retry. That retry is SAFE, not a guaranteed duplicate:
    // the wake-delivery marker (already "sent" if send() itself actually
    // succeeded before some LATER step here failed) makes deliverWake skip
    // re-POSTing and just retry the terminal-status write. The delivery
    // lease is released in `finally` regardless, so nothing here is left
    // stuck holding it.
    logCatalog("deliver-retryable-error", sub, { error: message });
    return "deferred";
  } finally {
    // A pre-lease-acquisition exit (an early "skipped"/"deferred" return
    // above before ownerToken is ever assigned) holds no lease to release.
    // And even once acquired, the release call itself can fail — that must
    // not throw OUT of `finally` and override whatever the try/catch above
    // already decided to return; the lease's own TTL self-heals regardless.
    if (ownerToken) {
      try {
        await releaseDeliveryLease(sub.id, ownerToken);
      } catch (releaseErr) {
        const releaseMessage = releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
        logCatalog("deliver-retryable-error", sub, {
          error: `releaseDeliveryLease failed: ${releaseMessage} (lease self-heals via its own TTL)`,
        });
      }
    }
  }
}

/**
 * Recovery sweep for correctness prerequisite 4: finds subscriptions stuck
 * in "delivering" whose lease has expired (a process crashed between
 * establishing that transition and finishing the wake POST) and resumes
 * them by calling deliverWake again — reading back the reason/snapshot
 * established at the "delivering" transition, since the original caller's
 * local variables died with the process. A "delivering" subscription whose
 * lease is still held is left alone (someone else is actively delivering
 * it, or another sweep already resumed it); a "delivering" subscription
 * with no persisted deliverReason has nothing to resume with and is also
 * left alone (should not happen in practice — the atomic transition always
 * sets it in the same write that sets the status).
 *
 * Only credits (logs "recovered", includes in the return value) a
 * subscription deliverWake reports "completed" for. "skipped" (lost a
 * race, did no work) and "deferred" (hit a retryable error and is still
 * "delivering" for a future round — deliverWake already logged its own
 * `deliver-retryable-error` line) are both silently ignored here — a
 * "deferred" outcome is exactly the sweep's own reason to exist, not
 * something to additionally flag. "failed" (a DEFINITIVELY PERMANENT
 * error) gets its own console-only `recovery-attempt-failed` line instead:
 * deliverWake's own catch path already wrote a `deliver-failed` history
 * entry, so this isn't a second history write for the same event, just a
 * note that the failure was discovered via the recovery sweep.
 *
 * Each row's whole check/deliver/credit sequence is wrapped in its own
 * try/catch: one poison row (e.g. a subscription deleted by another actor
 * mid-scan, or any other unexpected error) must never starve the rest of
 * the round — logged console-only (`sweep-row-failed`, no history write,
 * since there's no reliably valid subscription state left to attribute a
 * history entry to) and the loop moves on. A failure in listSubscriptions()
 * itself is NOT caught here — that legitimately fails the whole round.
 */
export async function sweepStrandedDeliveries(): Promise<Subscription[]> {
  const all = await listSubscriptions();
  const stranded = all.filter((sub) => sub.status === "delivering");
  const recovered: Subscription[] = [];

  for (const sub of stranded) {
    try {
      if (await isDeliveryLeaseHeld(sub.id)) continue;
      if (!sub.deliverReason) continue;

      const outcome = await deliverWake(sub, { reason: sub.deliverReason, snapshot: sub.deliverSnapshot ?? undefined });
      if (outcome === "completed") {
        await logAndRecord("recovered", sub, { reason: sub.deliverReason });
        recovered.push(sub);
      } else if (outcome === "failed") {
        logCatalog("recovery-attempt-failed", sub, { reason: sub.deliverReason });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logCatalog("sweep-row-failed", sub, { error: message });
    }
  }

  return recovered;
}

/**
 * Runs sweepStrandedDeliveries on a fixed cadence — called once at boot
 * (agent/channels/catalog.ts). `setInterval` is this local host's stand-in
 * for a durable primitive; Phase 3 (docs/plan-vercel-production.md) migrates
 * this to a durable sleep/sweep loop that survives the host process itself
 * restarting between ticks, not just surviving individual deliveries
 * crashing. Rejections are caught here (not left to become unhandled
 * rejections that could crash the process) and logged.
 */
export function startRecoverySweep(intervalMs = 15_000): ReturnType<typeof setInterval> {
  return setInterval(() => {
    sweepStrandedDeliveries().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[catalog] recovery-sweep-failed error=${message}`);
    });
  }, intervalMs);
}

/**
 * True if a failing arm() attempt must NOT overwrite the subscription's
 * status with "failed" — because delivery already raced ahead of it. A
 * provider's arm() can call deliverWake synchronously (e.g. a push event
 * arriving while an earlier REST seed call in the same arm() is still in
 * flight); if that succeeds and arm()'s own remaining work then throws, the
 * subscription has already legitimately reached "delivering"/"fired"/
 * "expired" and armPendingForConversation's catch must leave it alone.
 * Checked against deliverWake's delivery lease (catches the race before the
 * persisted status transition lands) and the persisted status (catches it
 * after). Pure.
 */
export function shouldSkipArmFailure(claimed: boolean, currentStatus: SubscriptionStatus | undefined): boolean {
  if (claimed) return true;
  return currentStatus === "delivering" || currentStatus === "fired" || currentStatus === "expired";
}

/**
 * Arms every "pending" subscription on a conversation: pending -> armed,
 * provider.arm(sub), expiry timer started. Called from the channel's
 * `turn.completed` handler so a subscription never arms mid-turn (the
 * tick-arrives-before-the-session-parks race). A provider.arm failure (e.g.
 * task #4's alpaca provider not registered yet) marks the subscription
 * "failed" with `lastError` rather than losing it silently.
 *
 * Idempotent under duplicate calls: two `turn.completed` events (or any
 * concurrent callers) can both fetch the same "pending" list before either
 * writes a status change — the per-subscription claim below, checked and
 * set synchronously before the first `await`, guarantees `provider.arm` is
 * still only ever called once per subscription id.
 *
 * A `provider.arm` that calls `deliverWake` synchronously (before returning)
 * runs inside this same `turn.completed` handler, which eve fully awaits
 * *before* emitting `session.waiting` (verified in eve's compiled source,
 * harness/emission.js: `emitTurnEpilogue` awaits the turn.completed emit,
 * then emits session.waiting). That means deliverWake's loopback POST can
 * reach /catalog/wake's `send()` before the session has technically parked.
 * Verified experimentally (a provider whose arm() calls deliverWake with
 * zero delay — the most aggressive case possible, since a real provider can
 * only detect a tick after a network round trip) that eve's local dev
 * runtime queues and correctly orders this: the wake lands as the next turn
 * on the same session, no stray session created. See KNOWN_ISSUES.md #7.
 * The session-id-mismatch check in the /catalog/wake route remains as an
 * automatic backstop regardless.
 */
export async function armPendingForConversation(conversationId: string): Promise<Subscription[]> {
  const pending = await listSubscriptionsByStatus(conversationId, "pending");
  const armed: Subscription[] = [];

  for (const sub of pending) {
    if (armClaimed.has(sub.id)) continue;
    armClaimed.add(sub.id);

    try {
      const provider = getProvider(sub.provider);
      const armedSub = await updateSubscription(sub.id, {
        status: "armed",
        armedAt: new Date().toISOString(),
      });
      await provider.arm(armedSub);
      scheduleExpiry(armedSub);
      await logAndRecord("arm", armedSub);
      armed.push(armedSub);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const current = await getSubscription(sub.id);
      if (shouldSkipArmFailure(await isDeliveryLeaseHeld(sub.id), current?.status)) {
        await logAndRecord("arm-failed-but-already-delivered", current ?? sub, { error: message });
        continue;
      }
      const failed = await updateSubscription(sub.id, { status: "failed", lastError: message });
      await logAndRecord("arm-failed", failed, { error: message });
    }
  }

  return armed;
}
