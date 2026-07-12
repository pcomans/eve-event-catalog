// Thin seam over Alpaca's official SDK (v4 alpha — pre-1.0, pinned
// deliberately; see KNOWN_ISSUES.md for the rationale). catalog/providers/
// alpaca.ts and agent/tools/*.ts both import through this one file rather
// than touching the SDK directly, so every call this codebase makes to
// Alpaca is visible in one place, and the shapes exported below are the
// stable seam: they don't change even if the implementation underneath does
// (this file previously wrapped a hand-written fetch/WebSocket client).
// The public root export only re-exports what's needed for the common case
// (the Alpaca client itself, error classes, chart helpers, ...) — raw
// generated types/mappers like `Order` and `toStockTrade` live under these
// namespaces instead (verified against the package's actual dist/index.d.ts;
// several of these are absent from the README's own top-level import examples).
import { Alpaca, marketDataShapes, trading } from "@alpacahq/alpaca-trade-api";

type SdkOrder = trading.Order;
const { toStockTrade } = marketDataShapes;

export type DataFeed = "iex" | "test";

export const alpacaClient = new Alpaca({
  keyId: process.env.ALPACA_API_KEY_ID,
  secret: process.env.ALPACA_API_SECRET_KEY,
  paper: true,
});

export interface AlpacaAccount {
  id: string;
  status: string;
  currency: string;
  cash: string;
  portfolio_value: string;
  buying_power: string;
}

export async function getAccount(): Promise<AlpacaAccount> {
  const account = await alpacaClient.trading.account.getAccount();
  return {
    id: account.id,
    status: account.status,
    currency: account.currency!,
    cash: account.cash!,
    portfolio_value: account.portfolioValue!,
    buying_power: account.buyingPower!,
  };
}

export interface AlpacaPosition {
  symbol: string;
  side: string;
  qty: string;
  avg_entry_price: string;
  market_value: string;
  unrealized_pl: string;
}

export async function getPositions(): Promise<AlpacaPosition[]> {
  const positions = await alpacaClient.trading.positions.getAllOpenPositions();
  return positions.map((position) => ({
    symbol: position.symbol,
    side: position.side,
    qty: position.qty,
    avg_entry_price: position.avgEntryPrice,
    market_value: position.marketValue,
    unrealized_pl: position.unrealizedPl,
  }));
}

export interface SubmitOrderInput {
  symbol: string;
  side: "buy" | "sell";
  type: "market";
  time_in_force: "day";
  notional: string;
}

export interface AlpacaOrder {
  id: string;
  symbol: string;
  side: string;
  status: string;
  notional: string | null;
  qty: string | null;
  filled_qty: string;
  filled_avg_price: string | null;
  submitted_at: string;
  filled_at: string | null;
}

/**
 * Normalizes the SDK's camelCase `Order` — from a REST response or from a
 * pushed `trade_updates` event, both are the same shape — onto this seam's
 * stable snake_case-ish fields, so callers get one consistent shape
 * regardless of which path produced it.
 */
export function normalizeOrder(order: SdkOrder): AlpacaOrder {
  return {
    id: order.id!,
    symbol: order.symbol!,
    side: order.side!,
    status: order.status!,
    notional: order.notional ?? null,
    qty: order.qty ?? null,
    filled_qty: order.filledQty!,
    filled_avg_price: order.filledAvgPrice ?? null,
    submitted_at: order.submittedAt!.toISOString(),
    filled_at: order.filledAt ? order.filledAt.toISOString() : null,
  };
}

export async function submitOrder(input: SubmitOrderInput): Promise<AlpacaOrder> {
  // input.type/time_in_force describe this seam's (deliberately narrow)
  // input contract for callers, not passed through literally — the ergonomic
  // builder only ever places market orders and defaults timeInForce to "day".
  const order = await alpacaClient.trading.orders.market({
    symbol: input.symbol,
    side: input.side,
    notional: input.notional,
  });
  return normalizeOrder(order);
}

export async function getOrder(orderId: string): Promise<AlpacaOrder> {
  const order = await alpacaClient.trading.orders.getOrderByOrderID({ orderId });
  return normalizeOrder(order);
}

export interface LatestTrade {
  price: number;
  timestamp: string;
}

// Last trade observed per symbol on the "test" feed's shared stream
// (populated by catalog/providers/alpaca.ts's tick handler) — REST
// trades/latest has no data for FAKEPACA at all, verified empirically
// against the live API: feed=test is rejected as "invalid feed" for this
// endpoint, and feed=iex returns "no trade found for FAKEPACA". This lets
// getLatestTrade still answer truthfully under ALPACA_DATA_FEED=test once
// that symbol has ticked at least once. Keyed by symbol (not a single
// last-trade slot) so one symbol's price can never leak into another's.
const testFeedTrades = new Map<string, LatestTrade>();

export function recordTestFeedTrade(symbol: string, trade: LatestTrade): void {
  testFeedTrades.set(symbol, trade);
}

export async function getLatestTrade(symbol: string, feed: DataFeed): Promise<LatestTrade> {
  if (feed === "test") {
    const trade = testFeedTrades.get(symbol);
    if (!trade) {
      throw new Error(
        `no test-feed trade observed yet for ${symbol} — the price stream hasn't ticked since this process started`,
      );
    }
    return trade;
  }

  const resp = await alpacaClient.marketData.stocks.stockLatestTradeSingle({ symbol, feed });
  const trade = toStockTrade(resp.trade, symbol);
  return { price: trade.price, timestamp: trade.timestamp.toISOString() };
}
