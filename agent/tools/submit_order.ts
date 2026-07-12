import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { submitOrder } from "#catalog/providers/alpaca-client.ts";

// Buy-only, market orders only, day time-in-force — anything else is out of
// scope for this POC. Gated on always() approval: a real-money-adjacent side
// effect (even against the paper account) must never fire without a human
// decision, and this also makes the non-idempotent order submission safe
// across a replayed step (see node_modules/eve/docs/tools/human-in-the-loop).
export default defineTool({
  description:
    "Submit a market buy order on the Alpaca paper trading account for a fixed dollar notional. " +
    "Requires human approval before it runs — state clearly what you're about to buy (symbol, dollar " +
    "amount) before calling it; if declined, tell the user you did not trade and why. Buy-only, market " +
    "orders only; nothing else is supported. After a successful call: subscribe_event to alpaca's " +
    "order.filled with resource set to this order's id (orderId), then end your turn — the outcome " +
    "arrives as a wake carrying that event type's own onWake guidance for how to report it.",
  inputSchema: z.object({
    symbol: z.string().min(1).describe('Ticker symbol to buy, e.g. "NVDA".'),
    notionalUsd: z
      .number()
      .min(1)
      .describe("Dollar amount to spend (minimum $1, Alpaca's notional order floor), e.g. 100 for $100 of the symbol."),
  }),
  approval: always(),
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
