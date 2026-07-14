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
//
// Also deletes the Alpaca credentials before every load: alpaca-client.ts's
// lazy alpacaClient Proxy defers `new Alpaca(...)` to the first real
// property access, and that constructor throws IMMEDIATELY if it has no
// credentials (its own file comment). A regressed guard — one where arm()/
// disarm() fall through to the real stream-connect code instead of staying
// pure no-ops — touches that Proxy and rejects loudly with the SDK's own
// auth error; an intact guard never touches it and needs no credentials at
// all. That makes "no real connection was attempted" a deterministic,
// network-free assertion instead of the elapsedMs<200 timing heuristic this
// file used to rely on (Codex gate finding, 2026-07-14) — which was not
// only flaky under load but, worse, would have let a regression open an
// ACTUAL websocket to the live Alpaca account on any run where real
// credentials happened to be configured.
async function loadConnectorModeProvider(): Promise<Provider> {
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;
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
// cleanly with NO Alpaca credentials configured at all (loadConnectorModeProvider
// deletes them) — a regressed guard that fell through to the real connect
// path would reject here with the SDK's own "Alpaca authentication requires
// both `keyId` and `secret`" error, not hang or silently succeed.
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

// Rewritten (Codex gate finding, 2026-07-14): this used to assert
// elapsedMs<200 as a proxy for "no real connection was attempted," which is
// both timing-flaky under load and only a proxy — a slow-but-real connect
// attempt could still sneak under the threshold. Same deterministic proof as
// the two tests above, just at bulk-arm scale: no credentials configured, so
// any arm() call that fell through to the real connect path would reject
// with the SDK's auth error, not silently take longer.
test("arming many subscriptions under WATCHER_HOST=connector never opens any real connection", async () => {
  const alpacaProvider = await loadConnectorModeProvider();
  const subs = Array.from({ length: 10 }, (_, i) => makeSub("price.crossesAbove", `test-watcher-host-bulk-${i}`));
  await assert.doesNotReject(async () => Promise.all(subs.map((sub) => alpacaProvider.arm(sub))));
});

// Codex gate finding 6 (2026-07-13): WATCHER_HOST must fail closed on a
// SET-but-wrong value instead of silently treating it as "in-process" — a
// typo like "Connector"/"CONNECTOR" on a deployed connector host would
// otherwise make the eve app open its own Alpaca streams alongside the
// connector, the exact split-brain this switch exists to prevent.
//
// Uses a cache-busting query string on the dynamic import (rather than the
// bare "./alpaca.ts" the tests above use): a module whose evaluation throws
// is permanently marked errored in Node's ESM cache, and every later
// import() of the SAME resolved specifier re-throws that same error rather
// than re-evaluating — importing plain "./alpaca.ts" here would poison the
// module for the "connector" tests above/below if this test ran first, and
// still risk contaminating the process if it ran after (Node does not
// evict an errored module record). A unique query string resolves to a
// distinct cache entry, so this import is genuinely independent.
test("WATCHER_HOST rejects a set-but-invalid value instead of defaulting to in-process", async () => {
  process.env.WATCHER_HOST = "CONNECTOR"; // case-mismatch typo, not the exact accepted string
  await assert.rejects(() => import(`./alpaca.ts?watcher-host-invalid=${Date.now()}`), /WATCHER_HOST="CONNECTOR" is invalid/);
});
