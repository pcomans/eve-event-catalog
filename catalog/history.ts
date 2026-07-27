import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";

import { computeCursor, computeFeedResponse, EVENT_FEED_PAGE_SIZE, type EventFeedResponse } from "./event-feed.ts";
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
  /**
   * Per-occurrence identifier, minted fresh by recordEvent on every call
   * (crypto.randomUUID()) — NOT the subscriptionId, which many rows share
   * across their lifecycle. Exists purely so computeCursor's content hash
   * (event-feed.ts) is a true per-occurrence cursor: two rows that happen
   * to be identical in every OTHER field (same action/status/timestamp,
   * e.g. two lifecycle events landing in the same millisecond) still get
   * distinct hashes and neither can shadow the other's position when
   * fetchEventFeed anchors on a cursor.
   *
   * The flip side is intentional and accepted, not a gap this field leaves
   * open: a Redis-level retry of the exact same LPUSH (the @upstash/redis
   * client auto-retries transient failures — see KNOWN_ISSUES.md #12) would
   * re-send the literal same entry object, same id included, so the
   * resulting duplicate row hashes identically to the original. Collapsing
   * that into the LINDEX fast path's "unchanged" response is correct
   * behavior: a retried write of the same occurrence is not a new
   * occurrence.
   *
   * Declared limit: rows written before this field existed, and any
   * still-running old workflow execution writing during the deploy window
   * that introduced it, have no id and remain theoretically
   * hash-collidable under the old rules. Accepted — they age out of the
   * 100-row feed window within minutes at any real event rate.
   */
  id: string;
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
 * LRANGE already reads newest-first with no extra sort. `key` defaults to
 * the real HISTORY_KEY; parameterized only so tests can point at a
 * disposable list instead (see history.test.ts) — production call sites
 * never pass it.
 */
export async function recordEvent(
  action: string,
  sub: Pick<Subscription, "id" | "conversationId" | "provider" | "event" | "status">,
  extra: Record<string, unknown> = {},
  key: string = HISTORY_KEY,
): Promise<void> {
  const entry: HistoryEntry = {
    // extra spreads FIRST so a key it happens to share with a canonical
    // field below (e.g. an attacker- or bug-supplied subscriptionId/status)
    // is always overwritten by the real value, never the reverse — same
    // shadowing discipline as buildWakeEnvelope's nested payload (wake.ts).
    ...extra,
    id: randomUUID(),
    action,
    timestamp: new Date().toISOString(),
    subscriptionId: sub.id,
    conversationId: sub.conversationId,
    provider: sub.provider,
    event: sub.event,
    status: sub.status,
  };
  await redis.lpush(key, entry);
  await redis.ltrim(key, 0, HISTORY_MAX_ENTRIES - 1);
}

/**
 * Newest-first history feed for GET /catalog/events. Public and
 * unauthenticated — never put secrets in an entry. Capped at
 * EVENT_FEED_PAGE_SIZE (task: event-feed cursor — an uncapped LRANGE 0..-1
 * here was reading the full up-to-2000-entry list on every ~2s poll from
 * every open observatory tab, ~0.9GB/hour of Redis bandwidth). This is now
 * a "latest 100" recent-activity feed, not an audit log — GET
 * /catalog/event-feed (fetchEventFeed, below) is the cursor-polling
 * replacement that only reads what changed.
 */
export async function listEvents(key: string = HISTORY_KEY): Promise<HistoryEntry[]> {
  return redis.lrange<HistoryEntry>(key, 0, EVENT_FEED_PAGE_SIZE - 1);
}

/**
 * Cursor-polling read for GET /catalog/event-feed: `after` is an opaque
 * content-hash cursor (computeCursor, event-feed.ts) identifying the row the
 * caller last saw. Fast path: LINDEX the head and compare hashes — one
 * cheap Redis read when nothing changed since the last poll (the common
 * case at a 2s poll interval). Otherwise LRANGE the newest
 * EVENT_FEED_PAGE_SIZE + 1 rows and hand them to computeFeedResponse, which
 * derives the response cursor from the freshly-read row 0 (never from this
 * function's own LINDEX) — see that function's comment for why that matters
 * under a concurrent LPUSH. `key` is parameterized for the same
 * test-only reason as recordEvent/listEvents above.
 */
export async function fetchEventFeed(after: string | null, key: string = HISTORY_KEY): Promise<EventFeedResponse> {
  if (after !== null) {
    // lindex's client typing returns Promise<any> (unlike lrange, which
    // does take a type param) — same automatic JSON deserialization either
    // way, so this cast is honest, not a workaround for a real mismatch.
    const head = (await redis.lindex(key, 0)) as HistoryEntry | null;
    if (head && computeCursor(head) === after) {
      return { cursor: after, reset: false, events: [] };
    }
  }
  const rows = await redis.lrange<HistoryEntry>(key, 0, EVENT_FEED_PAGE_SIZE);
  return computeFeedResponse(rows, after);
}
