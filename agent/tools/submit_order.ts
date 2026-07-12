import { defineTool } from "eve/tools";
import { z } from "zod";

import { submitOrder } from "#catalog/providers/alpaca-client.ts";

// Buy-only, market orders only, day time-in-force — anything else is out of
// scope for this POC. No approval gate: a deliberate full-autonomy choice
// (Philipp, 2026-07-12) — safety lives in the capability bounds themselves
// (paper host hard-coded in alpaca-client.ts, notional/buy-side/market/day
// only, no other order shape reachable through this tool), not in a human
// sign-off step.
export default defineTool({
  description:
    "Submit a market buy order on the Alpaca paper trading account for a fixed dollar notional. " +
    "State clearly what you're about to buy (symbol, dollar amount) before calling it — it executes " +
    "immediately, no human sign-off. Buy-only, market orders only; nothing else is supported. After a " +
    "successful call: subscribe_event to alpaca's order.filled with resource set to this order's id " +
    "(orderId), then end your turn — the outcome arrives as a wake carrying that event type's own " +
    "onWake guidance for how to report it.",
  inputSchema: z.object({
    symbol: z.string().min(1).describe('Ticker symbol to buy, e.g. "NVDA".'),
    notionalUsd: z
      .number()
      .min(1)
      .describe("Dollar amount to spend (minimum $1, Alpaca's notional order floor), e.g. 100 for $100 of the symbol."),
  }),
  async execute({ symbol, notionalUsd }) {
    const order = await submitOrder({
      symbol,
      side: "buy",
      type: "market",
      time_in_force: "day",
      notional: notionalUsd.toFixed(2),
    });
    return { orderId: order.id, status: order.status, symbol: order.symbol, notionalUsd };
  },
});
