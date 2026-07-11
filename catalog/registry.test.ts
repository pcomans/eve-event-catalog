import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  createSubscription,
  getConversation,
  getSubscription,
  listSubscriptionsByStatus,
  recordConversation,
  updateSubscription,
} from "./registry.ts";

// These tests hit a real Redis instance (Upstash, via UPSTASH_REDIS_REST_URL /
// UPSTASH_REDIS_REST_TOKEN) — no mocking, per the registry's job (survive
// hot-reload/restart). Each test uses a fresh conversationId so runs don't
// collide; test data is intentionally left behind (documented POC dev
// behavior, not a bug).

test("createSubscription then getSubscription round-trips a pending subscription", async () => {
  const conversationId = `test-${randomUUID()}`;
  const created = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 150 },
    once: true,
    expiresAt: null,
  });

  assert.equal(created.status, "pending");
  assert.equal(created.armedAt, null);
  assert.ok(created.id);
  assert.ok(created.createdAt);

  const fetched = await getSubscription(created.id);
  assert.deepEqual(fetched, created);
});

test("updateSubscription transitions status and persists lastError", async () => {
  const conversationId = `test-${randomUUID()}`;
  const sub = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "order.filled",
    resource: "order-123",
    params: {},
    once: true,
    expiresAt: null,
  });

  const armed = await updateSubscription(sub.id, { status: "armed", armedAt: new Date().toISOString() });
  assert.equal(armed.status, "armed");
  assert.ok(armed.armedAt);

  const failed = await updateSubscription(sub.id, { status: "failed", lastError: "unknown provider: alpaca" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.lastError, "unknown provider: alpaca");
  // Fields not in the patch survive the merge.
  assert.equal(failed.armedAt, armed.armedAt);
});

test("listSubscriptionsByStatus filters by conversation and status", async () => {
  const conversationId = `test-${randomUUID()}`;
  const otherConversationId = `test-${randomUUID()}`;

  const pending = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesAbove",
    resource: "NVDA",
    params: { threshold: 200 },
    once: true,
    expiresAt: null,
  });
  const armedInSameConversation = await createSubscription({
    conversationId,
    provider: "edgar",
    event: "filing.new",
    resource: "AAPL",
    params: {},
    once: true,
    expiresAt: null,
  });
  await updateSubscription(armedInSameConversation.id, { status: "armed" });

  await createSubscription({
    conversationId: otherConversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 100 },
    once: true,
    expiresAt: null,
  });

  const pendingForConversation = await listSubscriptionsByStatus(conversationId, "pending");
  assert.deepEqual(
    pendingForConversation.map((s) => s.id),
    [pending.id],
  );
});

test("recordConversation preserves the original startedAt across repeat calls", async () => {
  const conversationId = `test-${randomUUID()}`;

  const first = await recordConversation(conversationId, "session-a");
  const second = await recordConversation(conversationId, "session-a");

  assert.equal(first.startedAt, second.startedAt);

  const fetched = await getConversation(conversationId);
  assert.deepEqual(fetched, second);
});
