import { Redis } from "@upstash/redis";

// Launch blocker fix (production finding, 2026-07-14): clock.time.at wakes
// could NEVER fire on Vercel — catalog/providers/clock.ts's arm() only ever
// scheduled an in-process setTimeout, which arms inside an ephemeral
// function and dies with it the moment that invocation ends. This module is
// the durable side, WATCHER_HOST=connector's own due-time index — one
// sorted set, score = the subscription's `at` as epoch ms, so the connector
// clock sweep (catalog/providers/clock-sweep.ts) can ask "who's due" with a
// single ZRANGE, same shape as registry.ts's own EXPIRY_INDEX_KEY.
//
// Deliberately NOT folded into registry.ts's own expiry-index dual-write:
// that index is keyed off the GENERIC `expiresAt` field every subscription
// type can have; clock's own due time lives in `time.at`'s
// provider-specific `params.at`, which registry.ts has no business knowing
// about (same reasoning edgar-redis.ts's own seen-set stays a
// provider-specific module rather than living in registry.ts). Populated
// by clock.ts's own arm()/disarm() in connector mode — see that file's own
// WATCHER_HOST split.
const redis = Redis.fromEnv();

const CLOCK_DUE_KEY = "catalog:clock-due";

/** Registers `subscriptionId` as due at `atMs` (epoch ms) — clock.ts's connector-mode arm(). */
export async function addClockDue(subscriptionId: string, atMs: number): Promise<void> {
  await redis.zadd(CLOCK_DUE_KEY, { score: atMs, member: subscriptionId });
}

/** Removes `subscriptionId` from the due-time index — clock.ts's connector-mode disarm() (the agent cancelled it), and the connector clock sweep itself once a row has genuinely moved past "armed". A no-op if the id isn't present. */
export async function removeClockDue(subscriptionId: string): Promise<void> {
  await redis.zrem(CLOCK_DUE_KEY, subscriptionId);
}

/** Every subscription id currently due (`at` <= nowMs) — the connector clock sweep's own read side. Same shape as registry.ts's readDueExpirySubscriptionIds. */
export async function readDueClockSubscriptionIds(nowMs: number): Promise<string[]> {
  return redis.zrange<string[]>(CLOCK_DUE_KEY, "-inf", nowMs, { byScore: true });
}
