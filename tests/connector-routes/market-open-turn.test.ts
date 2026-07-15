import assert from "node:assert/strict";
import { test } from "node:test";

import { mockEvent } from "../../connector/lib/test-support.ts";

// p6f gate finding (MED): a failed /catalog/chat POST used to return a
// normal 200 with `{status: "failed"}` in the body — Vercel's cron
// dashboard would record SUCCESS while the campaign turn silently never
// happened. This test exercises the ROUTE itself (not just
// connector/lib/market-open-turn.ts's own runMarketOpenTurn, which only
// proves the RESULT VALUE is `{status: "failed"}` — a genuinely different
// question from "does the HTTP response reflect that as a failure").
//
// p6g gate (HIGH, connector/routes/market-open-turn.test.ts:1): this file
// used to live in connector/routes/, which Nitro's serverDir="./" scanner
// (connector/nitro.config.ts) treats as production route source — mapping
// this test to an invalid accidental `/market-open-turn.test` handler in
// the deployed connector. Moved here (tests/connector-routes/, the repo's
// established tests/ convention alongside tests/agent-tools/) so it's
// picked up by root package.json's own `tests/**/*.test.ts` glob instead —
// same fix shape as AGENTS.md rule 7's ban on test files under agent/.
//
// p6g gate (LOW, connector/routes/market-open-turn.test.ts:23): the route
// handler calls `new Date()` directly (see
// connector/routes/market-open-turn.get.ts), and the weekday guard means
// this test's fetch stub is only reached on a real weekday — flaky by
// calendar, not by code, on any Saturday/Sunday. node:test's own built-in
// timer mocking (`t.mock.timers`) freezes `new Date()` to a fixed, known
// Monday for the DURATION of this test only, auto-restored on completion —
// no product-code change needed to make the route itself injectable.
//
// Only the true external boundary (the /catalog/chat POST itself) is
// stubbed; requireCronSecret runs for real against a real CRON_SECRET, and
// resolveMarketOpenBaseUrl runs for real too (VERCEL unset here, so it
// falls back to localhost rather than throwing — that path has its own
// dedicated tests in connector/lib/market-open-turn.test.ts).
test("market-open-turn route: a failed upstream POST results in a non-2xx route response, not a silent success", async (t) => {
  process.env.CRON_SECRET = "s3cret";
  process.env.CAMPAIGN_CONVERSATION_ID = "test-campaign";
  process.env.CATALOG_API_SECRET = "wake-secret";
  delete process.env.VERCEL;
  delete process.env.CATALOG_BASE_URL;
  t.after(() => {
    delete process.env.CRON_SECRET;
    delete process.env.CAMPAIGN_CONVERSATION_ID;
    delete process.env.CATALOG_API_SECRET;
  });

  // Monday 13:30 UTC — same fixture instant as connector/lib/market-open-turn.test.ts's
  // own MONDAY_13_30_UTC, so a failure here and there always describe the
  // same nominal "market is open" moment.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-07-13T13:30:00.000Z").getTime() });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    assert.ok(href.includes("/catalog/chat"), `unexpected fetch target: ${href}`);
    return new Response("boom", { status: 500 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const route = await import("../../connector/routes/market-open-turn.get.ts");
  const event = mockEvent("http://localhost/market-open-turn", { headers: { authorization: "Bearer s3cret" } });

  await assert.rejects(
    () => route.default(event),
    (err: unknown) => {
      const statusCode = (err as { statusCode?: number }).statusCode;
      assert.equal(statusCode, 502, `expected a 502, got ${statusCode}`);
      return true;
    },
  );
});
