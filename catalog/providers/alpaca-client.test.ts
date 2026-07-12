import assert from "node:assert/strict";
import { test } from "node:test";

import { getLatestTrade, recordTestFeedTrade } from "./alpaca-client.ts";

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
