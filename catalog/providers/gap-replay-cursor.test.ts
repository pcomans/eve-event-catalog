import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Redis } from "@upstash/redis";

import { acquireFenceToken } from "./fence-redis.ts";
import { advanceCursor, filterTradesAfterCursor, mergeGapTrades, replayThroughCrossingPredicate, type ReplayTrade } from "./gap-replay.ts";
import { readCursor, writeCursorFenced } from "./gap-replay-cursor.ts";

// Real Redis (no mocking) — same convention as registry.test.ts. Each test
// uses its own symbol so concurrent runs never share a cursor key.
const redis = Redis.fromEnv();
const testSymbol = () => `TEST:${randomUUID()}`;
const testStreamId = () => `test:fence:${randomUUID()}`;

function trade(id: number, price: number, timestamp: string): ReplayTrade {
  return { id, exchange: "V", timestamp, price };
}

test("readCursor: a symbol that's never been streamed reads as null", async () => {
  assert.equal(await readCursor(testSymbol()), null);
});

// Codex gate finding: the plain, unfenced writeCursor() this test used to
// exercise was removed entirely (an unconditional SET with no fencing or
// atomic comparison — "a delayed session can overwrite a newer persisted
// cursor"). Every real write goes through writeCursorFenced now, so that's
// what this round-trip test exercises too.
test("writeCursorFenced then readCursor round-trips cursor+price through real Redis", async (t) => {
  const symbol = testSymbol();
  const streamId = testStreamId();
  t.after(() => Promise.all([redis.del(`catalog:cursor:${symbol}`), redis.del(`catalog:fence:${streamId}`)]));

  const token = await acquireFenceToken(streamId);
  const value = { cursor: { tradeId: 42, exchange: "V", timestamp: "2026-07-13T10:00:00Z" }, lastPrice: 151 };
  const result = await writeCursorFenced(streamId, token, symbol, value);

  assert.equal(result, "written");
  assert.deepEqual(await readCursor(symbol), value);
});

// Correctness prerequisite 1's own canonical case (docs/plan-vercel-production.md,
// also covered purely in gap-replay.test.ts), now run end-to-end against
// REAL Redis persistence, across a simulated reconnect boundary: threshold
// 150 crossesBelow, prev 151, gap trades 149 -> 151 (crossed AND recovered).
// Historical trades are injected at the stream seam (a fake
// FetchHistoricalTrades-shaped function), never real Alpaca I/O — this test
// is about the Redis cursor round-trip being correct across two "sessions,"
// not about the network call.
test("canonical gap-replay case persists correctly to real Redis and is read back for the NEXT reconnect", async (t) => {
  const symbol = testSymbol();
  const streamId = testStreamId();
  t.after(() => Promise.all([redis.del(`catalog:cursor:${symbol}`), redis.del(`catalog:fence:${streamId}`)]));

  const token = await acquireFenceToken(streamId);

  // "Session 1": first-ever connect for this symbol — no persisted cursor yet.
  const persistedBefore = await readCursor(symbol);
  assert.equal(persistedBefore, null);

  const seedPrice = 151;
  const fakeHistoricalTrades: ReplayTrade[] = [
    trade(1, 149, "2026-07-13T10:00:01Z"),
    trade(2, 151, "2026-07-13T10:00:02Z"),
  ];
  const merged = mergeGapTrades(fakeHistoricalTrades, []);
  const afterCursor = filterTradesAfterCursor(null, merged); // no cursor yet — nothing to filter out
  const replay = replayThroughCrossingPredicate("below", 150, seedPrice, afterCursor);

  assert.equal(replay.fired, true, "the dip to 149 must be caught even though the gap ends back above the threshold");
  assert.equal(replay.firstCrossingTrade?.id, 1);

  const nextCursor = advanceCursor(null, afterCursor);
  assert.ok(nextCursor);
  const result = await writeCursorFenced(streamId, token, symbol, { cursor: nextCursor!, lastPrice: replay.finalPrevious });
  assert.equal(result, "written");

  // "Session 2": a later reconnect reads back exactly what session 1 left —
  // the whole point of persisting to Redis rather than an in-process Map
  // that a redeploy or crash would wipe.
  const persistedAfter = await readCursor(symbol);
  assert.deepEqual(persistedAfter, { cursor: { tradeId: 2, exchange: "V", timestamp: "2026-07-13T10:00:02Z" }, lastPrice: 151 });

  // "Session 2" itself: a re-fetch from the persisted cursor (Alpaca's REST
  // start param is INCLUSIVE — the same trade 2 comes back again) must NOT
  // be replayed a second time.
  const reFetchedHistorical = [trade(2, 151, "2026-07-13T10:00:02Z"), trade(3, 153, "2026-07-13T10:00:03Z")];
  const reMerged = mergeGapTrades(reFetchedHistorical, []);
  const reAfterCursor = filterTradesAfterCursor(persistedAfter!.cursor, reMerged);
  assert.deepEqual(reAfterCursor.map((t) => t.id), [3], "trade 2 (at/before the persisted cursor) must be filtered out, even though the inclusive REST fetch returned it again");
});

test("writeCursorFenced: a zombie session's cursor write is skipped once a newer session holds the stream", async (t) => {
  const symbol = testSymbol();
  const streamId = testStreamId();
  t.after(() => Promise.all([redis.del(`catalog:cursor:${symbol}`), redis.del(`catalog:fence:${streamId}`)]));

  const zombieToken = await acquireFenceToken(streamId);
  await acquireFenceToken(streamId); // a newer session takes over

  const result = await writeCursorFenced(streamId, zombieToken, symbol, {
    cursor: { tradeId: 1, exchange: "V", timestamp: "2026-07-13T10:00:00Z" },
    lastPrice: 999,
  });

  assert.equal(result, "fenced-out", "the zombie's write must be reported as skipped for the fencing reason, not regression");
  assert.equal(await readCursor(symbol), null, "the cursor must be untouched by the zombie's stale write");
});

// p6c gate finding (MED, task #33): the exact sequence Codex reproduced —
// a symbol ticks (T1 persisted), the connector re-seeds from a reconnect
// and persists a NEWER cursor (T2) directly, then a stale write for T1
// arrives under the SAME still-current token (the connector's own
// step-end flush, if it hadn't also been fixed to track the replay path's
// advance — this test proves the LOWER-LEVEL structural guard holds even
// in isolation, regardless of whether the in-memory map stays in sync).
// T2 must survive; the T1 write must be reported as "regressed", not
// silently accepted just because the token still matches.
test("writeCursorFenced: a same-token write that would regress the cursor is rejected — T2 survives a stale T1 replay", async (t) => {
  const symbol = testSymbol();
  const streamId = testStreamId();
  t.after(() => Promise.all([redis.del(`catalog:cursor:${symbol}`), redis.del(`catalog:fence:${streamId}`)]));

  const token = await acquireFenceToken(streamId);
  const t1 = { cursor: { tradeId: 1, exchange: "V", timestamp: "2026-07-13T10:00:01Z" }, lastPrice: 100 };
  const t2 = { cursor: { tradeId: 2, exchange: "V", timestamp: "2026-07-13T10:00:02Z" }, lastPrice: 101 };

  const wroteT1 = await writeCursorFenced(streamId, token, symbol, t1);
  assert.equal(wroteT1, "written");

  const wroteT2 = await writeCursorFenced(streamId, token, symbol, t2);
  assert.equal(wroteT2, "written");

  // The stale flush: same token (still the current session), but an OLDER
  // cursor than what's now persisted.
  const staleReplay = await writeCursorFenced(streamId, token, symbol, t1);
  assert.equal(staleReplay, "regressed", "a same-token write older than the persisted cursor must be rejected");

  assert.deepEqual(await readCursor(symbol), t2, "T2 must survive the stale same-token write");
});

// p6d gate fix (finding 4, cosmetic): the ordinary shape once a replay's
// own direct persist and a later flush of the SAME value line up — this
// must read as a quiet "unchanged" no-op, not the loud "regressed" case
// reserved for a genuinely older candidate.
test("writeCursorFenced: an exactly-equal same-token write is reported as 'unchanged', not 'regressed'", async (t) => {
  const symbol = testSymbol();
  const streamId = testStreamId();
  t.after(() => Promise.all([redis.del(`catalog:cursor:${symbol}`), redis.del(`catalog:fence:${streamId}`)]));

  const token = await acquireFenceToken(streamId);
  const value = { cursor: { tradeId: 1, exchange: "V", timestamp: "2026-07-13T10:00:01Z" }, lastPrice: 100 };

  const first = await writeCursorFenced(streamId, token, symbol, value);
  assert.equal(first, "written");

  const second = await writeCursorFenced(streamId, token, symbol, { ...value });
  assert.equal(second, "unchanged");

  assert.deepEqual(await readCursor(symbol), value, "the persisted value must be unaffected by the redundant equal write");
});
