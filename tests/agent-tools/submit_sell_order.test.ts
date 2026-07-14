import assert from "node:assert/strict";
import { test } from "node:test";

import submitSellOrder, { assertSellWithinPosition, normalizeSymbol } from "../../agent/tools/submit_sell_order.ts";

// Lives outside agent/tools/ on purpose — see tests/agent-tools/submit_order.test.ts's
// comment for why (eve's discovery scan rejects *.test.ts under agent/tools/).

// Pure capability-bounds logic only: assertSellWithinPosition takes positions
// as data, so these are red-green tests on the bounds themselves, no live
// Alpaca call, no Redis, no subscription/delivery state touched.

function position(symbol: string, qty: string) {
  return {
    symbol,
    side: "long",
    qty,
    avg_entry_price: "100",
    market_value: "1000",
    unrealized_pl: "0",
  };
}

test("assertSellWithinPosition rejects selling a symbol with no open position (no shorting)", () => {
  assert.throws(() => assertSellWithinPosition([], "NVDA", 1), /no open position/i);
});

test("assertSellWithinPosition rejects a sell qty exceeding the held quantity (no margin)", () => {
  assert.throws(() => assertSellWithinPosition([position("NVDA", "5")], "NVDA", 5.5), /exceeds held quantity/i);
});

test("assertSellWithinPosition accepts a sell qty within the held quantity", () => {
  assert.doesNotThrow(() => assertSellWithinPosition([position("NVDA", "5")], "NVDA", 3));
});

test("assertSellWithinPosition accepts selling the exact held quantity", () => {
  assert.doesNotThrow(() => assertSellWithinPosition([position("NVDA", "5")], "NVDA", 5));
});

test("assertSellWithinPosition is symbol-scoped — holding one symbol doesn't authorize selling another", () => {
  assert.throws(() => assertSellWithinPosition([position("NVDA", "100")], "TSM", 1), /no open position/i);
});

// Codex gate finding: an earlier version tolerated a 1e-9 float epsilon
// "for the exact-held-qty case" — which weakened the no-margin bound without
// that case actually needing it. Locks in the fix: no tolerance at all.
test("assertSellWithinPosition rejects even a razor-thin oversell (no epsilon tolerance)", () => {
  assert.throws(() => assertSellWithinPosition([position("NVDA", "5")], "NVDA", 5 + 5e-10), /exceeds held quantity/i);
});

// Codex gate finding: the schema accepts any string for `symbol`, but the
// position lookup compared it exact-case/whitespace against Alpaca's own
// always-uppercase symbols.
test("normalizeSymbol trims whitespace and uppercases", () => {
  assert.equal(normalizeSymbol(" nvda "), "NVDA");
  assert.equal(normalizeSymbol("NVDA"), "NVDA");
  assert.equal(normalizeSymbol("Tsm"), "TSM");
});

// Zod schema behavior only — no live Alpaca call.
const inputSchema = submitSellOrder.inputSchema as unknown as {
  safeParse: (input: unknown) => { success: boolean };
};

test("submit_sell_order rejects a zero quantity", () => {
  const result = inputSchema.safeParse({ symbol: "NVDA", qty: 0 });
  assert.equal(result.success, false);
});

test("submit_sell_order rejects a negative quantity", () => {
  const result = inputSchema.safeParse({ symbol: "NVDA", qty: -1 });
  assert.equal(result.success, false);
});

test("submit_sell_order accepts a positive quantity", () => {
  const result = inputSchema.safeParse({ symbol: "NVDA", qty: 1 });
  assert.equal(result.success, true);
});
