import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  createSubscription,
  deleteConversation,
  deleteSubscription,
  getConversation,
  getSubscription,
  listSubscriptionsByStatus,
  recordConversation,
  updateSubscription,
} from "./registry.ts";

// These tests hit a real Redis instance (Upstash, via UPSTASH_REDIS_REST_URL /
// UPSTASH_REDIS_REST_TOKEN) — no mocking, per the registry's job (survive
// hot-reload/restart). Every conversationId/subscription this file creates
// is namespaced "test:" and deleted in a t.after() hook, so a human reading
// `GET /catalog/subscriptions` on a shared dev Redis doesn't wade through
// leftover test rows.
const testConversationId = () => `test:${randomUUID()}`;

test("createSubscription then getSubscription round-trips a pending subscription", async (t) => {
  const conversationId = testConversationId();
  const created = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 150 },
    expiresAt: null,
  });
  t.after(() => deleteSubscription(created.id));

  assert.equal(created.status, "pending");
  assert.equal(created.armedAt, null);
  assert.ok(created.id);
  assert.ok(created.createdAt);

  const fetched = await getSubscription(created.id);
  assert.deepEqual(fetched, created);
});

test("updateSubscription transitions status and persists lastError", async (t) => {
  const conversationId = testConversationId();
  const sub = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "order.filled",
    resource: "order-123",
    params: {},
    expiresAt: null,
  });
  t.after(() => deleteSubscription(sub.id));

  const armed = await updateSubscription(sub.id, { status: "armed", armedAt: new Date().toISOString() });
  assert.equal(armed.status, "armed");
  assert.ok(armed.armedAt);

  const failed = await updateSubscription(sub.id, { status: "failed", lastError: "unknown provider: alpaca" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.lastError, "unknown provider: alpaca");
  // Fields not in the patch survive the merge.
  assert.equal(failed.armedAt, armed.armedAt);
});

test("listSubscriptionsByStatus filters by conversation and status", async (t) => {
  const conversationId = testConversationId();
  const otherConversationId = testConversationId();

  const pending = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesAbove",
    resource: "NVDA",
    params: { threshold: 200 },
    expiresAt: null,
  });
  const armedInSameConversation = await createSubscription({
    conversationId,
    provider: "edgar",
    event: "filing.new",
    resource: "AAPL",
    params: {},
    expiresAt: null,
  });
  await updateSubscription(armedInSameConversation.id, { status: "armed" });

  const otherConversationSub = await createSubscription({
    conversationId: otherConversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 100 },
    expiresAt: null,
  });

  t.after(() =>
    Promise.all([
      deleteSubscription(pending.id),
      deleteSubscription(armedInSameConversation.id),
      deleteSubscription(otherConversationSub.id),
    ]),
  );

  const pendingForConversation = await listSubscriptionsByStatus(conversationId, "pending");
  assert.deepEqual(
    pendingForConversation.map((s) => s.id),
    [pending.id],
  );
});

test("recordConversation preserves the original startedAt across repeat calls", async (t) => {
  const conversationId = testConversationId();
  t.after(() => deleteConversation(conversationId));

  const first = await recordConversation(conversationId, "session-a");
  const second = await recordConversation(conversationId, "session-a");

  assert.equal(first.startedAt, second.startedAt);

  const fetched = await getConversation(conversationId);
  assert.deepEqual(fetched, second);
});
