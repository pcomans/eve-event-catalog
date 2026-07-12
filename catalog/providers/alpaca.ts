// See alpaca-client.ts's import comment: streaming types live under the
// `streaming` namespace export, not the root barrel.
import { streaming } from "@alpacahq/alpaca-trade-api";

const { STATE } = streaming;
type StockDataStream = streaming.StockDataStream;
type StreamTrade = streaming.StreamTrade;
type TradeUpdate = streaming.TradeUpdate;
type TradingStream = streaming.TradingStream;

import type { Subscription } from "../types.ts";
import { registerProvider, type Provider } from "../catalog.ts";
import { deliverWake } from "../wake.ts";
import { logCatalog } from "../log.ts";
import { crosses, type CrossingDirection } from "./crossing.ts";
import { alpacaClient, getLatestTrade, getOrder, normalizeOrder, recordTestFeedTrade, type AlpacaOrder, type DataFeed } from "./alpaca-client.ts";

// ALPACA_DATA_FEED=test switches the shared market-data stream (and,
// implicitly, seeding behavior below) to Alpaca's 24/7 synthetic FAKEPACA
// feed for off-hours development; unset or "iex" uses the real feed. Read
// once at module load — changing it requires a process restart anyway
// (KNOWN_ISSUES.md #2), same as every other env var here.
const FEED = (process.env.ALPACA_DATA_FEED ?? "iex") as DataFeed;
const TEST_STREAM_URL = "wss://stream.data.alpaca.markets/v2/test";

function log(line: string) {
  console.log(`[alpaca-stream] ${line}`);
}

interface PriceState {
  sub: Subscription;
  direction: CrossingDirection;
  threshold: number;
  symbol: string;
  /** null until seeded (REST snapshot on iex, first stream tick on test) — see armPriceCross. */
  previous: number | null;
}

const priceSubs = new Map<string, PriceState>();

// One shared market-data connection for every price subscription — the free
// plan allows exactly one. Lazily connects on the first arm().
let stockStream: StockDataStream | null = null;

function ensureStockStream(): StockDataStream {
  if (stockStream) return stockStream;

  // The test feed has no first-class `feed` value — it's reached by
  // overriding the stream's URL entirely (the SDK's documented mechanism for
  // routing through a different endpoint), so `feed` here is a harmless
  // placeholder once `url` is set.
  const stream = alpacaClient.marketData.stockStream(
    FEED === "test" ? { feed: "iex", url: TEST_STREAM_URL } : { feed: FEED },
  );
  stream.onStateChange((state) => {
    if (state === STATE.CONNECTED) log(`connect feed=${FEED}`);
    if (state === STATE.AUTHENTICATED) log(`authenticated feed=${FEED}`);
  });
  stream.onReconnecting((attempt) => log(`reconnecting feed=${FEED} attempt=${attempt}`));
  stream.onReconnected(() => log(`reconnected feed=${FEED}`));
  stream.onError((err) => log(`error feed=${FEED} ${err}`));
  stream.onTrade(handleTrade);
  stream.connect();
  stockStream = stream;
  return stream;
}

/**
 * Dispatches one incoming trade tick to every price subscription watching
 * that symbol. Registered once, on the shared stream, rather than per
 * subscription — the stream delivers ticks for the connection as a whole,
 * not per watcher.
 */
function handleTrade(trade: StreamTrade): void {
  if (FEED === "test") recordTestFeedTrade({ price: trade.price, timestamp: trade.timestamp.toISOString() });

  for (const state of priceSubs.values()) {
    if (state.symbol !== trade.symbol) continue;

    if (state.previous === null) {
      // Test-feed fallback: REST trades/latest has no history for FAKEPACA
      // (verified against the live API), so the first tick after arming
      // seeds `previous` instead of being checked for a crossing.
      state.previous = trade.price;
      logCatalog("seeded", state.sub, { symbol: trade.symbol, price: trade.price, source: "first-tick" });
      continue;
    }

    if (crosses(state.direction, state.previous, trade.price, state.threshold)) {
      void deliverWake(state.sub, {
        reason: "fired",
        snapshot: {
          symbol: trade.symbol,
          price: trade.price,
          threshold: state.threshold,
          previousPrice: state.previous,
          tradeAt: trade.timestamp.toISOString(),
        },
      });
    }
    state.previous = trade.price;
  }
}

async function armPriceCross(sub: Subscription): Promise<void> {
  const direction: CrossingDirection = sub.event === "price.crossesBelow" ? "below" : "above";
  const symbol = sub.resource;
  const { threshold } = sub.params as { threshold: number };

  const state: PriceState = { sub, direction, threshold, symbol, previous: null };
  priceSubs.set(sub.id, state);

  const stream = ensureStockStream();
  await stream.whenAuthenticated();
  stream.subscribeForTrades([symbol]);
  log(`subscribed feed=${FEED} trades=["${symbol}"]`);

  if (FEED === "iex") {
    const trade = await getLatestTrade(symbol, FEED);
    state.previous = trade.price;
    logCatalog("seeded", sub, { symbol, price: trade.price, source: "rest" });
  }
  // On the "test" feed, `state.previous` stays null here and is seeded from
  // the first stream tick instead (see handleTrade above).
}

function disarmPriceCross(sub: Subscription): void {
  const state = priceSubs.get(sub.id);
  if (!state) return;
  priceSubs.delete(sub.id);

  const stillWatched = [...priceSubs.values()].some((other) => other.symbol === state.symbol);
  if (!stillWatched && stockStream) stockStream.unsubscribeFromTrades([state.symbol]);
}

function orderSnapshot(order: AlpacaOrder): Record<string, unknown> {
  return {
    orderId: order.id,
    symbol: order.symbol,
    side: order.side,
    status: order.status,
    filledQty: order.filled_qty,
    filledAvgPrice: order.filled_avg_price,
  };
}

const TERMINAL_ORDER_STATUSES = new Set(["filled", "canceled", "rejected", "expired"]);
// trade_updates event names, not order statuses — "fill" (not "filled") is
// the completed-order event; "partial_fill" and everything else (new,
// pending_new, replaced, done_for_day, stopped, calculated, suspended, ...)
// isn't terminal for our purposes and is ignored.
const TERMINAL_TRADE_EVENTS = new Set(["fill", "canceled", "rejected", "expired"]);

const orderFilledSubs = new Map<string, Subscription>(); // orderId -> sub

// One shared trading-updates connection for every order.filled subscription
// — opened when the first one arms, closed when the last one disarms.
let tradingStream: TradingStream | null = null;

function ensureTradingStream(): TradingStream {
  if (tradingStream) return tradingStream;

  const stream = alpacaClient.trading.stream();
  stream.onStateChange((state) => {
    if (state === STATE.CONNECTED) log("trade-updates connect");
    if (state === STATE.AUTHENTICATED) log("trade-updates authenticated");
  });
  stream.onReconnecting((attempt) => log(`trade-updates reconnecting attempt=${attempt}`));
  stream.onReconnected(() => log("trade-updates reconnected"));
  stream.onError((err) => log(`trade-updates error ${err}`));
  stream.onConnect(() => {
    stream.subscribeTradeUpdates();
    log("trade-updates subscribed");
  });
  stream.onTradeUpdate(handleTradeUpdate);
  stream.connect();
  tradingStream = stream;
  return stream;
}

function handleTradeUpdate(update: TradeUpdate): void {
  const orderId = update.order.id;
  if (!orderId) return;
  const sub = orderFilledSubs.get(orderId);
  if (!sub) return; // an update for an order we're not watching (or already delivered)
  if (!TERMINAL_TRADE_EVENTS.has(update.event)) return;

  void deliverWake(sub, { reason: "fired", snapshot: orderSnapshot(normalizeOrder(update.order)) });
}

async function armOrderFilled(sub: Subscription): Promise<void> {
  const orderId = sub.resource;

  // REST survives only as the arm-time seed: if the order already reached a
  // terminal state before this subscription armed (e.g. a market order that
  // filled between submit and arm), wake immediately — a push event for a
  // transition that already happened will never arrive on the stream.
  const order = await getOrder(orderId);
  if (TERMINAL_ORDER_STATUSES.has(order.status)) {
    await deliverWake(sub, { reason: "fired", snapshot: orderSnapshot(order) });
    return;
  }

  orderFilledSubs.set(orderId, sub);
  const stream = ensureTradingStream();
  await stream.whenAuthenticated();
}

function disarmOrderFilled(sub: Subscription): void {
  if (!orderFilledSubs.delete(sub.resource)) return;
  if (orderFilledSubs.size === 0 && tradingStream) {
    tradingStream.disconnect();
    tradingStream = null;
  }
}

async function arm(sub: Subscription): Promise<void> {
  switch (sub.event) {
    case "order.filled":
      await armOrderFilled(sub);
      return;
    case "price.crossesBelow":
    case "price.crossesAbove":
      await armPriceCross(sub);
      return;
    default:
      throw new Error(`alpaca provider does not support event: ${sub.event}`);
  }
}

async function disarm(sub: Subscription): Promise<void> {
  switch (sub.event) {
    case "order.filled":
      disarmOrderFilled(sub);
      return;
    case "price.crossesBelow":
    case "price.crossesAbove":
      disarmPriceCross(sub);
      return;
    default:
      throw new Error(`alpaca provider does not support event: ${sub.event}`);
  }
}

export const alpacaProvider: Provider = {
  supportedEvents: ["price.crossesBelow", "price.crossesAbove", "order.filled"],
  arm,
  disarm,
};

registerProvider("alpaca", alpacaProvider);
