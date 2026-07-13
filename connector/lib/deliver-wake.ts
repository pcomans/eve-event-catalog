// Shared wake-delivery seam for every connector leg (price-crossing,
// order-reconciliation, and — Phase 3 — the EDGAR sweep): one function that
// manages the armed->delivering->fired lifecycle and POSTs to eve's
// /catalog/wake, and one fence-checked wrapper around it. Originally
// written inline in alpaca-session.ts; extracted so the EDGAR sweep reuses
// the EXACT same delivery logic rather than a second, drifting copy —
// "one code path, two hosts" applies within the connector itself too, not
// just between the connector and the in-process provider.
import type { Subscription, SubscriptionStatus } from "../../catalog/types.ts";
import { recordEvent } from "../../catalog/history.ts";
import { getSubscription, tryTransitionToDelivering, updateSubscription } from "../../catalog/registry.ts";
import { isFencedWriteAllowed } from "../../catalog/providers/fence-redis.ts";
import { getWakeDeliveryMarker } from "../../catalog/wake.ts";

const TERMINAL_STATUSES = new Set<SubscriptionStatus>(["fired", "expired", "failed"]);

const CATALOG_BASE_URL = process.env.CATALOG_BASE_URL ?? `http://localhost:${process.env.PORT ?? 2000}`;

function log(line: string): void {
  console.log(`[connector] ${line}`);
}

/**
 * Delivers a wake AND manages the subscription's armed->delivering->fired
 * lifecycle the way wake.ts's deliverWake does — without importing
 * deliverWake itself (team-lead directive: the connector calls eve's wake
 * ROUTE over HTTP; deliverWake's own disarmSafely()/cancelExpiry() calls
 * are eve-in-process-provider concepts that don't apply here — the
 * connector's own next membership/desired-set recheck already reflects a
 * "fired" subscription by simply no longer including it, which is this
 * design's equivalent of "disarm").
 *
 * Codex gate finding (the original alpaca-session.ts): a bare POST to
 * /catalog/wake plus a history write does NOT update the subscription's
 * own status — it stayed "armed" forever, meaning it could fire again on
 * a later trigger, and GET /catalog/subscriptions would lie. Fixed by
 * reusing registry.ts's own tryTransitionToDelivering (the SAME atomic CAS
 * wake.ts's deliverWake uses) before attempting delivery, and
 * updateSubscription on success.
 *
 * tryTransitionToDelivering succeeding is what makes it safe for a caller
 * (e.g. alpaca-session.ts's gap-replay, or the EDGAR sweep's per-CIK poll)
 * to advance its own persisted cursor/seen-set past whatever triggered this
 * call — the DECISION is durably recorded here, independent of whether the
 * immediate POST below succeeds. If the POST fails, this subscription is
 * left in "delivering" with deliverReason/deliverSnapshot already set —
 * exactly the state wake.ts's OWN sweepStrandedDeliveries (running in the
 * eve process on its own 15s cadence) scans for and finishes, including the
 * disarmSafely() call this function deliberately does not attempt.
 *
 * Also the source of this leg's overlap safety: two concurrent callers
 * racing the SAME subscription (e.g. two overlapping sweep ticks, or a
 * live push racing a reconnect-time replay) can both decide "this should
 * fire" — but tryTransitionToDelivering's CAS lets only ONE of them ever
 * win the armed->delivering transition; the loser gets `null` and returns
 * immediately below, never reaching the POST. This is what makes every
 * one-shot subscription type (price crossing, order.filled, and EDGAR's
 * filing.new) safe under overlapping/concurrent delivery attempts,
 * independent of whatever dedup mechanism (or lack of one) exists
 * upstream of this call.
 *
 * Throws only if tryTransitionToDelivering itself fails (a genuine Redis
 * error) — every other outcome (already terminal, POST failure,
 * alreadyInFlight) is a normal "nothing more for THIS attempt to do" return.
 *
 * A CAS MISS IS NOT ALWAYS "someone else is handling it, give up" — Codex-
 * adjacent finding, caught while building the Phase 3 recovery-sweep
 * migration: a subscription that's ALREADY "delivering" with its own
 * deliverReason established (a row STRANDED by an earlier attempt that
 * crashed after establishing the transition but before finishing the wake
 * POST — exactly the row a recovery sweep exists to resume) also fails this
 * exact CAS, for the exact same reason a genuinely-already-terminal one
 * does. The original version of this function treated both identically
 * (silently give up) — which meant NO connector-side caller could ever
 * resume a stranded row, only wake.ts's own in-process sweepStrandedDeliveries
 * could (because IT, unlike this function, re-reads on a CAS miss and
 * resumes using whatever reason/snapshot is already established). Fixed to
 * match: a CAS miss re-reads the subscription — genuinely terminal is
 * still a real no-op, but "delivering" with a deliverReason already set is
 * a RESUME using THAT established reason/snapshot (never necessarily the
 * reason this particular caller was invoked with — the durably-recorded
 * intent is the single source of truth, same principle as wake.ts's own
 * deliverWake).
 *
 * LIVENESS, not just safety (team-lead's finding while reviewing the
 * recovery-sweep migration): resuming a stranded row isn't only about not
 * duplicating a send — it must actually COMPLETE the ones that already
 * sent. wake.ts's own deliverWake checks the wake-delivery marker
 * (getWakeDeliveryMarker) BEFORE deciding whether to POST at all: if an
 * earlier attempt already reached "sent" (crashed after send() succeeded
 * but before writing the terminal status), a resume must skip the POST
 * entirely and complete terminal using the marker's OWN recorded firedAt —
 * never re-send, never invent a fresh timestamp the agent's envelope never
 * saw. This function mirrors that exact check (not just the CAS-miss
 * resume above) — without it, a marker-"sent" row would still attempt a
 * real POST here, which happens to be caught by the route's own
 * alreadyDelivered response, but that's the WRONG mechanism to depend on
 * for a resume path whose whole point is minimizing redundant real
 * network calls (this codebase's stop-and-report rule applies here just
 * as much: don't rely on a downstream safety net for something the
 * upstream caller can and should know directly).
 */
async function deliverTerminalWakeFromConnector(
  sub: Subscription,
  reason: "fired" | "expired",
  snapshot: Record<string, unknown> | undefined,
): Promise<void> {
  const transitioned = await tryTransitionToDelivering(sub.id, reason, snapshot ?? null);

  let deliveringSub: Subscription;
  if (transitioned) {
    deliveringSub = transitioned;
  } else {
    const current = await getSubscription(sub.id);
    if (!current) {
      log(`deliver skip sub=${sub.id} reason=${reason} — subscription no longer exists`);
      return;
    }
    if (TERMINAL_STATUSES.has(current.status)) {
      log(`deliver skip sub=${sub.id} reason=${reason} — already terminal (${current.status})`);
      return;
    }
    if (current.status !== "delivering" || !current.deliverReason) {
      log(`deliver skip sub=${sub.id} reason=${reason} — unexpected status=${current.status}, nothing established to resume`);
      return;
    }
    deliveringSub = current;
  }

  const resumeReason = deliveringSub.deliverReason as "fired" | "expired";
  const resumeSnapshot = deliveringSub.deliverSnapshot ?? undefined;

  let firedAt: string;
  const marker = await getWakeDeliveryMarker(sub.id);
  if (marker?.phase === "sent" && marker.firedAt) {
    // Already fully delivered by an earlier attempt that crashed before
    // writing the terminal status — reuse ITS firedAt (the one the agent's
    // envelope actually carried), never a fresh timestamp, and skip the
    // POST entirely. ZERO wake POSTs for this resume, matching wake.ts's
    // own deliverWake exactly.
    //
    // ACCEPTED LIMIT, not engineered further (p3 Codex gate finding 7,
    // AGENTS.md rule 1): this marker check only catches the window where an
    // earlier attempt reached "sent" before its own claim (wake.ts's
    // WAKE_CLAIM_TTL_SECONDS, 300s) expired. If send() succeeds but the
    // crash happens, and the claim's TTL then lapses, BEFORE the route
    // upgrades it to "sent," a later resume sees no usable marker and POSTs
    // again — the SAME Phase-1-accepted duplicate-wake limit wake.ts's own
    // clearWakeClaim documents. In that narrow window the terminal firedAt
    // this function writes can postdate the first envelope the agent
    // actually received, same as any other duplicate under that limit.
    firedAt = marker.firedAt;
  } else {
    firedAt = new Date().toISOString();
    let res: Response;
    try {
      res = await fetch(`${CATALOG_BASE_URL}/catalog/wake`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.CATALOG_API_SECRET}`,
        },
        body: JSON.stringify({
          conversationId: sub.conversationId,
          payload: {
            subscriptionId: sub.id,
            provider: sub.provider,
            event: sub.event,
            resource: sub.resource,
            snapshot: resumeSnapshot,
            firedAt,
            reason: resumeReason,
          },
          subscribedAt: sub.armedAt,
          firedAt,
          subscriptionId: sub.id,
          reason: resumeReason,
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`wake POST threw sub=${sub.id} reason=${resumeReason} error=${message} — leaving "delivering" for the recovery sweep`);
      return;
    }

    if (!res.ok) {
      log(`wake POST failed sub=${sub.id} reason=${resumeReason} status=${res.status} body=${await res.text()} — leaving "delivering" for the recovery sweep`);
      return;
    }

    // Matches wake.ts's own deliverWake handling of the route's response
    // body (agent/channels/catalog.ts) — a 200 can still mean "someone else
    // is actively sending this right now" (a narrower race than the marker
    // check above catches: the marker was still "sending", not "sent", the
    // moment this attempt read it).
    const body = (await res.json()) as { alreadyInFlight?: boolean; alreadyDelivered?: boolean; firedAt?: string };
    if (body.alreadyInFlight) {
      log(`wake already in flight sub=${sub.id} reason=${resumeReason} — leaving "delivering" for whichever attempt owns it`);
      return;
    }
    if (body.alreadyDelivered && body.firedAt) firedAt = body.firedAt;
  }

  const finalStatus = resumeReason === "expired" ? "expired" : "fired";
  // p3 Codex gate finding 5: record from the UPDATED subscription
  // updateSubscription returns, not the caller's own stale `sub` parameter
  // — `sub.status` is whatever it was when the caller last read it (e.g.
  // "armed"), never mutated to reflect this function's own transition, so
  // recording from it produced self-contradictory history rows
  // (action="fired"/"expired" but status="armed"/"delivering").
  const updated = await updateSubscription(sub.id, { status: finalStatus, firedAt, deliverReason: null, deliverSnapshot: null });
  await recordEvent(finalStatus, updated, resumeSnapshot ? { snapshot: resumeSnapshot } : {});
}

export async function deliverWakeFromConnector(sub: Subscription, snapshot: Record<string, unknown>): Promise<void> {
  await deliverTerminalWakeFromConnector(sub, "fired", snapshot);
}

/**
 * The expiry migration's own delivery leg (Phase 3, docs/plan-vercel-production.md):
 * called by the durable expiry sweep (connector/workflows/expiry-sweep.ts)
 * for a subscription whose expiresAt has passed without ever crossing/
 * firing. No snapshot — an expired wake has nothing provider-supplied to
 * report (matches wake.ts's own `expire()`, which calls `deliverWake(sub,
 * { reason: "expired" })` with no snapshot either). Shares
 * deliverTerminalWakeFromConnector with the "fired" path above — same
 * tryTransitionToDelivering CAS, same route, same terminal-write shape —
 * so this is what makes a LOCAL expiry timer (wake.ts's scheduleExpiry) and
 * this DURABLE sweep racing the SAME subscription safe: whichever calls
 * tryTransitionToDelivering(sub.id, "expired", ...) first wins; the other
 * gets `null` back and returns immediately, never reaching the wake POST.
 */
export async function deliverExpiredWakeFromConnector(sub: Subscription): Promise<void> {
  await deliverTerminalWakeFromConnector(sub, "expired", undefined);
}

/**
 * The recovery-sweep migration's own delivery leg (Phase 3): resumes a
 * subscription found stuck in "delivering" — the exact same class of row
 * wake.ts's own sweepStrandedDeliveries scans for in the eve process — by
 * replaying the reason/snapshot it durably persisted at the moment it FIRST
 * transitioned to "delivering" (registry.ts's tryTransitionToDelivering
 * writes these fields atomically alongside the status change, so they
 * survive whatever crashed the original attempt). A subscription found
 * "delivering" with no `deliverReason` at all shouldn't happen in practice
 * (the same atomic write establishes both together) — treated as nothing
 * to resume, matching wake.ts's own sweepStrandedDeliveries's identical
 * defensive skip.
 */
export async function deliverStrandedWakeFromConnector(sub: Subscription): Promise<void> {
  if (!sub.deliverReason) return;
  await deliverTerminalWakeFromConnector(sub, sub.deliverReason, sub.deliverSnapshot ?? undefined);
}

/**
 * Fence-checked delivery: a fast-path skip for a session/tick that's
 * probably already stale, NOT the actual delivery-correctness guarantee —
 * that's tryTransitionToDelivering's own CAS inside deliverWakeFromConnector
 * (Codex gate finding: the fence check alone has a check-then-act race
 * against an HTTP POST, which no Redis script can close; the wake pipeline
 * is safe regardless because of the CAS, independent of fencing).
 */
export async function guardedDeliver(
  streamId: string,
  fenceToken: number,
  sub: Subscription,
  snapshot: Record<string, unknown>,
): Promise<void> {
  const allowed = await isFencedWriteAllowed(streamId, fenceToken);
  if (!allowed) {
    log(`fenced out streamId=${streamId} token=${fenceToken} sub=${sub.id} — a newer session holds this stream, skipping delivery attempt`);
    return;
  }
  await deliverWakeFromConnector(sub, snapshot);
}
