import type { Subscription, WakePayload } from "./types.ts";
import { getSubscription, listSubscriptionsByStatus, updateSubscription } from "./registry.ts";
import { getProvider } from "./catalog.ts";
import { logCatalog } from "./log.ts";

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

/** armed -> delivering -> fired | expired | failed. Cancels any pending expiry timer first. */
export async function deliverWake(sub: Subscription, options: DeliverOptions): Promise<void> {
  cancelExpiry(sub.id);
  await updateSubscription(sub.id, { status: "delivering" });

  const firedAt = new Date().toISOString();
  const payload = buildWakePayload(sub, options, firedAt);

  try {
    const res = await fetch(`${CATALOG_BASE_URL}/catalog/wake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: sub.conversationId, payload, subscribedAt: sub.armedAt }),
    });
    if (!res.ok) throw new Error(`wake POST ${res.status}: ${await res.text()}`);

    const finalStatus = options.reason === "expired" ? "expired" : "fired";
    const updated = await updateSubscription(sub.id, { status: finalStatus, firedAt });
    logCatalog("deliver", updated, { reason: options.reason });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const updated = await updateSubscription(sub.id, { status: "failed", lastError: message });
    logCatalog("deliver-failed", updated, { error: message });
  }
}

/**
 * Arms every "pending" subscription on a conversation: pending -> armed,
 * provider.arm(sub), expiry timer started. Called from the channel's
 * `turn.completed` handler so a subscription never arms mid-turn (the
 * tick-arrives-before-the-session-parks race). A provider.arm failure (e.g.
 * task #4's alpaca provider not registered yet) marks the subscription
 * "failed" with `lastError` rather than losing it silently.
 */
export async function armPendingForConversation(conversationId: string): Promise<Subscription[]> {
  const pending = await listSubscriptionsByStatus(conversationId, "pending");
  const armed: Subscription[] = [];

  for (const sub of pending) {
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
      const failed = await updateSubscription(sub.id, { status: "failed", lastError: message });
      logCatalog("arm-failed", failed, { error: message });
    }
  }

  return armed;
}
