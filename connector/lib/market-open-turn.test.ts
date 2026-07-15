import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveMarketOpenBaseUrl, runMarketOpenTurn } from "./market-open-turn.ts";

// A weekday and a weekend date, both at the real 13:30 UTC fire time —
// matches catalog/market-day.test.ts's own convention (same dates it uses).
const MONDAY_13_30_UTC = new Date("2026-07-13T13:30:00.000Z");
const SATURDAY_13_30_UTC = new Date("2026-07-18T13:30:00.000Z");

function unreachableFetch(): typeof fetch {
  return (async () => {
    throw new Error("fetch must not be called for this case");
  }) as typeof fetch;
}

// p6f gate task (market-open cron transport): weekday skip and unset-var
// skip are exactly the guard logic that needs to be deterministically
// testable server-free — requireCronSecret coverage already exists
// (connector/lib/auth.test.ts), not duplicated here.
test("runMarketOpenTurn: skips on a non-market-weekday and never calls fetch", async () => {
  const result = await runMarketOpenTurn(
    SATURDAY_13_30_UTC,
    { CAMPAIGN_CONVERSATION_ID: "campaign-6", CATALOG_API_SECRET: "s3cret" },
    "http://localhost:2000",
    unreachableFetch(),
  );

  assert.deepEqual(result, { status: "skipped-not-market-weekday" });
});

test("runMarketOpenTurn: skips when CAMPAIGN_CONVERSATION_ID is unset and never calls fetch", async () => {
  const result = await runMarketOpenTurn(MONDAY_13_30_UTC, {}, "http://localhost:2000", unreachableFetch());

  assert.deepEqual(result, { status: "skipped-no-conversation-id" });
});

test("runMarketOpenTurn: on a market weekday with a conversation id, POSTs /catalog/chat with the exact message, bearer, and conversationId", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const stub = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const result = await runMarketOpenTurn(
    MONDAY_13_30_UTC,
    { CAMPAIGN_CONVERSATION_ID: "campaign-6", CATALOG_API_SECRET: "s3cret" },
    "https://example.vercel.app",
    stub,
  );

  assert.deepEqual(result, { status: "ok", conversationId: "campaign-6" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.vercel.app/catalog/chat");
  assert.equal(calls[0].init.method, "POST");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer s3cret");
  assert.deepEqual(JSON.parse(calls[0].init.body as string), {
    conversationId: "campaign-6",
    // Byte-identical to agent/schedules/market-open.ts's own message.
    message: "[market-open] The US market is open. Review your positions and watches, and act if you have a reason to.",
  });
});

test("runMarketOpenTurn: a non-ok response from /catalog/chat is reported as 'failed' with the upstream status", async () => {
  const stub = (async () => new Response("boom", { status: 500 })) as typeof fetch;

  const result = await runMarketOpenTurn(
    MONDAY_13_30_UTC,
    { CAMPAIGN_CONVERSATION_ID: "campaign-6" },
    "http://localhost:2000",
    stub,
  );

  assert.deepEqual(result, { status: "failed", httpStatus: 500 });
});

// p6f gate finding (INFO, taken): a silent localhost fallback in a
// genuinely deployed context would 404 every market-open turn into the
// void instead of failing loudly.
test("resolveMarketOpenBaseUrl: an explicit CATALOG_BASE_URL always wins, deployed or not", () => {
  assert.equal(resolveMarketOpenBaseUrl({ CATALOG_BASE_URL: "https://example.vercel.app" }), "https://example.vercel.app");
  assert.equal(resolveMarketOpenBaseUrl({ CATALOG_BASE_URL: "https://example.vercel.app", VERCEL: "1" }), "https://example.vercel.app");
});

test("resolveMarketOpenBaseUrl: unset CATALOG_BASE_URL in a deployed (VERCEL) context throws rather than defaulting to localhost", () => {
  assert.throws(() => resolveMarketOpenBaseUrl({ VERCEL: "1" }), /CATALOG_BASE_URL is unset in a deployed/);
});

test("resolveMarketOpenBaseUrl: unset CATALOG_BASE_URL outside a deployed context (local dev) falls back to localhost", () => {
  assert.equal(resolveMarketOpenBaseUrl({}), "http://localhost:2000");
  assert.equal(resolveMarketOpenBaseUrl({ PORT: "3000" }), "http://localhost:3000");
});
