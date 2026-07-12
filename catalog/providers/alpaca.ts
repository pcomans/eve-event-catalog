import type { Subscription } from "../types.ts";
import { registerProvider, type Provider } from "../catalog.ts";
import { deliverWake } from "../wake.ts";
import { logCatalog } from "../log.ts";
import { crosses, type CrossingDirection } from "./crossing.ts";
import {
  AlpacaStream,
  getLatestTrade,
  getOrder,
  type AlpacaOrder,
  type DataFeed,
  type Trade,
} from "./alpaca-client.ts";

// ALPACA_DATA_FEED=test switches the shared stream (and, implicitly, seeding
// behavior below) to Alpaca's 24/7 synthetic FAKEPACA feed for off-hours
// development; unset or "iex" uses the real feed. Read once at module load —
// changing it requires a process restart anyway (KNOWN_ISSUES.md #2), same
// as every other env var here.
const FEED = (process.env.ALPACA_DATA_FEED ?? "iex") as DataFeed;

// One shared connection for every price subscription — the free market data
// plan allows exactly one. Lazily connects on the first subscribe() call.
const stream = new AlpacaStream(FEED);

interface PriceState {
  sub: Subscription;
  direction: CrossingDirection;
  threshold: number;
  symbol: string;
  /** null until seeded (REST snapshot on iex, first stream tick on test) — see armPriceCross. */
  previous: number | null;
}

const priceSubs = new Map<string, PriceState>();
const orderPolls = new Map<string, ReturnType<typeof setInterval>>();

const TERMINAL_ORDER_STATUSES = new Set(["filled", "canceled", "rejected", "expired"]);
const ORDER_POLL_INTERVAL_MS = 3000;

/**
 * Dispatches one incoming trade tick to every price subscription watching
 * that symbol. Registered once, at module load, rather than per
 * subscription — the stream delivers ticks for the shared connection as a
 * whole, not per watcher.
 */
function handleTrade(trade: Trade): void {
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
          tradeAt: trade.timestamp,
        },
      });
    }
    state.previous = trade.price;
  }
}

stream.onTrade(handleTrade);

async function armPriceCross(sub: Subscription): Promise<void> {
  const direction: CrossingDirection = sub.event === "price.crossesBelow" ? "below" : "above";
  const symbol = sub.resource;
  const { threshold } = sub.params as { threshold: number };

  const state: PriceState = { sub, direction, threshold, symbol, previous: null };
  priceSubs.set(sub.id, state);

  await stream.subscribe([symbol]);

  if (FEED === "iex") {
    const trade = await getLatestTrade(symbol, FEED);
    state.previous = trade.price;
    logCatalog("seeded", sub, { symbol, price: trade.price, source: "rest" });
  }
  // On the "test" feed, `state.previous` stays null here and is seeded from
  // the first stream tick instead (see handleTrade above).
}

async function disarmPriceCross(sub: Subscription): Promise<void> {
  const state = priceSubs.get(sub.id);
  if (!state) return;
  priceSubs.delete(sub.id);

  const stillWatched = [...priceSubs.values()].some((other) => other.symbol === state.symbol);
  if (!stillWatched) await stream.unsubscribe([state.symbol]);
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

async function pollOrderOnce(sub: Subscription): Promise<void> {
  let order: AlpacaOrder;
  try {
    order = await getOrder(sub.resource);
  } catch (err) {
    // A transient network hiccup shouldn't kill the poll loop (or the
    // process, via an unhandled rejection) — log and let the next tick try
    // again; no retry bookkeeping needed since setInterval already provides it.
    const message = err instanceof Error ? err.message : String(err);
    logCatalog("order-poll-failed", sub, { error: message });
    return;
  }

  if (!TERMINAL_ORDER_STATUSES.has(order.status)) return;

  const timer = orderPolls.get(sub.id);
  if (timer) clearInterval(timer);
  orderPolls.delete(sub.id);

  // Every terminal status (not just "filled") wakes the agent with the real
  // status in the snapshot — canceled/rejected/expired must not be left to
  // wait forever for a fill that will never come.
  await deliverWake(sub, { reason: "fired", snapshot: orderSnapshot(order) });
}

function armOrderPoll(sub: Subscription): void {
  const timer = setInterval(() => void pollOrderOnce(sub), ORDER_POLL_INTERVAL_MS);
  orderPolls.set(sub.id, timer);
  // Check immediately too — a market order can fill in under 3s, and there's
  // no reason to make the agent wait out a full poll interval to find out.
  void pollOrderOnce(sub);
}

function disarmOrderPoll(sub: Subscription): void {
  const timer = orderPolls.get(sub.id);
  if (timer) clearInterval(timer);
  orderPolls.delete(sub.id);
}

async function arm(sub: Subscription): Promise<void> {
  switch (sub.event) {
    case "order.filled":
      armOrderPoll(sub);
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
      disarmOrderPoll(sub);
      return;
    case "price.crossesBelow":
    case "price.crossesAbove":
      await disarmPriceCross(sub);
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
