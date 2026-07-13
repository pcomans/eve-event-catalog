import assert from "node:assert/strict";
import { test } from "node:test";

import { alpacaClient, getHistoricalTrades, getLatestTrade, getOrderStatuses, recordTestFeedTrade } from "./alpaca-client.ts";

test("getLatestTrade on the test feed returns the specific symbol's last recorded tick, not another symbol's", async () => {
  recordTestFeedTrade("FAKEPACA", { price: 134.56, timestamp: "2026-07-12T10:00:00.000Z" });
  recordTestFeedTrade("OTHERFAKE", { price: 9.99, timestamp: "2026-07-12T10:00:01.000Z" });

  assert.deepEqual(await getLatestTrade("FAKEPACA", "test"), {
    price: 134.56,
    timestamp: "2026-07-12T10:00:00.000Z",
  });
  assert.deepEqual(await getLatestTrade("OTHERFAKE", "test"), {
    price: 9.99,
    timestamp: "2026-07-12T10:00:01.000Z",
  });
});

test("getLatestTrade on the test feed rejects a symbol that has never ticked, even if another symbol has", async () => {
  recordTestFeedTrade("FAKEPACA", { price: 134.56, timestamp: "2026-07-12T10:00:00.000Z" });

  await assert.rejects(() => getLatestTrade("NEVER-TICKED", "test"), /no test-feed trade observed yet/);
});

test("recordTestFeedTrade overwrites only the symbol it's called with", async () => {
  recordTestFeedTrade("FAKEPACA", { price: 100, timestamp: "2026-07-12T10:00:00.000Z" });
  recordTestFeedTrade("OTHERFAKE", { price: 200, timestamp: "2026-07-12T10:00:01.000Z" });
  recordTestFeedTrade("FAKEPACA", { price: 101, timestamp: "2026-07-12T10:00:02.000Z" });

  assert.equal((await getLatestTrade("FAKEPACA", "test")).price, 101);
  assert.equal((await getLatestTrade("OTHERFAKE", "test")).price, 200);
});

// Codex gate finding: getHistoricalTrades/getOrderStatuses had no direct
// tests at all — both call the real Alpaca SDK, which this file doesn't
// mock (no existing convention for it here; the rest of this seam is
// verified live). What IS testable without hitting the network: the
// documented test-feed short-circuit (no REST history exists for FAKEPACA)
// and, via a minimal monkey-patch of the one SDK method involved,
// getOrderStatuses' per-order failure isolation (Promise.allSettled) — the
// exact behavior Codex flagged as unverified. Full REST-semantics coverage
// (inclusive cursor boundaries, SDK pagination/paging tokens, rate limits)
// remains an acknowledged gap; gap-replay.ts's filterTradesAfterCursor
// already defends the inclusive-boundary risk at the pure-logic layer
// regardless of what the live API actually does.
test("getHistoricalTrades: the test feed short-circuits to an empty gap without calling the SDK at all", async () => {
  assert.deepEqual(await getHistoricalTrades("FAKEPACA", null, "test"), []);
});

test("getOrderStatuses: an empty order-id list short-circuits without calling the SDK at all", async () => {
  assert.deepEqual(await getOrderStatuses([]), []);
});

test("getOrderStatuses: a single order lookup failing does not abort the rest of the batch", async (t) => {
  const original = alpacaClient.trading.orders.getOrderByOrderID;
  t.after(() => {
    alpacaClient.trading.orders.getOrderByOrderID = original;
  });

  alpacaClient.trading.orders.getOrderByOrderID = (async ({ orderId }: { orderId: string }) => {
    if (orderId === "order-broken") throw new Error("simulated transient REST failure");
    return { id: orderId, status: "filled", filledQty: "10", filledAvgPrice: "150.00" };
  }) as typeof original;

  const statuses = await getOrderStatuses(["order-ok", "order-broken"]);

  assert.equal(statuses.length, 1, "the broken order's lookup must be skipped, not abort the whole batch");
  assert.equal(statuses[0].orderId, "order-ok");
  assert.equal(statuses[0].status, "filled");
});
