import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import type { Provider } from "../catalog.ts";
import type { Subscription } from "../types.ts";
import { readDueClockSubscriptionIds, removeClockDue } from "./clock-redis.ts";

// WATCHER_HOST is read once at clock.ts's own module-load time (same
// convention as alpaca-watcher-host.test.ts's own comment explains in
// full) — a static import would be hoisted above this file's own
// `process.env.WATCHER_HOST = ...` line and capture the wrong value. A
// dynamic import(), called at runtime after the env var is set, defers
// evaluation correctly. Node gives each test FILE its own process by
// default, so this can never leak into clock.test.ts's own (default,
// in-process) assumptions, or vice versa.
async function loadConnectorModeClockProvider(): Promise<Provider> {
  process.env.WATCHER_HOST = "connector";
  const mod = await import("./clock.ts");
  return mod.clockProvider;
}

function makeSub(at: string): Subscription {
  const id = `test:${randomUUID()}`;
  return {
    id,
    conversationId: id,
    provider: "clock",
    event: "time.at",
    resource: "clock",
    params: { at },
    expiresAt: null,
    status: "armed",
    createdAt: "2026-07-14T10:00:00.000Z",
    armedAt: "2026-07-14T10:00:01.000Z",
    firedAt: null,
    lastError: null,
    deliverReason: null,
    deliverSnapshot: null,
  };
}

// Launch blocker fix (production finding, 2026-07-14): in connector mode,
// arm() must register the row in the durable due-time index instead of
// scheduling an in-process setTimeout — this is the whole fix. Proven by
// reading the index back via clock-redis.ts's own readDueClockSubscriptionIds,
// not by any in-process timer inspection (isTimerScheduled etc., which
// clock.test.ts's own in-process tests already cover and which connector
// mode never touches at all).
test("arm (connector mode) registers the subscription in the durable due-time index, not an in-process timer", async (t) => {
  const clockProvider = await loadConnectorModeClockProvider();
  const at = new Date(Date.now() + 5000).toISOString();
  const sub = makeSub(at);
  t.after(() => removeClockDue(sub.id));

  await clockProvider.arm(sub);

  const due = await readDueClockSubscriptionIds(new Date(at).getTime() + 1);
  assert.ok(due.includes(sub.id), "arm() in connector mode must register the row in the durable due-time index");
});

test("disarm (connector mode) removes the subscription from the durable due-time index", async () => {
  const clockProvider = await loadConnectorModeClockProvider();
  const at = new Date(Date.now() + 5000).toISOString();
  const sub = makeSub(at);

  await clockProvider.arm(sub);
  await clockProvider.disarm(sub);

  const due = await readDueClockSubscriptionIds(new Date(at).getTime() + 1);
  assert.ok(!due.includes(sub.id), "disarm() in connector mode must remove the row from the due-time index — no wake must ever fire for it");
});

// Codex-gate-shaped fail-closed check, matching alpaca-watcher-host.test.ts's
// own equivalent test — WATCHER_HOST must reject a set-but-wrong value
// rather than silently defaulting to "in-process".
test("WATCHER_HOST rejects a set-but-invalid value instead of defaulting to in-process", async () => {
  process.env.WATCHER_HOST = "CONNECTOR"; // case-mismatch typo, not the exact accepted string
  await assert.rejects(() => import(`./clock.ts?watcher-host-invalid=${Date.now()}`), /WATCHER_HOST="CONNECTOR" is invalid/);
});
