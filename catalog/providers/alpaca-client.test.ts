import assert from "node:assert/strict";
import { test } from "node:test";

import { errors } from "@alpacahq/alpaca-trade-api";

import {
  alpacaClient,
  describeAlpacaError,
  getAccount,
  getHistoricalTrades,
  getLatestTrade,
  getOrderStatuses,
  recordTestFeedTrade,
} from "./alpaca-client.ts";

test("getLatestTrade on the test feed returns the specific symbol's last recorded tick, not another symbol's", async () => {
  recordTestFeedTrade("FAKEPACA", { price: 134.56, timestamp: "2026-07-12T10:00:00.000Z" });
  recordTestFeedTrade("OTHERFAKE", { price: 9.99, timestamp: "2026-07-12T10:00:01.000Z" });

  assert.deepEqual(await getLatestTrade("FAKEPACA", "test"), {
    price: 134.56,
    timestamp: "2026-07-12T10:00:00.000Z",
  });
  assert.deepEqual(await getLatestTrade("OTHERFAKE", "test"), {
    price: 9.99,
    timestamp: "2026-07-12T10:00:01.000Z",
  });
});

test("getLatestTrade on the test feed rejects a symbol that has never ticked, even if another symbol has", async () => {
  recordTestFeedTrade("FAKEPACA", { price: 134.56, timestamp: "2026-07-12T10:00:00.000Z" });

  await assert.rejects(() => getLatestTrade("NEVER-TICKED", "test"), /no test-feed trade observed yet/);
});

test("recordTestFeedTrade overwrites only the symbol it's called with", async () => {
  recordTestFeedTrade("FAKEPACA", { price: 100, timestamp: "2026-07-12T10:00:00.000Z" });
  recordTestFeedTrade("OTHERFAKE", { price: 200, timestamp: "2026-07-12T10:00:01.000Z" });
  recordTestFeedTrade("FAKEPACA", { price: 101, timestamp: "2026-07-12T10:00:02.000Z" });

  assert.equal((await getLatestTrade("FAKEPACA", "test")).price, 101);
  assert.equal((await getLatestTrade("OTHERFAKE", "test")).price, 200);
});

// Codex gate finding: getHistoricalTrades/getOrderStatuses had no direct
// tests at all — both call the real Alpaca SDK, which this file doesn't
// mock (no existing convention for it here; the rest of this seam is
// verified live). What IS testable without hitting the network: the
// documented test-feed short-circuit (no REST history exists for FAKEPACA)
// and, via a minimal monkey-patch of the one SDK method involved,
// getOrderStatuses' per-order failure isolation (Promise.allSettled) — the
// exact behavior Codex flagged as unverified. Full REST-semantics coverage
// (inclusive cursor boundaries, SDK pagination/paging tokens, rate limits)
// remains an acknowledged gap; gap-replay.ts's filterTradesAfterCursor
// already defends the inclusive-boundary risk at the pure-logic layer
// regardless of what the live API actually does.
test("getHistoricalTrades: the test feed short-circuits to an empty gap without calling the SDK at all", async () => {
  assert.deepEqual(await getHistoricalTrades("FAKEPACA", null, "test"), []);
});

// p6n gate finding (MED): getStockTradesFor(symbol, ...) is a single-symbol
// convenience wrapper around the SDK's multi-symbol getStockTrades, which
// hits GET /v2/stocks/trades?symbols=<symbol> on the wire (confirmed against
// the installed SDK's stockTradesRaw: `symbols` is a query param, not a path
// segment) — there is no real /v2/stocks/:symbol/trades route to label a
// failure with.
test("getHistoricalTrades (non-test feed): a failure is labeled with the real multi-symbol wire route, not a fabricated per-symbol path", async (t) => {
  const original = alpacaClient.marketData.getStockTradesFor;
  t.after(() => {
    alpacaClient.marketData.getStockTradesFor = original;
  });

  alpacaClient.marketData.getStockTradesFor = (async () => {
    throw new errors.ApiError(
      { url: "https://data.alpaca.markets/v2/stocks/trades?symbols=FAKEPACA" } as Response,
      429,
      undefined,
      "rate limited",
    );
  }) as typeof original;

  await assert.rejects(
    () => getHistoricalTrades("FAKEPACA", null, "iex"),
    /^Error: Alpaca 429 on \/v2\/stocks\/trades\?symbols=FAKEPACA: rate limited$/,
  );
});

test("getOrderStatuses: an empty order-id list short-circuits without calling the SDK at all", async () => {
  assert.deepEqual(await getOrderStatuses([]), []);
});

test("getOrderStatuses: a single order lookup failing does not abort the rest of the batch", async (t) => {
  const original = alpacaClient.trading.orders.getOrderByOrderID;
  t.after(() => {
    alpacaClient.trading.orders.getOrderByOrderID = original;
  });
  t.mock.method(console, "warn", () => {}); // the failure below is now logged (p6o) — expected noise, not under test here

  alpacaClient.trading.orders.getOrderByOrderID = (async ({ orderId }: { orderId: string }) => {
    if (orderId === "order-broken") throw new Error("simulated transient REST failure");
    return { id: orderId, status: "filled", filledQty: "10", filledAvgPrice: "150.00" };
  }) as typeof original;

  const statuses = await getOrderStatuses(["order-ok", "order-broken"]);

  assert.equal(statuses.length, 1, "the broken order's lookup must be skipped, not abort the whole batch");
  assert.equal(statuses[0].orderId, "order-ok");
  assert.equal(statuses[0].status, "filled");
});

// p6o gate finding (LOW): the reason discarded above is now describeAlpacaError
// -formatted (previous round) but was still never surfaced anywhere — a
// PERSISTENT lookup failure across every sweep left zero evidence. Swallow
// semantics (batch survives) stay exactly the same; only the "discard" half
// changes, from silent to logged.
test("getOrderStatuses: a rejected order lookup is logged (not silently discarded) before being skipped", async (t) => {
  const original = alpacaClient.trading.orders.getOrderByOrderID;
  t.after(() => {
    alpacaClient.trading.orders.getOrderByOrderID = original;
  });
  const warn = t.mock.method(console, "warn", () => {});

  alpacaClient.trading.orders.getOrderByOrderID = (async () => {
    throw new errors.ApiError(
      { url: "https://paper-api.alpaca.markets/v2/orders/order-broken" } as Response,
      503,
      undefined,
      "upstream unavailable",
    );
  }) as typeof original;

  await getOrderStatuses(["order-broken"]);

  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /Alpaca 503 on \/v2\/orders\/order-broken: upstream unavailable/);
});

// p6p gate finding (MED): console.warn itself is not guaranteed side-effect-
// free (a wrapped/piped console, a broken transport) — if IT throws, that
// exception was propagating out of the for-loop uncaught, which would have
// dropped every remaining (including already-fulfilled) order from the
// batch this sweep. Logging a failure must never be able to cause a WORSE
// failure than the one it's logging.
test("getOrderStatuses: the batch survives even if console.warn itself throws", async (t) => {
  const original = alpacaClient.trading.orders.getOrderByOrderID;
  t.after(() => {
    alpacaClient.trading.orders.getOrderByOrderID = original;
  });
  t.mock.method(console, "warn", () => {
    throw new Error("simulated broken console transport");
  });

  alpacaClient.trading.orders.getOrderByOrderID = (async ({ orderId }: { orderId: string }) => {
    if (orderId === "order-broken") throw new Error("simulated transient REST failure");
    return { id: orderId, status: "filled", filledQty: "10", filledAvgPrice: "150.00" };
  }) as typeof original;

  const statuses = await getOrderStatuses(["order-ok", "order-broken"]);

  assert.equal(statuses.length, 1, "the fulfilled order must still be returned even though logging the other one threw");
  assert.equal(statuses[0].orderId, "order-ok");
  assert.equal(statuses[0].status, "filled");
});

// Production incident: a live Alpaca blip surfaced the SDK's own generic
// fetchApi wrapper message ("The request failed and the interceptors did
// not return an alternative response") in the public transcript, four times
// in a row, with no HTTP status or indication of what actually broke.
// describeAlpacaError is the one place that translates whatever the v4
// alpha SDK's errors.* classes actually carry (inspected directly: errors.
// ApiError has `.status` + a `.message` already parsed from the response
// body by errors.buildApiError; errors.FetchError only has `.cause`, the
// raw pre-response failure, since fetch() never got far enough to produce
// one) into a message worth putting in front of an agent or a viewer.
test("describeAlpacaError: an errors.ApiError becomes 'Alpaca <status> on <endpoint>: <body message>'", () => {
  const apiError = new errors.ApiError(
    { url: "https://paper-api.alpaca.markets/v2/account" } as Response,
    503,
    undefined,
    "upstream unavailable",
  );

  const described = describeAlpacaError("/v2/account", apiError);

  assert.equal(described.message, "Alpaca 503 on /v2/account: upstream unavailable");
  assert.equal(described.cause, apiError);
});

test("describeAlpacaError: an errors.FetchError surfaces the underlying cause, not the SDK's generic interceptor message", () => {
  const cause = new Error("fetch failed: ECONNRESET");
  const fetchError = new errors.FetchError(
    cause,
    "The request failed and the interceptors did not return an alternative response",
  );

  const described = describeAlpacaError("/v2/account", fetchError);

  assert.match(described.message, /\/v2\/account/);
  assert.match(described.message, /fetch failed: ECONNRESET/);
  assert.doesNotMatch(described.message, /interceptors did not return/);
});

test("describeAlpacaError: a plain Error (unrecognized shape) is still labeled with the endpoint", () => {
  const described = describeAlpacaError("/v2/account", new Error("boom"));

  assert.equal(described.message, "Alpaca request to /v2/account failed: boom");
});

test("getAccount rethrows describeAlpacaError's message on an SDK failure, not the SDK's opaque default", async (t) => {
  const original = alpacaClient.trading.account.getAccount;
  t.after(() => {
    alpacaClient.trading.account.getAccount = original;
  });

  alpacaClient.trading.account.getAccount = (async () => {
    throw new errors.ApiError(
      { url: "https://paper-api.alpaca.markets/v2/account" } as Response,
      503,
      undefined,
      "upstream unavailable",
    );
  }) as typeof original;

  await assert.rejects(() => getAccount(), /^Error: Alpaca 503 on \/v2\/account: upstream unavailable$/);
});
