import { test } from "node:test";
import assert from "node:assert/strict";

import { interleaveTimeline, type TimelineMessage } from "./interleave-timeline.ts";
import type { HistoryEntry } from "./catalog-types.ts";
import type { EveMessage } from "eve/client";

function msg(id: string, at: string): TimelineMessage {
  return { at, message: { id, parts: [], role: "assistant" } as EveMessage };
}

function evt(subscriptionId: string, at: string, action = "arm"): HistoryEntry {
  return {
    action,
    timestamp: at,
    subscriptionId,
    conversationId: "campaign-5",
    provider: "alpaca",
    event: "price.crossesBelow",
    status: "armed",
  };
}

test("interleaveTimeline orders messages and events chronologically", () => {
  const messages = [msg("turn_1:assistant", "2026-07-14T00:05:00.000Z")];
  const events = [evt("sub-a", "2026-07-14T00:00:00.000Z"), evt("sub-b", "2026-07-14T00:10:00.000Z")];

  const timeline = interleaveTimeline(messages, events);

  assert.deepEqual(
    timeline.map((item) => (item.kind === "message" ? item.message.id : item.event.subscriptionId)),
    ["sub-a", "turn_1:assistant", "sub-b"],
  );
});

test("interleaveTimeline breaks ties deterministically (message before event at the same instant)", () => {
  const at = "2026-07-14T00:05:00.000Z";
  const messages = [msg("turn_1:assistant", at)];
  const events = [evt("sub-a", at)];

  const timeline = interleaveTimeline(messages, events);

  assert.equal(timeline.length, 2);
  assert.equal(timeline[0].kind, "message");
  assert.equal(timeline[1].kind, "event");
});

test("interleaveTimeline breaks ties among same-kind items deterministically by identity", () => {
  const at = "2026-07-14T00:05:00.000Z";
  const events = [evt("sub-b", at), evt("sub-a", at)];

  const timeline = interleaveTimeline([], events);

  // Same timestamp, same kind: sorted by subscriptionId:action identity, not input order.
  assert.deepEqual(
    timeline.map((item) => (item.kind === "event" ? item.event.subscriptionId : "")),
    ["sub-a", "sub-b"],
  );
});

test("interleaveTimeline handles empty inputs", () => {
  assert.deepEqual(interleaveTimeline([], []), []);
  assert.equal(interleaveTimeline([msg("turn_1:assistant", "2026-07-14T00:00:00.000Z")], []).length, 1);
  assert.equal(interleaveTimeline([], [evt("sub-a", "2026-07-14T00:00:00.000Z")]).length, 1);
});
