import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPositions, submitOrder, type AlpacaPosition } from "#catalog/providers/alpaca-client.ts";

/**
 * Position-bounded selling: no shorting, no margin. `positions` is passed in
 * as data (not fetched here) so this bounds check is testable without a live
 * Alpaca call — see tests/agent-tools/submit_sell_order.test.ts. No float
 * tolerance: `qty` is the agent's own requested number compared directly
 * against `Number(position.qty)`, not the result of any lossy accumulation,
 * so a tolerance would only ever widen the no-margin bound (a Codex gate
 * finding — an earlier version had a 1e-9 epsilon "for the exact-held-qty
 * case," which that case never actually needed).
 */
export function assertSellWithinPosition(positions: AlpacaPosition[], symbol: string, qty: number): void {
  const position = positions.find((p) => p.symbol === symbol);
  if (!position) {
    throw new Error(`No open position in ${symbol} — nothing to sell (no shorting, no margin).`);
  }
  const held = Number(position.qty);
  if (qty > held) {
    throw new Error(`Requested sell qty ${qty} exceeds held quantity ${held} for ${symbol} — no shorting, no margin.`);
  }
}

/**
 * Alpaca positions are always exact-case symbols (e.g. "NVDA") — normalize
 * the tool's input the same way before comparing against them, so a
 * lowercase or whitespace-padded but otherwise valid symbol (e.g. "nvda ")
 * isn't rejected as "no open position" when one genuinely exists (a Codex
 * gate finding). Pure.
 */
export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

// Sell-side counterpart to submit_order.ts. Position-bounded: no shorting, no
// margin, paper host stays hard-coded (alpaca-client.ts) — this is a
// capability-bounds change, so the bound lives in code
// (assertSellWithinPosition), not in agent instructions. Accepted POC gap (a
// Codex gate finding): the position check and the order submission are two
// separate calls, not one atomic operation, so a concurrent fill racing this
// same call between them isn't serialized — not airtight under concurrency,
// just the bound this project needs for a single-agent, largely-sequential
// campaign. No approval gate, same full-autonomy choice as submit_order.ts
// (Philipp, 2026-07-12).
export default defineTool({
  description:
    "Submit a market sell order on the Alpaca paper trading account for a share quantity you currently " +
    "hold. Position-bounded: no shorting, no margin — the requested qty must not exceed what get_account " +
    "reports you hold for this symbol; call get_account first. State clearly what you're about to sell " +
    "(symbol, quantity) before calling it — it executes immediately, no human sign-off. Market orders " +
    "only; nothing else is supported. After a successful call: subscribe_event to alpaca's order.filled " +
    "with resource set to this order's id (orderId), then end your turn — the outcome arrives as a wake " +
    "carrying that event type's own onWake guidance for how to report it.",
  inputSchema: z.object({
    symbol: z.string().min(1).describe('Ticker symbol to sell, e.g. "NVDA".'),
    qty: z
      .number()
      .positive()
      .describe("Number of shares to sell — must not exceed your current held quantity for this symbol."),
  }),
  async execute({ symbol, qty }) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const positions = await getPositions();
    assertSellWithinPosition(positions, normalizedSymbol, qty);

    const order = await submitOrder({
      symbol: normalizedSymbol,
      side: "sell",
      type: "market",
      time_in_force: "day",
      qty: qty.toString(),
    });
    return { orderId: order.id, status: order.status, symbol: order.symbol, qty };
  },
});
