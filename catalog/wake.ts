import type { Subscription, SubscriptionStatus, WakePayload } from "./types.ts";
import { getSubscription, listSubscriptionsByStatus, updateSubscription } from "./registry.ts";
import { getProvider } from "./catalog.ts";
import { logCatalog } from "./log.ts";

// Single-process claim guards. All callers (expiry timers, provider ticks,
// the turn.completed handler) live in this one Node process — a Set with a
// synchronous check-then-set (no `await` between them) is enough to make
// "claim, then do the async work" atomic, since nothing else can run on the
// event loop between those two lines. Multiple *instances* of this process
// would need a real compare-and-swap (Redis WATCH/MULTI or a Lua script);
// that's out of scope for this laptop-only POC (see docs/prd-draft.md
// appendix — cross-instance dedup is explicitly deferred).
const armClaimed = new Set<string>();
const deliveryClaimed = new Set<string>();

// Wake delivery has exactly one implementation: the POST /catalog/wake route
// in agent/channels/catalog.ts, which owns `send()` and the session-id-match
// check. Internal callers (expiry timers, provider ticks) go through that
// same route over HTTP rather than duplicating its logic — the channel route
// and internal callers share one code path, just as an external synthetic
// wake (AT-2) would.
const CATALOG_BASE_URL = process.env.CATALOG_BASE_URL ?? `http://localhost:${process.env.PORT ?? 2000}`;

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
 * the message, shown to the agent: {subscribedAt, firedAt, payload}. Nested,
 * not spread — a payload containing fields literally named `subscribedAt`
 * or `firedAt` lands at `envelope.payload.subscribedAt`, never able to
 * overwrite the channel-generated top-level ones. Pure — no I/O.
 */
export function buildWakeEnvelope(
  subscribedAt: string,
  firedAt: string,
  payload?: Record<string, unknown>,
): { subscribedAt: string; firedAt: string; payload?: Record<string, unknown> } {
  return { subscribedAt, firedAt, payload };
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
 * armed -> delivering -> fired | expired | failed. Cancels any pending
 * expiry timer first. A subscription is one-shot: the very first caller to
 * reach this function for a given `sub.id` claims it synchronously (before
 * any `await`), so a timer and a provider tick racing on the same "armed"
 * subscription can't both deliver — the loser returns immediately with no
 * side effects (no Redis write, no wake sent).
 */
export async function deliverWake(sub: Subscription, options: DeliverOptions): Promise<void> {
  if (deliveryClaimed.has(sub.id)) return;
  deliveryClaimed.add(sub.id);

  cancelExpiry(sub.id);
  await updateSubscription(sub.id, { status: "delivering" });

  const firedAt = new Date().toISOString();
  const payload = buildWakePayload(sub, options, firedAt);

  try {
    const res = await fetch(`${CATALOG_BASE_URL}/catalog/wake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // firedAt is passed explicitly so the timestamp stored on the
      // subscription below and the one the agent actually sees are the
      // same value, not two independent `new Date()` calls a few ms apart.
      body: JSON.stringify({ conversationId: sub.conversationId, payload, subscribedAt: sub.armedAt, firedAt }),
    });
    if (!res.ok) throw new Error(`wake POST ${res.status}: ${await res.text()}`);

    const finalStatus = options.reason === "expired" ? "expired" : "fired";
    const updated = await updateSubscription(sub.id, { status: finalStatus, firedAt });
    await disarmSafely(updated);
    logCatalog("deliver", updated, { reason: options.reason });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const updated = await updateSubscription(sub.id, { status: "failed", lastError: message });
    // Without this, a failed delivery leaves the subscription live in the
    // provider's own bookkeeping forever — it never got the disarm() call
    // above, since that's on the success path only. For a poll-coalescing
    // provider (edgar) that means the CIK's watch never sees its subscriber
    // count drop to zero and keeps polling; for a push provider (alpaca) it
    // means a dead stream subscription lingers. disarmSafely already
    // swallows/logs its own errors, matching the success-path call above.
    await disarmSafely(updated);
    logCatalog("deliver-failed", updated, { error: message });
  }
}

/**
 * True if a failing arm() attempt must NOT overwrite the subscription's
 * status with "failed" — because delivery already raced ahead of it. A
 * provider's arm() can call deliverWake synchronously (e.g. a push event
 * arriving while an earlier REST seed call in the same arm() is still in
 * flight); if that succeeds and arm()'s own remaining work then throws, the
 * subscription has already legitimately reached "delivering"/"fired"/
 * "expired" and armPendingForConversation's catch must leave it alone.
 * Checked against deliverWake's in-process claim (catches the race before
 * any Redis write lands) and the persisted status (catches it after). Pure.
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
      logCatalog("arm", armedSub);
      armed.push(armedSub);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const current = await getSubscription(sub.id);
      if (shouldSkipArmFailure(deliveryClaimed.has(sub.id), current?.status)) {
        logCatalog("arm-failed-but-already-delivered", current ?? sub, { error: message });
        continue;
      }
      const failed = await updateSubscription(sub.id, { status: "failed", lastError: message });
      logCatalog("arm-failed", failed, { error: message });
    }
  }

  return armed;
}
