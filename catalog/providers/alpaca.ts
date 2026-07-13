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
import { alpacaClient, describeAuthFailure, getLatestTrade, getOrder, normalizeOrder, recordTestFeedTrade, type AlpacaOrder, type DataFeed } from "./alpaca-client.ts";

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
  // routing through a different endpoint); `feed` is omitted in that case
  // since `url` takes precedence over it.
  const stream = alpacaClient.marketData.stockStream(
    FEED === "test" ? { url: TEST_STREAM_URL } : { feed: FEED },
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
  if (FEED === "test") recordTestFeedTrade(trade.symbol, { price: trade.price, timestamp: trade.timestamp.toISOString() });

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

  // Any failure past this point must not leave a live subscription (or a
  // symbol still subscribed on the stream) behind for a sub that's about to
  // be marked "failed" — arm failures don't get a disarm() call for free.
  try {
    const stream = ensureStockStream();
    const auth = await stream.whenAuthenticated();
    if (!auth.authenticated) throw new Error(describeAuthFailure("market-data", auth));

    stream.subscribeForTrades([symbol]);
    log(`subscribed feed=${FEED} trades=["${symbol}"]`);

    if (FEED === "iex") {
      const trade = await getLatestTrade(symbol, FEED);
      state.previous = trade.price;
      logCatalog("seeded", sub, { symbol, price: trade.price, source: "rest" });
    }
    // On the "test" feed, `state.previous` stays null here and is seeded
    // from the first stream tick instead (see handleTrade above).
  } catch (err) {
    disarmPriceCross(sub);
    throw err;
  }
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

// describeAuthFailure lives in alpaca-client.ts now (the connector's own
// stream wiring, connector/lib/alpaca-session.ts, needs it too, and
// importing THIS file for one pure helper would pull in registerProvider()
// and every module-level Map below into a process that never uses them) —
// re-exported here (of the binding already imported above) so existing
// imports/tests in this file are unaffected.
export { describeAuthFailure };

const TERMINAL_ORDER_STATUSES = new Set(["filled", "canceled", "rejected", "expired"]);
// trade_updates event names, not order statuses — "fill" (not "filled") is
// the completed-order event; "partial_fill" and everything else (new,
// pending_new, replaced, done_for_day, stopped, calculated, suspended, ...)
// isn't terminal for our purposes and is ignored.
const TERMINAL_TRADE_EVENTS = new Set(["fill", "canceled", "rejected", "expired"]);

// orderId -> (subscriptionId -> sub). Keyed by subscription id, not object
// identity: arm() and disarm() each receive their own freshly-deserialized
// Subscription object (registry.ts's updateSubscription spreads a new
// object per call), so two calls for "the same" subscription are never
// reference-equal. A Set<Subscription> would silently fail to remove
// entries on disarm. Nested by order id (not a flat Map<subId, Subscription>)
// so multiple subscriptions can watch the same order without one
// overwriting another's routing entry.
type OrderFilledRegistry = Map<string, Map<string, Subscription>>;
const orderFilledSubs: OrderFilledRegistry = new Map();

/** Total subscriptions across every watched order — used to decide whether the shared stream can close. Pure. */
export function countOrderFilledSubs(registry: ReadonlyMap<string, ReadonlyMap<string, Subscription>>): number {
  let total = 0;
  for (const subs of registry.values()) total += subs.size;
  return total;
}

/** Which subscriptions a trade_updates event should wake, given the current registry. Pure. */
export function subscriptionsForOrderUpdate(
  registry: ReadonlyMap<string, ReadonlyMap<string, Subscription>>,
  orderId: string | undefined,
  event: string,
): Subscription[] {
  if (!orderId || !TERMINAL_TRADE_EVENTS.has(event)) return [];
  const subs = registry.get(orderId);
  return subs ? [...subs.values()] : [];
}

// One shared trading-updates connection for every order.filled subscription
// — opened when the first one arms, closed when the last one disarms.
let tradingStream: TradingStream | null = null;
// Resolves once the server has ack'd our `listen` request for trade_updates
// — see ensureTradingStream's comment on why this needs its own promise
// rather than reusing whenAuthenticated().
let tradingStreamListening: Promise<void> | null = null;

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
  stream.onConnect(() => stream.subscribeTradeUpdates());
  stream.onTradeUpdate(handleTradeUpdate);

  // Authenticated only means the socket is up — the server hasn't yet ack'd
  // that it's actually routing trade_updates frames to us. That ack arrives
  // as a `{"stream":"listening",...}` frame, which the SDK maps internally
  // to a "subscription" event (EVENT.SUBSCRIPTION) on the underlying
  // EventEmitter — there's no typed onListening/whenListening wrapper for
  // it (verified against the SDK's bundled source and live against the
  // real trade_updates endpoint), so this listens for the raw event
  // directly rather than inventing separate machinery.
  tradingStreamListening = new Promise<void>((resolve) => {
    stream.on(streaming.EVENT.SUBSCRIPTION, (channels: string[]) => {
      if (channels.includes("trade_updates")) {
        log("trade-updates subscribed");
        resolve();
      }
    });
  });

  stream.connect();
  tradingStream = stream;
  return stream;
}

/** Tears down the shared trading-updates connection and drops the cached instance — the next arm() must build a fresh one, never reuse a torn-down (or auth-poisoned) object. */
function closeTradingStream(): void {
  tradingStream?.disconnect();
  tradingStream = null;
  tradingStreamListening = null;
}

/** Closes the shared stream once nothing is watching any order anymore — shared by the normal disarm path and arm-failure cleanup, so a failure never strands a connection nobody's using. */
function maybeCloseTradingStream(): void {
  if (countOrderFilledSubs(orderFilledSubs) === 0) closeTradingStream();
}

function handleTradeUpdate(update: TradeUpdate): void {
  const snapshot = orderSnapshot(normalizeOrder(update.order));
  for (const sub of subscriptionsForOrderUpdate(orderFilledSubs, update.order.id, update.event)) {
    void deliverWake(sub, { reason: "fired", snapshot });
  }
}

function registerOrderFilledSub(sub: Subscription): void {
  const orderId = sub.resource;
  let subs = orderFilledSubs.get(orderId);
  if (!subs) {
    subs = new Map();
    orderFilledSubs.set(orderId, subs);
  }
  subs.set(sub.id, sub);
}

function unregisterOrderFilledSub(sub: Subscription): void {
  const subs = orderFilledSubs.get(sub.resource);
  if (!subs?.delete(sub.id)) return;
  if (subs.size === 0) orderFilledSubs.delete(sub.resource);
}

async function armOrderFilled(sub: Subscription): Promise<void> {
  // Register — and make sure the trade_updates stream is authenticated AND
  // listening — BEFORE the REST seed check below, not after. If the order
  // went terminal while that REST call was in flight, its push event must
  // find a routing entry already in place; a push for a transition that
  // already happened never re-arrives. deliverWake's own claim guard
  // (wake.ts) dedups if both this seed check and a push report the same
  // terminal order.
  registerOrderFilledSub(sub);

  // Any failure past this point (auth rejection, a bad order id, ...) must
  // not leave a live routing entry behind for a subscription that
  // armPendingForConversation is about to mark "failed" — arm failures
  // don't get a disarm() call to clean this up for us.
  try {
    const stream = ensureTradingStream();
    const auth = await stream.whenAuthenticated();
    if (!auth.authenticated) {
      // The stream itself is broken, not just this one subscription — drop
      // the cached instance immediately so no other in-flight or future
      // arm() reuses a connection that's already known to be dead.
      closeTradingStream();
      throw new Error(describeAuthFailure("trade-updates", auth));
    }

    await tradingStreamListening;

    const order = await getOrder(sub.resource);
    if (TERMINAL_ORDER_STATUSES.has(order.status)) {
      await deliverWake(sub, { reason: "fired", snapshot: orderSnapshot(order) });
    }
  } catch (err) {
    unregisterOrderFilledSub(sub);
    maybeCloseTradingStream();
    throw err;
  }
}

function disarmOrderFilled(sub: Subscription): void {
  unregisterOrderFilledSub(sub);
  maybeCloseTradingStream();
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
