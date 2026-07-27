import assert from "node:assert/strict";
import { test } from "node:test";

import { computeCursor, computeFeedResponse } from "./event-feed.ts";
import type { HistoryEntry } from "./history.ts";

// Pure unit tests — no Redis. computeFeedResponse operates on the caller's
// already-fetched rows (LRANGE 0..100, newest-first) plus the client's
// previous cursor; see history.ts's fetchEventFeed for the thin Redis
// wrapper this backs. Design: /tmp/codex-eventdriven-final.txt.

function row(subscriptionId: string, extra: Record<string, unknown> = {}): HistoryEntry {
  return {
    action: "arm",
    timestamp: "2026-07-14T13:30:00.000Z",
    subscriptionId,
    conversationId: "campaign-6",
    provider: "alpaca",
    event: "price.crossesBelow",
    status: "armed",
    ...extra,
  };
}

test("computeCursor: two structurally identical rows hash to the same cursor", () => {
  assert.equal(computeCursor(row("a")), computeCursor(row("a")));
});

test("computeCursor: two different rows hash to different cursors", () => {
  assert.notEqual(computeCursor(row("a")), computeCursor(row("b")));
});

test("computeFeedResponse: no after (initial snapshot) returns newest 100, reset true, cursor of row 0", () => {
  const rows = Array.from({ length: 105 }, (_, i) => row(`sub-${i}`));
  const result = computeFeedResponse(rows, null);

  assert.equal(result.reset, true);
  assert.equal(result.cursor, computeCursor(rows[0]));
  assert.equal(result.events.length, 100);
  assert.deepEqual(result.events, rows.slice(0, 100));
});

test("computeFeedResponse: empty list returns cursor null, reset true, no events", () => {
  const result = computeFeedResponse([], null);
  assert.deepEqual(result, { cursor: null, reset: true, events: [] });
});

test("computeFeedResponse: unchanged cursor (anchor at index 0) returns zero events, reset false", () => {
  const rows = [row("a"), row("b"), row("c")];
  const after = computeCursor(rows[0]);
  const result = computeFeedResponse(rows, after);

  assert.equal(result.reset, false);
  assert.equal(result.cursor, after);
  assert.deepEqual(result.events, []);
});

test("computeFeedResponse: one appended row returns exactly that row", () => {
  const older = [row("b"), row("c")];
  const after = computeCursor(older[0]);
  const rows = [row("a"), ...older]; // "a" is the one new row, newest-first

  const result = computeFeedResponse(rows, after);

  assert.equal(result.reset, false);
  assert.equal(result.cursor, computeCursor(rows[0]));
  assert.deepEqual(result.events, [rows[0]]);
});

test("computeFeedResponse: several appended rows return exactly those rows, newest-first", () => {
  const older = [row("c"), row("d")];
  const after = computeCursor(older[0]);
  const rows = [row("a"), row("b"), ...older];

  const result = computeFeedResponse(rows, after);

  assert.equal(result.reset, false);
  assert.deepEqual(result.events, [rows[0], rows[1]]);
});

test("computeFeedResponse: anchor found at the far edge of the 101-row window (index 100) returns the 100 newer rows", () => {
  const anchor = row("anchor");
  const rows = [...Array.from({ length: 100 }, (_, i) => row(`sub-${i}`)), anchor];
  const after = computeCursor(anchor);

  const result = computeFeedResponse(rows, after);

  assert.equal(result.reset, false);
  assert.equal(result.events.length, 100);
  assert.deepEqual(result.events, rows.slice(0, 100));
});

test("computeFeedResponse: cursor not found anywhere in the window returns an explicit reset, not a silent gap", () => {
  const rows = Array.from({ length: 101 }, (_, i) => row(`sub-${i}`));
  const result = computeFeedResponse(rows, "a-cursor-that-was-trimmed-away");

  assert.equal(result.reset, true);
  assert.equal(result.cursor, computeCursor(rows[0]));
  assert.equal(result.events.length, 100);
});

test("computeFeedResponse: cursor derives from the FIRST row of the given window, not from any earlier read — append-race guard", () => {
  // Simulates the caller's own append race: an LRANGE taken AFTER a stale
  // LINDEX head-check saw a mismatch. computeFeedResponse only ever sees the
  // LRANGE result, so it has no way to derive the wrong cursor even if a
  // caller passed a stale `after` — the row-0 rule is enforced unconditionally.
  const rows = [row("newest"), row("middle"), row("oldest")];
  const staleAfter = computeCursor(row("something-that-no-longer-heads-the-list"));

  const result = computeFeedResponse(rows, staleAfter);

  assert.equal(result.cursor, computeCursor(rows[0]));
  assert.notEqual(result.cursor, staleAfter);
});
