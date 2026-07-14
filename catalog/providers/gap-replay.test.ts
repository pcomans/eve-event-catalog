import assert from "node:assert/strict";
import { test } from "node:test";

import {
  advanceCursor,
  cursorFromTrade,
  filterTradesAfterCursor,
  isCursorEqual,
  isCursorNewerThan,
  mergeGapTrades,
  padTimestampToNanoseconds,
  partitionByCursorReadiness,
  performGapReplay,
  replayThroughCrossingPredicate,
  shouldPersistCursorNow,
  type ReplayCursor,
  type ReplayTrade,
} from "./gap-replay.ts";

function trade(id: number, price: number, timestamp = `2026-07-13T10:00:0${id}Z`, exchange = "V"): ReplayTrade {
  return { id, exchange, timestamp, price };
}

// Correctness prerequisite 1's own canonical failure case (docs/plan-vercel-production.md):
// threshold 150, crossesBelow, prev 151, gap contains 149 -> 151 (crossed AND
// recovered). A naive "re-seed from the latest price" approach would see
// prev=151, latest=151, conclude "never crossed" — WRONG. The wake MUST fire.
test("replayThroughCrossingPredicate: a crossing that happens AND recovers entirely within the gap still fires", () => {
  const trades = [trade(1, 149), trade(2, 151)];
  const result = replayThroughCrossingPredicate("below", 150, 151, trades);

  assert.equal(result.fired, true, "the dip to 149 must be caught even though the gap ends back above the threshold");
  assert.equal(result.firstCrossingTrade?.id, 1);
  assert.equal(result.finalPrevious, 151, "the running previous still ends at the last trade's price");
});

test("replayThroughCrossingPredicate: mirror case — a gap that never actually crosses fires zero times", () => {
  const trades = [trade(1, 152), trade(2, 153)];
  const result = replayThroughCrossingPredicate("below", 150, 151, trades);

  assert.equal(result.fired, false);
  assert.equal(result.firstCrossingTrade, null);
  assert.equal(result.finalPrevious, 153);
});

test("replayThroughCrossingPredicate: only the FIRST crossing in a gap containing multiple is reported (one-shot semantics)", () => {
  // 151 -> 149 (crosses) -> 152 (recovers) -> 148 (crosses again) — a
  // one-shot subscription only cares that it crossed at all, and where the
  // FIRST crossing was; a second crossing later in the same gap isn't a
  // second fire.
  const trades = [trade(1, 149), trade(2, 152), trade(3, 148)];
  const result = replayThroughCrossingPredicate("below", 150, 151, trades);

  assert.equal(result.fired, true);
  assert.equal(result.firstCrossingTrade?.id, 1);
});

test("replayThroughCrossingPredicate: crossesAbove direction works the same way", () => {
  const trades = [trade(1, 176), trade(2, 174)]; // crosses above 175, then recovers below
  const result = replayThroughCrossingPredicate("above", 175, 174, trades);

  assert.equal(result.fired, true);
  assert.equal(result.firstCrossingTrade?.id, 1);
});

test("mergeGapTrades: historical and buffered are merged into chronological order, deduping an overlap by trade id+exchange+timestamp", () => {
  const historical = [trade(1, 150), trade(2, 149), trade(3, 151)];
  const buffered = [trade(3, 151), trade(4, 152)]; // trade 3 overlaps — the live buffer started before the historical fetch finished

  const merged = mergeGapTrades(historical, buffered);

  assert.deepEqual(merged.map((t) => t.id), [1, 2, 3, 4], "trade 3 must appear exactly once");
});

// Codex gate finding (2026-07-13): the live buffer starts collecting BEFORE
// the historical fetch's own "as of now" boundary resolves, so a buffered
// trade can be chronologically EARLIER than some historical trades near
// the boundary — not just a suffix overlap. Plain concatenation (the
// original implementation) would hand replayThroughCrossingPredicate an
// out-of-order sequence in exactly this case.
test("mergeGapTrades: a buffered trade that arrived chronologically BEFORE some historical trades is sorted into its correct position, not left at the end", () => {
  const historical = [trade(1, 150, "2026-07-13T10:00:03Z"), trade(2, 149, "2026-07-13T10:00:04Z")];
  // This buffered trade's timestamp is EARLIER than both historical trades
  // above — it ticked while the stream was already subscribed, before the
  // (slower) historical REST fetch's own snapshot resolved.
  const buffered = [trade(3, 152, "2026-07-13T10:00:01Z")];

  const merged = mergeGapTrades(historical, buffered);

  assert.deepEqual(
    merged.map((t) => t.id),
    [3, 1, 2],
    "the chronologically-earliest trade must come first regardless of which source (historical vs. buffered) produced it",
  );
});

test("mergeGapTrades: same-timestamp trades are ordered by exchange then id, deterministically", () => {
  const sameTimestamp = "2026-07-13T10:00:05Z";
  const historical = [trade(2, 150, sameTimestamp, "Q")];
  const buffered = [trade(1, 151, sameTimestamp, "A")];

  const merged = mergeGapTrades(historical, buffered);

  assert.deepEqual(merged.map((t) => t.exchange), ["A", "Q"], "exchange is the tiebreaker for identical timestamps");
});

test("mergeGapTrades: two trades with the same id but a DIFFERENT exchange are not deduped against each other", () => {
  const historical = [trade(1, 150, "2026-07-13T10:00:01Z", "V")];
  const buffered = [trade(1, 150, "2026-07-13T10:00:01Z", "Q")]; // same id+timestamp, different exchange — a genuinely different trade

  const merged = mergeGapTrades(historical, buffered);

  assert.equal(merged.length, 2);
});

test("mergeGapTrades: empty historical (no gap at all) just returns the buffered trades", () => {
  const buffered = [trade(1, 150), trade(2, 151)];
  assert.deepEqual(mergeGapTrades([], buffered), buffered);
});

test("cursorFromTrade / advanceCursor: advances to the last trade in an ordered sequence", () => {
  const trades = [trade(1, 150), trade(2, 151), trade(3, 152)];
  const next = advanceCursor(null, trades);

  assert.deepEqual(next, cursorFromTrade(trades[2]));
});

test("advanceCursor: an empty trade sequence leaves the current cursor unchanged, not reset to null", () => {
  const current: ReplayCursor = { tradeId: 5, exchange: "V", timestamp: "2026-07-13T09:00:00Z" };
  assert.deepEqual(advanceCursor(current, []), current);
});

test("advanceCursor: no trades and no prior cursor stays null", () => {
  assert.equal(advanceCursor(null, []), null);
});

// Codex gate finding: advanceCursor used to trust the last array element
// unconditionally. It must never let the cursor move BACKWARDS.
test("advanceCursor: never regresses — a candidate at or before the current position is rejected", () => {
  const current: ReplayCursor = { tradeId: 5, exchange: "V", timestamp: "2026-07-13T10:00:05Z" };

  const olderCandidate = [trade(3, 150, "2026-07-13T10:00:03Z")];
  assert.deepEqual(advanceCursor(current, olderCandidate), current, "an older candidate must not regress the cursor");

  const sameCandidate = [{ id: 5, exchange: "V", timestamp: "2026-07-13T10:00:05Z", price: 150 }];
  assert.deepEqual(advanceCursor(current, sameCandidate), current, "the exact same position must not count as an advance");
});

test("advanceCursor: a genuinely later candidate still advances normally", () => {
  const current: ReplayCursor = { tradeId: 5, exchange: "V", timestamp: "2026-07-13T10:00:05Z" };
  const later = [trade(6, 150, "2026-07-13T10:00:06Z")];

  assert.deepEqual(advanceCursor(current, later), cursorFromTrade(later[0]));
});

// p6c gate finding (task #33's cursor-write throttle): the connector's
// fenced cursor write (gap-replay-cursor.ts's writeCursorFenced) needs the
// SAME "is this actually newer?" question advanceCursor already answers,
// but for two bare ReplayCursor values rather than a trade sequence to fold
// through — a same-token write (still fenced-in, still the current session)
// that would regress the persisted cursor must be rejected too, not just a
// different session's stale write. One comparator, two callers.
test("isCursorNewerThan: null current means anything real counts as newer (first-ever persist)", () => {
  const candidate: ReplayCursor = { tradeId: 1, exchange: "V", timestamp: "2026-07-13T10:00:01Z" };
  assert.equal(isCursorNewerThan(candidate, null), true);
});

test("isCursorNewerThan: a genuinely later candidate is newer", () => {
  const current: ReplayCursor = { tradeId: 5, exchange: "V", timestamp: "2026-07-13T10:00:05Z" };
  const candidate: ReplayCursor = { tradeId: 6, exchange: "V", timestamp: "2026-07-13T10:00:06Z" };
  assert.equal(isCursorNewerThan(candidate, current), true);
});

test("isCursorNewerThan: an older candidate is NOT newer — the exact regression this guards against", () => {
  const current: ReplayCursor = { tradeId: 5, exchange: "V", timestamp: "2026-07-13T10:00:05Z" };
  const candidate: ReplayCursor = { tradeId: 3, exchange: "V", timestamp: "2026-07-13T10:00:03Z" };
  assert.equal(isCursorNewerThan(candidate, current), false);
});

test("isCursorNewerThan: the exact same position is NOT newer", () => {
  const current: ReplayCursor = { tradeId: 5, exchange: "V", timestamp: "2026-07-13T10:00:05Z" };
  assert.equal(isCursorNewerThan({ ...current }, current), false);
});

// p6d gate fix (task #33): the equal-cursor case gets its own quiet
// "unchanged" no-op (gap-replay-cursor.ts's writeCursorFenced) instead of
// being lumped into "regressed" — this is the comparator that distinction
// is built on.
test("isCursorEqual: the exact same position is equal", () => {
  const a: ReplayCursor = { tradeId: 5, exchange: "V", timestamp: "2026-07-13T10:00:05Z" };
  assert.equal(isCursorEqual(a, { ...a }), true);
});

test("isCursorEqual: a genuinely different position (any of the three fields) is not equal", () => {
  const a: ReplayCursor = { tradeId: 5, exchange: "V", timestamp: "2026-07-13T10:00:05Z" };
  assert.equal(isCursorEqual(a, { ...a, tradeId: 6 }), false);
  assert.equal(isCursorEqual(a, { ...a, exchange: "Q" }), false);
  assert.equal(isCursorEqual(a, { ...a, timestamp: "2026-07-13T10:00:06Z" }), false);
});

// Codex gate finding: Alpaca's historical-trades REST `start` is INCLUSIVE
// — a fetch scoped from the cursor's own timestamp can return the cursor's
// own trade (or siblings sharing its exact timestamp) again. Replaying
// those against the already-advanced-through lastPrice can manufacture a
// false crossing; filterTradesAfterCursor must exclude them regardless of
// what the REST source's own boundary semantics are.
test("filterTradesAfterCursor: excludes the cursor's own trade and any sibling sharing its exact timestamp", () => {
  const cursor: ReplayCursor = { tradeId: 2, exchange: "V", timestamp: "2026-07-13T10:00:02Z" };
  const trades = [
    trade(1, 149, "2026-07-13T10:00:01Z"), // before the cursor — must be excluded
    trade(2, 151, "2026-07-13T10:00:02Z"), // the cursor's own trade (inclusive REST re-fetch) — must be excluded
    { id: 5, exchange: "A", timestamp: "2026-07-13T10:00:02Z", price: 152 }, // a DIFFERENT trade sharing the cursor's exact timestamp — still excluded, by the total order (exchange "A" < "V")
    trade(3, 153, "2026-07-13T10:00:03Z"), // genuinely new — must remain
  ];

  const filtered = filterTradesAfterCursor(cursor, trades);

  assert.deepEqual(filtered.map((t) => t.id), [3]);
});

test("filterTradesAfterCursor: a null cursor (first-ever connect) excludes nothing", () => {
  const trades = [trade(1, 149), trade(2, 151)];
  assert.deepEqual(filterTradesAfterCursor(null, trades), trades);
});

test("performGapReplay: fetches at the injected seam, merges, replays the predicate, and advances the cursor — the canonical failure case end to end", async () => {
  const cursor: ReplayCursor = { tradeId: 0, exchange: "V", timestamp: "2026-07-13T09:59:59Z" };
  const historicalGapTrades = [trade(1, 149), trade(2, 151)];
  let fetchCalledWith: { symbol: string; cursor: ReplayCursor | null } | undefined;

  const result = await performGapReplay(
    async (symbol, sinceCursor) => {
      fetchCalledWith = { symbol, cursor: sinceCursor };
      return historicalGapTrades;
    },
    "NVDA",
    cursor,
    [], // nothing buffered live yet
    "below",
    150,
    151,
  );

  assert.deepEqual(fetchCalledWith, { symbol: "NVDA", cursor });
  assert.equal(result.fired, true, "the gap-replay engine must catch the dip-and-recover, not just re-seed from 151");
  assert.equal(result.firstCrossingTrade?.id, 1);
  assert.deepEqual(result.nextCursor, cursorFromTrade(historicalGapTrades[1]));
  assert.equal(result.mergedTrades.length, 2);
});

test("performGapReplay: overlap between the historical fetch and an already-buffered live trade is deduped in the final merged sequence", async () => {
  const overlapping = trade(2, 151);
  const historical = [trade(1, 149), overlapping];
  const buffered = [overlapping, trade(3, 152)];

  const result = await performGapReplay(
    async () => historical,
    "NVDA",
    null,
    buffered,
    "below",
    150,
    151,
  );

  assert.deepEqual(
    result.mergedTrades.map((t) => t.id),
    [1, 2, 3],
    "the overlapping trade 2 must appear exactly once",
  );
});

test("padTimestampToNanoseconds: pads a millisecond ISO string to 9 fractional digits", () => {
  assert.equal(padTimestampToNanoseconds("2026-07-13T10:00:00.123Z"), "2026-07-13T10:00:00.123000000Z");
});

test("padTimestampToNanoseconds: a string already at nanosecond width is left unchanged", () => {
  assert.equal(padTimestampToNanoseconds("2026-07-13T10:00:00.123999999Z"), "2026-07-13T10:00:00.123999999Z");
});

// Codex gate finding (p2v review): reproduces the exact bug — a genuinely
// LATER nanosecond-precision trade within the same millisecond used to
// sort BEFORE an unpadded millisecond-precision one under plain
// lexicographic comparison. Once both are normalized to the same width via
// padTimestampToNanoseconds (the real ingestion-boundary fix — see
// alpaca-client.ts/alpaca-session.ts), mergeGapTrades sorts them correctly.
test("mergeGapTrades: a nanosecond-precision trade and a padded millisecond-precision trade in the same millisecond sort correctly by real chronological order", () => {
  const earlierInMs = trade(1, 150, padTimestampToNanoseconds("2026-07-13T10:00:00.123Z")); // the .000000000 tail — genuinely earliest within this millisecond
  const laterInMs: ReplayTrade = { id: 2, exchange: "V", timestamp: "2026-07-13T10:00:00.123999999Z", price: 151 }; // a real timestampRaw value, later within the SAME millisecond

  const merged = mergeGapTrades([earlierInMs], [laterInMs]);

  assert.deepEqual(merged.map((t) => t.id), [1, 2], "the nanosecond-later trade must sort AFTER the millisecond-boundary one, not before it");
});

test("partitionByCursorReadiness: a null cursor (symbol never watched before) routes every watch to fresh seeding", () => {
  const watches = [{ sub: { armedAt: "2026-07-13T10:00:00Z" } }, { sub: { armedAt: "2026-07-13T09:00:00Z" } }];
  const result = partitionByCursorReadiness(watches, null);

  assert.equal(result.readyForCursorReplay.length, 0);
  assert.equal(result.needFreshSeed.length, 2);
});

test("partitionByCursorReadiness: a watch armed at-or-before the cursor is cursor-ready; one armed after it needs a fresh seed", () => {
  const cursorTimestamp = "2026-07-13T10:00:00Z";
  const armedBefore = { sub: { armedAt: "2026-07-13T09:00:00Z" } };
  const armedExactlyAtCursor = { sub: { armedAt: cursorTimestamp } };
  const armedAfter = { sub: { armedAt: "2026-07-13T11:00:00Z" } };

  const result = partitionByCursorReadiness([armedBefore, armedExactlyAtCursor, armedAfter], cursorTimestamp);

  assert.deepEqual(result.readyForCursorReplay, [armedBefore, armedExactlyAtCursor], "at-or-before the cursor must be cursor-ready, including the exact boundary");
  assert.deepEqual(result.needFreshSeed, [armedAfter], "armed strictly after the cursor must never ride a replay that predates it");
});

// Task #33 (Redis command-burn reduction): shouldPersistCursorNow is the
// pure throttle decision connector/lib/alpaca-session.ts's handleLiveTrade
// gates its per-trade cursor write on.
test("shouldPersistCursorNow: never persisted this session (undefined) is always due", () => {
  assert.equal(shouldPersistCursorNow(undefined, 1_000_000, 5000), true);
});

test("shouldPersistCursorNow: strictly inside the throttle window is not due", () => {
  assert.equal(shouldPersistCursorNow(1_000_000, 1_004_999, 5000), false);
});

test("shouldPersistCursorNow: exactly at the throttle boundary is due", () => {
  assert.equal(shouldPersistCursorNow(1_000_000, 1_005_000, 5000), true);
});

test("shouldPersistCursorNow: past the throttle boundary is due", () => {
  assert.equal(shouldPersistCursorNow(1_000_000, 1_009_999, 5000), true);
});
