// This file specifically tests alpaca-client.ts's lazy-Proxy construction
// (found live, 2026-07-13, during the Phase 3 EDGAR sweep preview smoke
// test): the module must be importable — and safely unused — even with
// ZERO Alpaca credentials configured, since the connector's shared Nitro
// bundle imports it transitively for EVERY workflow regardless of whether
// that workflow ever touches Alpaca. A Preview deployment with no
// ALPACA_API_KEY_ID/SECRET configured (unlike Development, which has them)
// crashed the UNRELATED edgar-sweep workflow's own step calls, because the
// old eager `export const alpacaClient = new Alpaca(...)` at module scope
// threw the moment anything imported this file at all.
//
// process.env is mutated before any dynamic import below — deliberately
// NOT a static top-level import of alpaca-client.ts, which ESM would hoist
// above this mutation (hit that exact trap once already this session, see
// alpaca-watcher-host.test.ts's own comment).
delete process.env.ALPACA_API_KEY_ID;
delete process.env.ALPACA_API_SECRET_KEY;

import assert from "node:assert/strict";
import { test } from "node:test";

test("importing alpaca-client.ts never throws, even with zero Alpaca credentials configured", async () => {
  await assert.doesNotReject(() => import("./alpaca-client.ts"));
});

test("accessing alpacaClient's own properties without credentials throws the REAL Alpaca SDK error, not silently succeeding", async () => {
  const { alpacaClient } = await import("./alpaca-client.ts");
  assert.throws(() => alpacaClient.trading, /keyId|secret|OAuth|accessToken/i);
});
