import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { listEvents, recordEvent } from "./history.ts";

// These tests hit the real Redis history list (catalog:events) — the same
// list the running dev server appends to — so, like registry.test.ts, every
// entry here carries a unique randomUUID subscriptionId and assertions find
// that one entry rather than asserting exact list contents/length.
const baseSub = () => ({
  id: `sub:${randomUUID()}`,
  conversationId: `test:${randomUUID()}`,
  provider: "alpaca",
  event: "price.crossesBelow",
  status: "armed" as const,
});

test("recordEvent appends an entry that listEvents can find by subscriptionId", async () => {
  const sub = baseSub();
  await recordEvent("arm", sub);

  const events = await listEvents();
  const found = events.find((e) => e.subscriptionId === sub.id);

  assert.ok(found, "recorded entry should be findable in listEvents()");
  assert.equal(found?.action, "arm");
  assert.equal(found?.conversationId, sub.conversationId);
  assert.equal(found?.provider, sub.provider);
  assert.equal(found?.event, sub.event);
  assert.equal(found?.status, sub.status);
  assert.ok(found?.timestamp);
});

test("recordEvent folds extra fields (e.g. reason, error) into the entry", async () => {
  const sub = baseSub();
  await recordEvent("deliver-failed", sub, { error: "wake POST 500: boom" });

  const events = await listEvents();
  const found = events.find((e) => e.subscriptionId === sub.id);

  assert.equal(found?.error, "wake POST 500: boom");
});

test("listEvents returns newest-first: the most recently recorded entry for a subscription comes before an earlier one", async () => {
  const sub = baseSub();
  await recordEvent("arm", sub);
  await recordEvent("delivering", sub);
  await recordEvent("deliver", sub);

  const events = await listEvents();
  const indices = events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.subscriptionId === sub.id)
    .map(({ e, i }) => ({ action: e.action, i }));

  const armIndex = indices.find((x) => x.action === "arm")!.i;
  const deliveringIndex = indices.find((x) => x.action === "delivering")!.i;
  const deliverIndex = indices.find((x) => x.action === "deliver")!.i;

  assert.ok(deliverIndex < deliveringIndex, "deliver (recorded last) should appear before delivering");
  assert.ok(deliveringIndex < armIndex, "delivering should appear before arm (recorded first)");
});

test("recordEvent: extra cannot shadow the canonical fields (subscriptionId, status, etc.) — same shadowing discipline as buildWakeEnvelope", async () => {
  const sub = baseSub();
  await recordEvent("deliver", sub, { subscriptionId: "spoofed", status: "fired-by-attacker", action: "spoofed-action" });

  const events = await listEvents();
  const found = events.find((e) => e.subscriptionId === sub.id);

  assert.ok(found, "the real subscriptionId must still be findable — extra must not have overwritten it");
  assert.equal(found?.status, sub.status, "extra.status must not shadow the real canonical status");
  assert.equal(found?.action, "deliver", "extra.action must not shadow the real action argument");
});

test("recordEvent entries never contain a guidance field — the history stream is observability, not a wake-guidance channel", async () => {
  const sub = baseSub();
  await recordEvent("deliver", sub, { reason: "fired" });

  const events = await listEvents();
  const found = events.find((e) => e.subscriptionId === sub.id);

  assert.equal(found?.guidance, undefined);
});
