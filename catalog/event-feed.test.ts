import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { computeCursor, computeFeedResponse } from "./event-feed.ts";
import type { HistoryEntry } from "./history.ts";

// Pure unit tests — no Redis. computeFeedResponse operates on the caller's
// already-fetched rows (LRANGE 0..100, newest-first) plus the client's
// previous cursor; see history.ts's fetchEventFeed for the thin Redis
// wrapper this backs. Design: /tmp/codex-eventdriven-final.txt.

// Each call mints its own random `id`, same as the real recordEvent — so
// two independently-constructed rows are never accidentally identical, even
// when every other field matches (e.g. two calls with the same
// subscriptionId). `extra` spreads last, so a test that specifically needs
// two rows to collide (or wants explicit control over `id`) can still force
// that — see the "identical except id" tests below.
function row(subscriptionId: string, extra: Record<string, unknown> = {}): HistoryEntry {
  return {
    id: randomUUID(),
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

test("computeCursor: hashing the same row twice is deterministic", () => {
  const r = row("a");
  assert.equal(computeCursor(r), computeCursor(r));
});

test("computeCursor: two different rows hash to different cursors", () => {
  assert.notEqual(computeCursor(row("a")), computeCursor(row("b")));
});

// Gate finding (HIGH, catalog/history.ts:95): before HistoryEntry carried a
// per-occurrence `id`, two DISTINCT rows that happened to match on every
// other field (same action/status/timestamp — plausible for two lifecycle
// events landing in the same millisecond) hashed identically, so
// computeFeedResponse's anchor search could match the wrong occurrence and
// silently drop one of them from a delta. `id` closes that: it's the one
// field that's never equal across two independent recordEvent calls.
test("computeCursor: two rows identical in every field except id hash differently", () => {
  const a = row("x", { id: "occurrence-a" });
  const b = row("x", { id: "occurrence-b" });
  assert.notEqual(computeCursor(a), computeCursor(b));
});

test("computeFeedResponse: two occurrences identical except id both surface correctly in a delta — neither shadows the other", () => {
  // Anchored on a THIRD, older row — distinct from both new occurrences —
  // so this actually exercises the delta path for two structurally
  // identical rows, rather than anchoring on one of the pair itself (which
  // would only prove the other one survives).
  const anchor = row("anchor-sub");
  const newerA = row("x", { id: "occurrence-a" });
  const newerB = row("x", { id: "occurrence-b" }); // structurally identical to newerA except id
  const after = computeCursor(anchor);

  const result = computeFeedResponse([newerB, newerA, anchor], after);

  assert.equal(result.reset, false);
  assert.deepEqual(result.events, [newerB, newerA], "both otherwise-identical occurrences must appear in the delta, newest-first");
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
