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
import { streaming, Alpaca, errors, marketDataShapes, trading } from "@alpacahq/alpaca-trade-api";

import { readCursor } from "./gap-replay-cursor.ts";
import type { OrderStatusSnapshot } from "./order-reconciliation.ts";
import { padTimestampToNanoseconds, type ReplayCursor, type ReplayTrade } from "./gap-replay.ts";

type SdkOrder = trading.Order;
const { toStockTrade } = marketDataShapes;

export type DataFeed = "iex" | "test";

// Lazy, not `export const alpacaClient = new Alpaca(...)`: constructing the
// SDK client throws immediately if ALPACA_API_KEY_ID/SECRET_KEY aren't set,
// and this module is imported (transitively, via alpaca.ts/alpaca-session.ts)
// by every workflow the connector bundles together — Nitro bundles the whole
// app's "use step" handlers into one shared module graph, so importing this
// file at all (regardless of whether a given request path ever touches
// Alpaca) used to crash the ENTIRE step-execution endpoint in any
// environment without Alpaca creds configured (found live: a Preview
// deployment, which — unlike Development — has no ALPACA_API_KEY_ID/SECRET
// provisioned, crashed the edgar-sweep workflow's own step calls even though
// edgar-sweep never touches this client at all). A Proxy defers the real
// `new Alpaca(...)` call (and its credential check) to the first ACTUAL
// property access, so merely importing this module — the thing every
// workflow's shared bundle does unconditionally — can never throw; only
// code that genuinely calls into the Alpaca SDK can.
let alpacaClientInstance: Alpaca | undefined;

function createAlpacaClient(): Alpaca {
  return new Alpaca({
    keyId: process.env.ALPACA_API_KEY_ID,
    secret: process.env.ALPACA_API_SECRET_KEY,
    paper: true,
  });
}

export const alpacaClient: Alpaca = new Proxy({} as Alpaca, {
  // Deliberately 2-arg Reflect.get (no `receiver`): the SDK's own `trading`/
  // `marketData` accessors are lazy getters that cache a sub-client on the
  // instance itself — forwarding `receiver` as this Proxy would rebind their
  // internal `this`, so each access could construct (and cache) against the
  // PROXY instead of the real instance, silently losing the cache and
  // breaking anything (like a test) that monkey-patches a method on a
  // previously-read sub-client. Binding to the real instance keeps every
  // access — including repeated ones — behaving exactly as if this Proxy
  // weren't here at all.
  get(_target, prop) {
    alpacaClientInstance ??= createAlpacaClient();
    return Reflect.get(alpacaClientInstance, prop);
  },
});

/**
 * Formats an Alpaca SDK request failure for a thrown Error message. Pure.
 * A production blip surfaced only the SDK's own generic fetchApi wrapper
 * message ("The request failed and the interceptors did not return an
 * alternative response") in the public transcript — useless for telling a
 * fill from a rate limit from a network blip. What the v4 alpha SDK's
 * errors.* classes actually carry (inspected directly): `errors.ApiError`
 * (thrown for any non-2xx response, via errors.buildApiError) already has
 * `.status` and a `.message` pre-parsed from the response body's `message`
 * field (or the raw body text, or a generic "HTTP <status>" fallback if the
 * body wasn't readable) — no extra body-snippet parsing needed here.
 * `errors.FetchError` is the one that produces that opaque message above:
 * it's thrown when the underlying `fetch()` itself failed (DNS, TLS,
 * connection reset) BEFORE any response came back, so it carries only
 * `.cause` (the raw failure) and nothing about the endpoint — hence the
 * caller-supplied `endpoint` label, the one thing every call site already
 * knows and the SDK's own error object doesn't.
 */
export function describeAlpacaError(endpoint: string, error: unknown): Error {
  if (error instanceof errors.ApiError) {
    return new Error(`Alpaca ${error.status} on ${endpoint}: ${error.message}`, { cause: error });
  }
  if (error instanceof errors.FetchError) {
    const causeMessage = error.cause instanceof Error ? error.cause.message : String(error.cause);
    return new Error(`Alpaca request to ${endpoint} failed before a response came back: ${causeMessage}`, {
      cause: error,
    });
  }
  if (error instanceof Error) {
    return new Error(`Alpaca request to ${endpoint} failed: ${error.message}`, { cause: error });
  }
  return new Error(`Alpaca request to ${endpoint} failed: ${String(error)}`);
}

export interface AlpacaAccount {
  id: string;
  status: string;
  currency: string;
  cash: string;
  portfolio_value: string;
  buying_power: string;
}

export async function getAccount(): Promise<AlpacaAccount> {
  const account = await alpacaClient.trading.account
    .getAccount()
    .catch((e: unknown) => Promise.reject(describeAlpacaError("/v2/account", e)));
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
  const positions = await alpacaClient.trading.positions
    .getAllOpenPositions()
    .catch((e: unknown) => Promise.reject(describeAlpacaError("/v2/positions", e)));
  return positions.map((position) => ({
    symbol: position.symbol,
    side: position.side,
    qty: position.qty,
    avg_entry_price: position.avgEntryPrice,
    market_value: position.marketValue,
    unrealized_pl: position.unrealizedPl,
  }));
}

// Mirrors the Alpaca SDK's own QtyOnly/NotionalOnly split on MarketOrderInput
// (exactly one of qty/notional, never both) — buy orders in this codebase
// size by notional (agent/tools/submit_order.ts), sell orders size by qty,
// rejected outright (never clamped) if it exceeds the held position
// (agent/tools/submit_sell_order.ts's assertSellWithinPosition).
export type SubmitOrderInput = {
  symbol: string;
  side: "buy" | "sell";
  type: "market";
  time_in_force: "day";
} & ({ notional: string; qty?: never } | { qty: string; notional?: never });

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
  const order = await alpacaClient.trading.orders
    .market(
      input.notional !== undefined
        ? { symbol: input.symbol, side: input.side, notional: input.notional }
        : { symbol: input.symbol, side: input.side, qty: input.qty },
    )
    .catch((e: unknown) => Promise.reject(describeAlpacaError("/v2/orders", e)));
  return normalizeOrder(order);
}

export async function getOrder(orderId: string): Promise<AlpacaOrder> {
  const order = await alpacaClient.trading.orders
    .getOrderByOrderID({ orderId })
    .catch((e: unknown) => Promise.reject(describeAlpacaError(`/v2/orders/${orderId}`, e)));
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

// Same WATCHER_HOST convention as alpaca.ts (duplicated per-module, like
// FEED above — KNOWN_ISSUES.md #2's "read once at module load, changing it
// needs a restart anyway"). Only the "connector" branch matters here
// (getLatestTrade's fallback below); the fail-closed throw on a SET-but-
// invalid value already lives in alpaca.ts, whose own module-load throw
// stops the eve app from booting on a typo — duplicating that throw here
// too would reintroduce exactly the "importing this file alone crashes an
// unrelated bundle" problem the lazy alpacaClient Proxy above exists to
// avoid, for a check this seam doesn't otherwise need.
const IS_CONNECTOR_MODE = process.env.WATCHER_HOST === "connector";

export async function getLatestTrade(symbol: string, feed: DataFeed): Promise<LatestTrade> {
  if (feed === "test") {
    const trade = testFeedTrades.get(symbol);
    if (trade) return trade;

    // In connector mode, alpaca.ts's arm()/disarm() are pure no-ops (p2v fix
    // 1) — the in-process tick handler that calls recordTestFeedTrade above
    // never runs, so this Map is ALWAYS empty here. The connector's own
    // session persists each symbol's latest price alongside its replay
    // cursor instead (gap-replay-cursor.ts's readCursor, written by p2v fix
    // 10's writeCursorFenced) — fall back to that before giving up.
    if (IS_CONNECTOR_MODE) {
      const persisted = await readCursor(symbol);
      if (persisted) return { price: persisted.lastPrice, timestamp: persisted.cursor.timestamp };
    }

    throw new Error(
      `no test-feed trade observed yet for ${symbol} — the price stream hasn't ticked since this process started`,
    );
  }

  const resp = await alpacaClient.marketData.stocks
    .stockLatestTradeSingle({ symbol, feed })
    .catch((e: unknown) => Promise.reject(describeAlpacaError(`/v2/stocks/${symbol}/trades/latest`, e)));
  const trade = toStockTrade(resp.trade, symbol);
  return { price: trade.price, timestamp: trade.timestamp.toISOString() };
}

// Correctness prerequisite 1's real seam: catalog/providers/gap-replay.ts's
// FetchHistoricalTrades type, backed by the actual Alpaca REST call. No
// history exists for "test" feed's synthetic FAKEPACA symbol (the same
// documented limitation getLatestTrade's own test-feed branch works around
// above) — an empty gap is the honest answer there, not a REST call that
// would just fail.
const NO_CURSOR_LOOKBACK_MS = 5 * 60 * 1000; // no persisted cursor yet: look back 5 minutes as a reasonable first-connect gap window

export async function getHistoricalTrades(
  symbol: string,
  cursor: ReplayCursor | null,
  feed: DataFeed = "iex",
): Promise<ReplayTrade[]> {
  if (feed === "test") return [];

  const start = cursor ? new Date(cursor.timestamp) : new Date(Date.now() - NO_CURSOR_LOOKBACK_MS);
  const end = new Date();
  // getStockTradesFor(symbol, ...) is a single-symbol convenience wrapper
  // around the SDK's multi-symbol getStockTrades, which hits the actual
  // wire route GET /v2/stocks/trades?symbols=<symbol> (verified against
  // the installed SDK's stockTradesRaw: `symbols` is a query param, not a
  // path segment — there is no per-symbol /v2/stocks/:symbol/trades route).
  const trades = await alpacaClient.marketData
    .getStockTradesFor(symbol, { start, end, feed })
    .catch((e: unknown) => Promise.reject(describeAlpacaError(`/v2/stocks/trades?symbols=${symbol}`, e)));
  return trades.map((trade) => ({
    id: trade.id ?? 0,
    exchange: trade.exchange ?? "",
    // Codex gate finding: `timestamp` truncates to millisecond precision;
    // `timestampRaw` preserves the SDK's full nanosecond precision "when
    // the source preserved it" (symbol-keyed map responses and the live
    // stream do, per the SDK's own Trade type doc). Multiple trades within
    // the same millisecond would otherwise be cursor-indistinguishable,
    // making an inclusive-boundary reconnect unable to tell which same-
    // millisecond rows precede or follow the persisted cursor. Falls back
    // to the millisecond string on the rare response shape that omits it —
    // padded to the SAME nanosecond width via padTimestampToNanoseconds
    // (p2v Codex gate finding: an unpadded ms string sorts INCORRECTLY
    // against a genuine ns-precision one from another trade in the same
    // millisecond — gap-replay.ts's own comment has the full mechanism).
    // Every ReplayTrade timestamp, from every source, must share this one
    // canonical width — see alpaca-session.ts's toReplayTrade, the other
    // ingestion boundary.
    timestamp: trade.timestampRaw ?? padTimestampToNanoseconds(trade.timestamp.toISOString()),
    price: trade.price,
  }));
}

// Correctness prerequisite 1's trade_updates leg: catalog/providers/
// order-reconciliation.ts's FetchOrderStatuses type, backed by real Alpaca
// REST calls — one getOrderByOrderID per watched order id, not a closed-
// orders date-range scan (Codex gate finding: that endpoint's after/until
// filters apply to the order's submitted_at, not its terminal transition,
// so an order submitted before the bracket but terminalized DURING it was
// invisible to that query regardless of how the bracket was chosen; it
// also pages at a default limit of 50 with no auto-pagination, and offers
// no `ids` filter to ask for a specific batch — checked the SDK's own
// GetAllOrdersRequest type). Querying each watched id's CURRENT status
// directly sidesteps all three problems. A single order's lookup failing
// (deleted order, transient network error) must not abort the whole
// batch — Promise.allSettled, silently skipping that one order this sweep;
// it's re-checked on the next cadence tick regardless.
export async function getOrderStatuses(orderIds: string[]): Promise<OrderStatusSnapshot[]> {
  const results = await Promise.allSettled(
    orderIds.map((orderId) =>
      alpacaClient.trading.orders
        .getOrderByOrderID({ orderId })
        .catch((e: unknown) => Promise.reject(describeAlpacaError(`/v2/orders/${orderId}`, e))),
    ),
  );
  const statuses: OrderStatusSnapshot[] = [];
  for (const result of results) {
    if (result.status === "rejected") {
      // Swallow semantics unchanged (the batch survives, this order is
      // re-checked next sweep) — but the reason is now describeAlpacaError-
      // formatted (endpoint + status), so a PERSISTENT failure leaves
      // actionable evidence instead of vanishing silently.
      try {
        console.warn(`[getOrderStatuses] order lookup failed, skipping this sweep: ${result.reason}`);
      } catch {
        // Logging must never break the batch contract.
      }
      continue;
    }
    const order = result.value;
    statuses.push({
      orderId: order.id!,
      status: order.status!,
      filledQty: order.filledQty ?? null,
      filledAvgPrice: order.filledAvgPrice ?? null,
    });
  }
  return statuses;
}

/**
 * Formats a stream authentication failure for a thrown Error message. Pure.
 * Lives here (not in alpaca.ts, the in-process provider) so BOTH that file
 * and connector/lib/alpaca-session.ts can use it without either one needing
 * to import the other's stream-holding module.
 */
export function describeAuthFailure(label: string, result: streaming.StreamAuthResult): string {
  const code = result.code !== undefined ? ` code=${result.code}` : "";
  return `${label} stream authentication failed: status=${result.status}${code} message=${result.message}`;
}
