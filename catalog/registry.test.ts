import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Redis } from "@upstash/redis";

import {
  createSubscription,
  deleteConversation,
  deleteSubscription,
  getConversation,
  getConversationBySessionId,
  getSubscription,
  listSubscriptionsByStatus,
  recordConversation,
  updateSubscription,
} from "./registry.ts";

// Only used to peek at the raw reverse-index key below: getConversationBySessionId
// always chains through getConversation, so once a conversation record is
// gone, the chain returns null whether or not the reverse key itself was
// cleaned up — checking the key directly is the only way to catch a leak
// that's harmless today but would waste Redis storage over a long-running
// dev session.
const redis = Redis.fromEnv();
const CONV_BY_SESSION_KEY = (sessionId: string) => `catalog:conv-by-session:${sessionId}`;

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

// Tools only ever see ctx.session.id (the eve sessionId), never the
// conversationId subscriptions are keyed by (eve's ToolContext has no
// continuationToken accessor). This reverse index is how subscribe_event
// recovers its own conversationId.
test("getConversationBySessionId recovers the conversation record from the eve sessionId", async (t) => {
  const conversationId = testConversationId();
  const sessionId = `session:${randomUUID()}`;
  t.after(() => deleteConversation(conversationId));

  const recorded = await recordConversation(conversationId, sessionId);
  const bySession = await getConversationBySessionId(sessionId);

  assert.deepEqual(bySession, recorded);
});

test("getConversationBySessionId returns null for an unknown session id", async () => {
  const result = await getConversationBySessionId(`session:${randomUUID()}`);
  assert.equal(result, null);
});

test("deleteConversation also removes the reverse sessionId index", async () => {
  const conversationId = testConversationId();
  const sessionId = `session:${randomUUID()}`;

  await recordConversation(conversationId, sessionId);
  await deleteConversation(conversationId);

  assert.equal(await getConversation(conversationId), null);
  assert.equal(await getConversationBySessionId(sessionId), null);
  // The chain above returns null either way once the forward record is
  // gone (see comment on the redis import) — check the raw key too, or this
  // test can't tell "cleaned up" from "merely orphaned".
  assert.equal(await redis.get(CONV_BY_SESSION_KEY(sessionId)), null);
});

// recordConversation is called on every /catalog/chat POST for a
// conversationId, including a resumed conversation whose eve sessionId
// changed. Without cleanup, the old sessionId's reverse-index entry would
// dangle forever, resolving to a conversationId whose current sessionId no
// longer matches it.
test("recordConversation with a new sessionId drops the stale reverse index for the old one", async (t) => {
  const conversationId = testConversationId();
  const oldSessionId = `session:${randomUUID()}`;
  const newSessionId = `session:${randomUUID()}`;
  t.after(() => deleteConversation(conversationId));

  await recordConversation(conversationId, oldSessionId);
  const updated = await recordConversation(conversationId, newSessionId);

  assert.equal(await getConversationBySessionId(oldSessionId), null);
  assert.deepEqual(await getConversationBySessionId(newSessionId), updated);
});
