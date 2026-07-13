import { Redis } from "@upstash/redis";

import type { Subscription } from "./types.ts";

// Same Redis instance as registry.ts, for the same reason: survives
// hot-reload/restart, and (per docs/plan-vercel-production.md) is shared
// across every service once this moves off a laptop.
const redis = Redis.fromEnv();

const HISTORY_KEY = "catalog:events";
// Append-only, but the standing campaign (docs/plan-vercel-production.md)
// runs unattended for weeks — trim so the list doesn't grow forever. Far
// larger than anything a single dev/demo session or GET /catalog/events
// reader would need at once.
const HISTORY_MAX_ENTRIES = 2000;

/** One row of the public, read-only event-history feed (GET /catalog/events). No secrets belong here. */
export interface HistoryEntry {
  action: string;
  timestamp: string;
  subscriptionId: string;
  conversationId: string;
  provider: string;
  event: string;
  status: string;
  [key: string]: unknown;
}

/**
 * Appends one entry to the append-only event-history stream: every
 * subscription lifecycle transition and wake delivery (arm, delivering,
 * fired, expired, failed, recovered), written from wake.ts. Backed by a
 * Redis list — LPUSH puts the newest entry at index 0, so listEvents' plain
 * LRANGE already reads newest-first with no extra sort.
 */
export async function recordEvent(
  action: string,
  sub: Pick<Subscription, "id" | "conversationId" | "provider" | "event" | "status">,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const entry: HistoryEntry = {
    // extra spreads FIRST so a key it happens to share with a canonical
    // field below (e.g. an attacker- or bug-supplied subscriptionId/status)
    // is always overwritten by the real value, never the reverse — same
    // shadowing discipline as buildWakeEnvelope's nested payload (wake.ts).
    ...extra,
    action,
    timestamp: new Date().toISOString(),
    subscriptionId: sub.id,
    conversationId: sub.conversationId,
    provider: sub.provider,
    event: sub.event,
    status: sub.status,
  };
  await redis.lpush(HISTORY_KEY, entry);
  await redis.ltrim(HISTORY_KEY, 0, HISTORY_MAX_ENTRIES - 1);
}

/** Newest-first history feed for GET /catalog/events. Public and unauthenticated — never put secrets in an entry. */
export async function listEvents(): Promise<HistoryEntry[]> {
  return redis.lrange<HistoryEntry>(HISTORY_KEY, 0, -1);
}
