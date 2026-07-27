import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { filterEventFeed } from "./filter-event-feed.ts";
import type { EventFeedResponse, HistoryEntry } from "./catalog-types.ts";

function row(conversationId: string): HistoryEntry {
  return {
    id: randomUUID(),
    action: "arm",
    timestamp: "2026-07-14T13:30:00.000Z",
    subscriptionId: `sub:${randomUUID()}`,
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    status: "armed",
  };
}

const REAL_CONVERSATION_ID = "campaign-6";
const testConversationId = () => `test:${randomUUID()}`;

test("filterEventFeed: drops test-fixture rows, keeps real ones", () => {
  const real = row(REAL_CONVERSATION_ID);
  const fixture = row(testConversationId());
  const feed: EventFeedResponse = { cursor: "c1", reset: true, events: [fixture, real] };

  const result = filterEventFeed(feed);

  assert.deepEqual(result.events, [real]);
});

// Gate finding (LOW, observatory/app/api/event-feed/route.ts:10): this is
// THE invariant the whole cursor-polling design depends on — if a
// filtered-to-empty response also reset the cursor/reset flag, the browser
// would advance nothing and re-request the same already-seen (but
// filtered) rows forever instead of moving past them.
test("filterEventFeed: cursor and reset pass through UNCHANGED even when every row is filtered out", () => {
  const allFixtures: EventFeedResponse = {
    cursor: "c2",
    reset: false,
    events: [row(testConversationId()), row(testConversationId())],
  };

  const result = filterEventFeed(allFixtures);

  assert.equal(result.cursor, "c2");
  assert.equal(result.reset, false);
  assert.deepEqual(result.events, []);
});

test("filterEventFeed: cursor and reset pass through unchanged on a reset response too", () => {
  const feed: EventFeedResponse = { cursor: "c3", reset: true, events: [row(testConversationId())] };

  const result = filterEventFeed(feed);

  assert.equal(result.cursor, "c3");
  assert.equal(result.reset, true);
  assert.deepEqual(result.events, []);
});

test("filterEventFeed: an empty upstream events array stays empty, cursor/reset unchanged", () => {
  const feed: EventFeedResponse = { cursor: null, reset: true, events: [] };

  const result = filterEventFeed(feed);

  assert.deepEqual(result, feed);
});
