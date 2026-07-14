import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Redis } from "@upstash/redis";

import { acquireFenceToken } from "./fence-redis.ts";
import { writeCursorFenced } from "./gap-replay-cursor.ts";

// Real Redis (no mocking) — same convention as gap-replay-cursor.test.ts.
// Each test uses its own randomUUID-suffixed symbol so it can never collide
// with a real (live-campaign) symbol's cursor key, and cleans its own key up.
const redis = Redis.fromEnv();
const testSymbol = () => `TEST:${randomUUID()}`;
const testStreamId = () => `test:connector-mode-price:${randomUUID()}`;

// KNOWN_ISSUES.md #2 / alpaca-watcher-host.test.ts's own comment: WATCHER_HOST
// is read once at alpaca-client.ts's own module-load time, so this needs a
// dynamic import AFTER the env var is set (a static import would be hoisted
// above this file's own `process.env.WATCHER_HOST = ...` line and capture the
// wrong value). A cache-busting query string per call gives each test its own
// fresh module instance — needed here because testFeedTrades is a
// module-scoped Map and different tests want it in different states.
async function loadConnectorModeAlpacaClient() {
  process.env.WATCHER_HOST = "connector";
  return import(`./alpaca-client.ts?connector-mode=${randomUUID()}`);
}

// The gap this covers (KNOWN_ISSUES.md-adjacent, task #27): in connector
// mode, arm()/disarm() in alpaca.ts are no-ops (p2v fix 1), so the in-process
// tick handler that calls recordTestFeedTrade NEVER runs — testFeedTrades is
// always empty. getLatestTrade's test-feed branch must fall back to the
// connector's own Redis-persisted per-symbol cursor+price
// (gap-replay-cursor.ts's readCursor, written by connector/lib/alpaca-session.ts's
// p2v fix 10) instead of deterministically failing.
test("getLatestTrade (test feed, connector mode): falls back to the Redis-persisted cursor price when the in-process Map is empty", async (t) => {
  const symbol = testSymbol();
  const streamId = testStreamId();
  t.after(() => Promise.all([redis.del(`catalog:cursor:${symbol}`), redis.del(`catalog:fence:${streamId}`)]));

  const token = await acquireFenceToken(streamId);
  const persisted = { cursor: { tradeId: 7, exchange: "V", timestamp: "2026-07-13T10:00:02Z" }, lastPrice: 187.65 };
  const result = await writeCursorFenced(streamId, token, symbol, persisted);
  assert.equal(result, "written");

  const { getLatestTrade } = await loadConnectorModeAlpacaClient();

  assert.deepEqual(await getLatestTrade(symbol, "test"), {
    price: 187.65,
    timestamp: "2026-07-13T10:00:02Z",
  });
});

test("getLatestTrade (test feed, connector mode): a symbol with neither an in-process tick nor a persisted cursor still fails honestly", async () => {
  const symbol = testSymbol(); // never written to Redis or the in-process Map

  const { getLatestTrade } = await loadConnectorModeAlpacaClient();

  await assert.rejects(() => getLatestTrade(symbol, "test"), /no test-feed trade observed yet/);
});

// The in-process Map still wins when it DOES have a tick (e.g. a brief window
// before a redeploy flips WATCHER_HOST, or a future dual-write) — Redis is a
// fallback for the empty case, not a replacement for the fresher in-process
// value.
test("getLatestTrade (test feed, connector mode): an in-process tick still takes priority over a stale persisted cursor", async (t) => {
  const symbol = testSymbol();
  const streamId = testStreamId();
  t.after(() => Promise.all([redis.del(`catalog:cursor:${symbol}`), redis.del(`catalog:fence:${streamId}`)]));

  const token = await acquireFenceToken(streamId);
  const result = await writeCursorFenced(streamId, token, symbol, {
    cursor: { tradeId: 1, exchange: "V", timestamp: "2026-07-13T09:00:00Z" },
    lastPrice: 1,
  });
  assert.equal(result, "written");

  const { getLatestTrade, recordTestFeedTrade } = await loadConnectorModeAlpacaClient();
  recordTestFeedTrade(symbol, { price: 999.99, timestamp: "2026-07-13T10:00:00.000Z" });

  assert.deepEqual(await getLatestTrade(symbol, "test"), {
    price: 999.99,
    timestamp: "2026-07-13T10:00:00.000Z",
  });
});
