import { test } from "node:test";
import assert from "node:assert/strict";

import { computeRealizedPnl, sumUnrealizedPnl, toEquitySeries } from "./portfolio-metrics.ts";

test("toEquitySeries drops the leading run of zero-equity placeholder days", () => {
  const history = {
    timestamp: [1000, 2000, 3000, 4000],
    equity: [0, 0, 99900, 100000],
  };
  const series = toEquitySeries(history);
  assert.deepEqual(
    series.map((p) => p.equity),
    [99900, 100000],
  );
  assert.equal(series[0].at, new Date(3000 * 1000).toISOString());
});

test("toEquitySeries keeps a zero that appears after real data has started", () => {
  const history = {
    timestamp: [1000, 2000, 3000],
    equity: [50000, 0, 60000],
  };
  const series = toEquitySeries(history);
  assert.deepEqual(
    series.map((p) => p.equity),
    [50000, 0, 60000],
  );
});

test("toEquitySeries returns an empty array when every entry is a zero placeholder", () => {
  const history = { timestamp: [1000, 2000], equity: [0, 0] };
  assert.deepEqual(toEquitySeries(history), []);
});

test("toEquitySeries handles empty input", () => {
  assert.deepEqual(toEquitySeries({ timestamp: [], equity: [] }), []);
});

test("toEquitySeries drops a leading run of null placeholders same as zero", () => {
  const history = {
    timestamp: [1000, 2000, 3000, 4000],
    equity: [null, null, 99900, 100000],
  };
  const series = toEquitySeries(history);
  assert.deepEqual(
    series.map((p) => p.equity),
    [99900, 100000],
  );
});

test("toEquitySeries drops an interior null (missing sample) rather than plotting $0", () => {
  const history = {
    timestamp: [1000, 2000, 3000, 4000],
    equity: [50000, null, 60000, 70000],
  };
  const series = toEquitySeries(history);
  assert.deepEqual(
    series.map((p) => p.equity),
    [50000, 60000, 70000],
  );
});

test("toEquitySeries returns an empty array when every entry is null", () => {
  const history = { timestamp: [1000, 2000], equity: [null, null] };
  assert.deepEqual(toEquitySeries(history), []);
});

test("toEquitySeries stays within the shorter array when timestamp is longer (malformed response)", () => {
  const history = { timestamp: [1000, 2000, 3000], equity: [99900, 100000] };
  const series = toEquitySeries(history);
  assert.deepEqual(
    series.map((p) => p.equity),
    [99900, 100000],
  );
});

test("toEquitySeries stays within the shorter array when equity is longer (malformed response)", () => {
  const history = { timestamp: [1000, 2000], equity: [99900, 100000, 100100] };
  const series = toEquitySeries(history);
  assert.deepEqual(
    series.map((p) => p.equity),
    [99900, 100000],
  );
});

test("sumUnrealizedPnl adds every value", () => {
  assert.equal(sumUnrealizedPnl([-32.46, 10, 5]), -17.46);
});

test("sumUnrealizedPnl is 0 for no positions", () => {
  assert.equal(sumUnrealizedPnl([]), 0);
});

test("sumUnrealizedPnl propagates null if any value is unavailable", () => {
  assert.equal(sumUnrealizedPnl([10, null, 5]), null);
});

test("computeRealizedPnl is ~0 when total P&L matches unrealized P&L (no closed trades)", () => {
  const realized = computeRealizedPnl(99967.54, 100000, -32.46);
  assert.ok(Math.abs(realized - 0) < 0.01, `expected ~0, got ${realized}`);
});

test("computeRealizedPnl isolates gains beyond what's still open", () => {
  // equity is $200 above initial equity; open positions only account for $50 of that —
  // the other $150 must have come from a closed trade.
  const realized = computeRealizedPnl(100200, 100000, 50);
  assert.equal(realized, 150);
});

test("computeRealizedPnl handles no open positions", () => {
  assert.equal(computeRealizedPnl(100500, 100000, 0), 500);
});
