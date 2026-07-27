import assert from "node:assert/strict";
import { test } from "node:test";

import { EVENT_FEED_WINDOW_SIZE, mergeEventFeedWindow } from "./event-feed-window.ts";
import type { EventFeedResponse, HistoryEntry } from "./catalog-types.ts";

function row(subscriptionId: string): HistoryEntry {
  return {
    action: "arm",
    timestamp: "2026-07-14T13:30:00.000Z",
    subscriptionId,
    conversationId: "campaign-6",
    provider: "alpaca",
    event: "price.crossesBelow",
    status: "armed",
  };
}

test("mergeEventFeedWindow: a reset response replaces the window outright", () => {
  const prev = [row("stale")];
  const feed: EventFeedResponse = { cursor: "c1", reset: true, events: [row("a"), row("b")] };

  const result = mergeEventFeedWindow(prev, feed);

  assert.deepEqual(result, feed.events);
});

test("mergeEventFeedWindow: a delta prepends its rows onto the front of what's there", () => {
  const prev = [row("older-1"), row("older-2")];
  const feed: EventFeedResponse = { cursor: "c2", reset: false, events: [row("newest")] };

  const result = mergeEventFeedWindow(prev, feed);

  assert.deepEqual(result, [row("newest"), row("older-1"), row("older-2")]);
});

test("mergeEventFeedWindow: an empty delta (unchanged cursor) leaves the window untouched", () => {
  const prev = [row("a"), row("b")];
  const feed: EventFeedResponse = { cursor: "c3", reset: false, events: [] };

  const result = mergeEventFeedWindow(prev, feed);

  assert.deepEqual(result, prev);
});

test("mergeEventFeedWindow: the merged window is capped at EVENT_FEED_WINDOW_SIZE", () => {
  const prev = Array.from({ length: EVENT_FEED_WINDOW_SIZE }, (_, i) => row(`prev-${i}`));
  const feed: EventFeedResponse = { cursor: "c4", reset: false, events: [row("new-1"), row("new-2")] };

  const result = mergeEventFeedWindow(prev, feed);

  assert.equal(result.length, EVENT_FEED_WINDOW_SIZE);
  assert.equal(result[0].subscriptionId, "new-1");
  assert.equal(result[1].subscriptionId, "new-2");
});
