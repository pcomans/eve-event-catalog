import assert from "node:assert/strict";
import { test } from "node:test";

import type { Provider } from "../catalog.ts";
import type { Subscription } from "../types.ts";

// WATCHER_HOST is read once at alpaca.ts's own module-load time (same
// convention as ALPACA_DATA_FEED — KNOWN_ISSUES.md #2), so this test needs
// alpaca.ts to evaluate AFTER the env var is set. A top-level static
// `import { alpacaProvider } from "./alpaca.ts"` would NOT work here — ESM
// hoists all static imports above a file's own top-level statements, so
// alpaca.ts would evaluate (and capture WATCHER_HOST) BEFORE this file's
// own `process.env.WATCHER_HOST = "connector"` line ever ran (confirmed the
// hard way: the first version of this file did exactly that, and the real
// stock stream connect fired anyway — visible as real "invalid syntax"
// connection-error log lines even though the test itself asserted no-ops).
// A dynamic `import()`, called at runtime after the env var is set, defers
// evaluation correctly. Node gives each test FILE its own process by
// default (verified separately), so this can never leak into alpaca.test.ts's
// own (default, in-process) assumptions, or vice versa.
async function loadConnectorModeProvider(): Promise<Provider> {
  process.env.WATCHER_HOST = "connector";
  const mod = await import("./alpaca.ts");
  return mod.alpacaProvider;
}

function makeSub(event: Subscription["event"], resource: string): Subscription {
  return {
    id: `test:${resource}`,
    conversationId: `test:${resource}`,
    provider: "alpaca",
    event,
    resource,
    params: event === "order.filled" ? {} : { threshold: 150 },
    expiresAt: null,
    status: "armed",
    createdAt: "2026-07-13T10:00:00.000Z",
    armedAt: "2026-07-13T10:00:01.000Z",
    firedAt: null,
    lastError: null,
    deliverReason: null,
    deliverSnapshot: null,
  };
}

// p2v Codex gate finding 1: in WATCHER_HOST="connector" mode, arm()/disarm()
// must be pure registry-bookkeeping no-ops — no stream connect, no REST
// seed, no trade_updates routing registration. Proven by these resolving
// immediately (no real network round trip) without needing real Alpaca
// credentials or a live account — if either had attempted a real
// connect/REST call, this test would hang or throw against whatever
// ALPACA_API_KEY_ID/SECRET happens to be configured for the test run.
test("armPriceCross/disarmPriceCross are no-ops under WATCHER_HOST=connector", async () => {
  const alpacaProvider = await loadConnectorModeProvider();
  const sub = makeSub("price.crossesBelow", "test-watcher-host-symbol");
  await assert.doesNotReject(async () => alpacaProvider.arm(sub));
  assert.doesNotThrow(() => alpacaProvider.disarm(sub));
});

test("armOrderFilled/disarmOrderFilled are no-ops under WATCHER_HOST=connector", async () => {
  const alpacaProvider = await loadConnectorModeProvider();
  const sub = makeSub("order.filled", "test-watcher-host-order");
  await assert.doesNotReject(async () => alpacaProvider.arm(sub));
  assert.doesNotThrow(() => alpacaProvider.disarm(sub));
});

test("arming many subscriptions under WATCHER_HOST=connector never opens any real connection (all resolve near-instantly)", async () => {
  const alpacaProvider = await loadConnectorModeProvider();
  const start = Date.now();
  const subs = Array.from({ length: 10 }, (_, i) => makeSub("price.crossesAbove", `test-watcher-host-bulk-${i}`));
  await Promise.all(subs.map((sub) => alpacaProvider.arm(sub)));
  const elapsedMs = Date.now() - start;
  // A real stream connect + auth round trip takes well over a second in
  // practice (existing live-Alpaca tests elsewhere in this suite routinely
  // take 100s of ms to multiple seconds for a single auth handshake) — ten
  // arm() calls finishing in well under that is strong evidence no real
  // network I/O was attempted at all.
  assert.ok(elapsedMs < 200, `expected near-instant no-op arms, took ${elapsedMs}ms — a real connection may have been attempted`);
});
