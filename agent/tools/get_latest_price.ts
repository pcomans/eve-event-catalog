import { defineTool } from "eve/tools";
import { z } from "zod";

import { getLatestTrade, type DataFeed } from "#catalog/providers/alpaca-client.ts";

// Same ALPACA_DATA_FEED convention as catalog/providers/alpaca.ts (test vs.
// iex) — read once at module load; changing it needs a process restart
// anyway (KNOWN_ISSUES.md #2).
const FEED = (process.env.ALPACA_DATA_FEED ?? "iex") as DataFeed;

export default defineTool({
  description:
    "Get the latest traded price for a stock symbol from Alpaca. Always call this to get a fresh " +
    "quote before acting on a price wake — the wake tells you the price crossed a threshold at some " +
    "past instant, not the price right now.",
  inputSchema: z.object({
    symbol: z.string().min(1).describe('Ticker symbol, e.g. "NVDA".'),
  }),
  async execute({ symbol }) {
    const trade = await getLatestTrade(symbol, FEED);
    return { symbol, price: trade.price, asOf: trade.timestamp };
  },
});
