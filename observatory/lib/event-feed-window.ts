import type { EventFeedResponse, HistoryEntry } from "./catalog-types.ts";

// Matches the server's own page size (catalog/event-feed.ts's
// EVENT_FEED_PAGE_SIZE) — no reason for the client's rolling window to hold
// more than one server page could ever deliver in a single reset.
export const EVENT_FEED_WINDOW_SIZE = 100;

/**
 * Merges one GET /catalog/event-feed (via its /api/event-feed proxy)
 * response into the client's local rolling window. Pure: no fetching, just
 * the same reset/delta branch useEventFeed (use-event-feed.ts) needs on
 * every poll tick.
 *
 * A reset response (initial load, or the server saying the previous cursor
 * fell out of its window) replaces the window outright. A delta prepends
 * its rows — already newest-first — onto the front of what's there. Either
 * way the result is capped at EVENT_FEED_WINDOW_SIZE.
 */
export function mergeEventFeedWindow(prev: readonly HistoryEntry[], feed: EventFeedResponse): HistoryEntry[] {
  const merged = feed.reset ? feed.events : [...feed.events, ...prev];
  return merged.slice(0, EVENT_FEED_WINDOW_SIZE);
}
