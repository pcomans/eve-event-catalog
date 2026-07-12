import { defineTool } from "eve/tools";
import { z } from "zod";

import { getAccount, getPositions } from "#catalog/providers/alpaca-client.ts";

export default defineTool({
  description:
    "Get the Alpaca paper trading account's cash, buying power, and current positions. Always call " +
    "this before submitting an order, to confirm there's enough buying power for it.",
  inputSchema: z.object({}),
  async execute() {
    const [account, positions] = await Promise.all([getAccount(), getPositions()]);
    return {
      cash: account.cash,
      buyingPower: account.buying_power,
      portfolioValue: account.portfolio_value,
      positions: positions.map((position) => ({
        symbol: position.symbol,
        side: position.side,
        qty: position.qty,
        avgEntryPrice: position.avg_entry_price,
        marketValue: position.market_value,
        unrealizedPl: position.unrealized_pl,
      })),
    };
  },
});
