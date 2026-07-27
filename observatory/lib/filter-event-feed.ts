import { isTestFixtureConversationId } from "./is-test-fixture-conversation.ts";
import type { EventFeedResponse } from "./catalog-types.ts";

/**
 * Pure filter+envelope step behind GET /api/event-feed (app/api/event-feed/
 * route.ts): drops test-fixture rows the same way /api/events already does,
 * but `cursor` and `reset` pass through UNCHANGED regardless of how much
 * (or how little) of `events` survives the filter. That's the whole point —
 * the cursor is what lets the browser stop re-requesting rows it's already
 * seen; if a filtered-to-empty response also reset the cursor, the client
 * would advance nothing and re-fetch the same filtered rows forever instead
 * of moving past them.
 */
export function filterEventFeed(feed: EventFeedResponse): EventFeedResponse {
  return {
    cursor: feed.cursor,
    reset: feed.reset,
    events: feed.events.filter((event) => !isTestFixtureConversationId(event.conversationId)),
  };
}
