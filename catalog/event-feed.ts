import { createHash } from "node:crypto";

import type { HistoryEntry } from "./history.ts";

/** Wire shape of GET /catalog/event-feed and its observatory proxy (GET /api/event-feed). */
export interface EventFeedResponse {
  cursor: string | null;
  reset: boolean;
  events: HistoryEntry[];
}

// How many rows a snapshot/delta response carries at most — same cap as the
// legacy GET /catalog/events (history.ts).
export const EVENT_FEED_PAGE_SIZE = 100;

/**
 * Opaque content-hash cursor for one history row. Stable across reads of the
 * same underlying stored entry (both LINDEX and LRANGE deserialize the exact
 * same stored JSON string, preserving key order) — chosen over a list index
 * (shifts on every LPUSH) or a separately-maintained version key (would need
 * every writer, including old deployed workflow executions, to bump it
 * atomically with the list write). See /tmp/codex-eventdriven-final.txt.
 */
export function computeCursor(row: HistoryEntry): string {
  return createHash("sha256").update(JSON.stringify(row)).digest("hex");
}

/**
 * Pure delta computation over the caller's already-fetched, newest-first
 * rows and its previous cursor. No Redis here — fetchEventFeed (history.ts)
 * is the thin I/O wrapper: it LINDEXes the head as a one-command fast path
 * when unchanged, and otherwise LRANGEs 0..EVENT_FEED_PAGE_SIZE (the newest
 * EVENT_FEED_PAGE_SIZE + 1 rows) and hands the result here.
 *
 * The response cursor is always derived from `rows[0]` — never from any
 * earlier read the caller may have done (e.g. a stale LINDEX) — so a
 * concurrent LPUSH landing between two Redis reads is never lost: either
 * it's already in `rows` (delivered now) or it lands after this call
 * returns (delivered on the next poll).
 */
export function computeFeedResponse(rows: HistoryEntry[], after: string | null): EventFeedResponse {
  if (rows.length === 0) return { cursor: null, reset: true, events: [] };

  const cursor = computeCursor(rows[0]);

  if (after === null) {
    return { cursor, reset: true, events: rows.slice(0, EVENT_FEED_PAGE_SIZE) };
  }

  const anchorIndex = rows.findIndex((r) => computeCursor(r) === after);
  if (anchorIndex === -1) {
    // The cursor isn't anywhere in the newest EVENT_FEED_PAGE_SIZE + 1 rows —
    // either trimmed off the list, or more than a page of events arrived
    // since the last poll. No index cursor, no silent gap: say so explicitly.
    return { cursor, reset: true, events: rows.slice(0, EVENT_FEED_PAGE_SIZE) };
  }

  return { cursor, reset: false, events: rows.slice(0, anchorIndex) };
}
