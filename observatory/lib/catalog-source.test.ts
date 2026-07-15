import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchConversation } from "./catalog-source.ts";

// p6k gate (LOW): fetchConversation must treat ONLY eve's own genuine
// "unknown conversationId" 404 shape as "no conversation record yet" ->
// null. Any other 404 (a misrouted deployment, a wrong CATALOG_API_BASE_URL
// landing on some other 404 page, a stale eve build with no /catalog/
// conversations route) must become a thrown error instead — the same
// "healthy pre-launch empty state" must never mask a real infrastructure
// problem. Only globalThis.fetch is stubbed; the actual CATALOG_API_BASE_URL
// used doesn't matter here, since every assertion is about how the RESPONSE
// is interpreted, not which URL was requested.

function stubFetch(response: Response, t: { after: (fn: () => void) => void }): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => response) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
}

test("fetchConversation: eve's own exact 'unknown conversationId' 404 body resolves to null", async (t) => {
  stubFetch(new Response(JSON.stringify({ error: "unknown conversationId" }), { status: 404 }), t);
  const result = await fetchConversation("campaign-6");
  assert.equal(result, null);
});

test("fetchConversation: a 404 with an unrecognized JSON body (not eve's own shape) throws instead of returning null", async (t) => {
  stubFetch(new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }), t);
  await assert.rejects(() => fetchConversation("campaign-6"), /unrecognized body/);
});

test("fetchConversation: a 404 with a non-JSON body throws instead of returning null", async (t) => {
  stubFetch(new Response("<html>404</html>", { status: 404, headers: { "content-type": "text/html" } }), t);
  await assert.rejects(() => fetchConversation("campaign-6"), /non-JSON body/);
});

test("fetchConversation: a 404 with no error field at all throws instead of returning null", async (t) => {
  stubFetch(new Response(JSON.stringify({}), { status: 404 }), t);
  await assert.rejects(() => fetchConversation("campaign-6"), /unrecognized body/);
});

// p6l gate (LOW): the marker check must require the EXACT one-field shape
// eve's own route emits verbatim — a body that carries the marker PLUS an
// extra field is NOT that route response, and must throw like any other
// unrecognized 404, not be waved through because `.error` alone matched.
test("fetchConversation: a 404 with the correct marker PLUS an extra field throws — not the exact route response, so not treated as unknown-conversation", async (t) => {
  stubFetch(new Response(JSON.stringify({ error: "unknown conversationId", detail: "misrouted/stale handler" }), { status: 404 }), t);
  await assert.rejects(() => fetchConversation("campaign-6"), /unrecognized body/);
});

test("fetchConversation: a non-404 failure (e.g. 500) still throws, unchanged from before", async (t) => {
  stubFetch(new Response("boom", { status: 500 }), t);
  await assert.rejects(() => fetchConversation("campaign-6"), /-> 500/);
});

test("fetchConversation: a 200 with a real record resolves to that record", async (t) => {
  const record = { conversationId: "campaign-6", sessionId: "sess-1", startedAt: "2026-07-14T13:30:00.000Z" };
  stubFetch(new Response(JSON.stringify(record), { status: 200 }), t);
  const result = await fetchConversation("campaign-6");
  assert.deepEqual(result, record);
});
