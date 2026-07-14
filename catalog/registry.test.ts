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
  getSubscriptions,
  listSubscriptions,
  listSubscriptionsByStatus,
  readDueExpirySubscriptionIds,
  recordConversation,
  tryTransitionToDelivering,
  updateSubscription,
} from "./registry.ts";

// Only used to peek at the raw reverse-index key below: getConversationBySessionId
// always chains through getConversation, so once a conversation record is
// gone, the chain returns null whether or not the reverse key itself was
// cleaned up — checking the key directly is the only way to catch a leak
// that's harmless today but would waste Redis storage over a long-running
// dev session. SUB_KEY is redefined here for the same reason (peeking at a
// record's own raw key, not exported from registry.ts) — see
// "listSubscriptions" tests below.
const redis = Redis.fromEnv();
const CONV_BY_SESSION_KEY = (sessionId: string) => `catalog:conv-by-session:${sessionId}`;
const SUB_KEY = (id: string) => `catalog:sub:${id}`;

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

// Task #33 (Redis command-burn reduction): listSubscriptions moved from an
// smembers + N-per-id GET fan-out to smembers + one MGET. These two tests
// pin the exact correctness contract that migration must preserve —
// written before the mget rewrite, run again unmodified after it.
test("listSubscriptions returns every subscription currently in the index", async (t) => {
  const a = await createSubscription({
    conversationId: testConversationId(),
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 150 },
    expiresAt: null,
  });
  const b = await createSubscription({
    conversationId: testConversationId(),
    provider: "edgar",
    event: "filing.new",
    resource: "AAPL",
    params: {},
    expiresAt: null,
  });
  t.after(() => Promise.all([deleteSubscription(a.id), deleteSubscription(b.id)]));

  const all = await listSubscriptions();
  const ids = new Set(all.map((s) => s.id));
  assert.ok(ids.has(a.id));
  assert.ok(ids.has(b.id));
});

// The index (SUB_INDEX_KEY, an sadd'd set) and each subscription's own
// record are two separate keys — deleteSubscription's own comment already
// notes it's a test-hygiene helper "not used by product code," so in real
// operation nothing ever removes an id from the index without also writing
// its record. This test simulates the state that WOULD result if it did
// (or if a record were manually DEL'd outside deleteSubscription): the
// current implementation's `.filter((sub): sub is Subscription => sub !==
// null)` silently drops it rather than throwing or returning a hole in the
// array — mget must preserve that exact behavior (real Redis MGET returns
// nil in the missing key's position, same shape as a missing GET).
test("listSubscriptions silently drops an index entry whose record no longer exists", async (t) => {
  const live = await createSubscription({
    conversationId: testConversationId(),
    provider: "alpaca",
    event: "price.crossesAbove",
    resource: "NVDA",
    params: { threshold: 200 },
    expiresAt: null,
  });
  const orphaned = await createSubscription({
    conversationId: testConversationId(),
    provider: "alpaca",
    event: "price.crossesAbove",
    resource: "TSLA",
    params: { threshold: 300 },
    expiresAt: null,
  });
  t.after(() => Promise.all([deleteSubscription(live.id), deleteSubscription(orphaned.id)]));

  // Deletes only the record, leaving `orphaned.id` behind in the index —
  // the exact "deleted id still in index" case, without deleteSubscription's
  // own index cleanup masking it.
  await redis.del(SUB_KEY(orphaned.id));

  const all = await listSubscriptions();
  const ids = new Set(all.map((s) => s.id));
  assert.ok(ids.has(live.id), "the live subscription must still be returned");
  assert.ok(!ids.has(orphaned.id), "the orphaned index entry must be silently dropped, not throw");
});

// getSubscriptions is listSubscriptions' underlying batched-by-id read,
// also reused by catalog/providers/expiry-sweep.ts's runExpirySweepTick
// (task #33 — that call site used to be one GET per due id).
test("getSubscriptions: order-preserving batch read, one MGET for the whole list", async (t) => {
  const a = await createSubscription({
    conversationId: testConversationId(),
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 150 },
    expiresAt: null,
  });
  const b = await createSubscription({
    conversationId: testConversationId(),
    provider: "edgar",
    event: "filing.new",
    resource: "AAPL",
    params: {},
    expiresAt: null,
  });
  t.after(() => Promise.all([deleteSubscription(a.id), deleteSubscription(b.id)]));

  const [first, second] = await getSubscriptions([a.id, b.id]);
  assert.equal(first?.id, a.id);
  assert.equal(second?.id, b.id);
});

test("getSubscriptions: a missing id comes back null in its own position, order preserved for the rest", async (t) => {
  const a = await createSubscription({
    conversationId: testConversationId(),
    provider: "alpaca",
    event: "price.crossesAbove",
    resource: "NVDA",
    params: { threshold: 200 },
    expiresAt: null,
  });
  t.after(() => deleteSubscription(a.id));

  const results = await getSubscriptions([a.id, "does-not-exist", a.id]);
  assert.equal(results[0]?.id, a.id);
  assert.equal(results[1], null);
  assert.equal(results[2]?.id, a.id);
});

test("getSubscriptions: an empty id list short-circuits without calling Redis", async () => {
  assert.deepEqual(await getSubscriptions([]), []);
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

// tryTransitionToDelivering replaces the old read-then-write updateSubscription
// pattern for the armed/pending -> delivering step: a plain read-then-write is
// not atomic, so a delayed caller's write (built from a stale read) could
// regress an already-terminal ("fired"/"expired"/"failed") subscription back
// to "delivering", or silently overwrite a deliverReason another caller had
// already established. One Lua EVAL makes "is this still transitionable?"
// and "transition it" a single atomic round trip.

test("tryTransitionToDelivering transitions an armed subscription to delivering and establishes deliverReason/deliverSnapshot", async (t) => {
  const conversationId = testConversationId();
  const sub = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 150 },
    expiresAt: null,
  });
  await updateSubscription(sub.id, { status: "armed", armedAt: new Date().toISOString() });
  t.after(() => deleteSubscription(sub.id));

  const transitioned = await tryTransitionToDelivering(sub.id, "fired", { price: 149.8 });

  assert.ok(transitioned);
  assert.equal(transitioned?.status, "delivering");
  assert.equal(transitioned?.deliverReason, "fired");
  assert.deepEqual(transitioned?.deliverSnapshot, { price: 149.8 });

  const stored = await getSubscription(sub.id);
  assert.deepEqual(stored, transitioned);
});

test("tryTransitionToDelivering refuses to transition a subscription that already reached a terminal status", async (t) => {
  const conversationId = testConversationId();
  const sub = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 150 },
    expiresAt: null,
  });
  await updateSubscription(sub.id, { status: "fired", firedAt: new Date().toISOString() });
  t.after(() => deleteSubscription(sub.id));

  const transitioned = await tryTransitionToDelivering(sub.id, "fired", null);

  assert.equal(transitioned, null);
  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "fired", "a terminal status must never be regressed back to delivering");
});

test("tryTransitionToDelivering refuses a second caller once a deliverReason is already established, without overwriting it", async (t) => {
  const conversationId = testConversationId();
  const sub = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 150 },
    expiresAt: null,
  });
  await updateSubscription(sub.id, { status: "armed", armedAt: new Date().toISOString() });
  t.after(() => deleteSubscription(sub.id));

  const first = await tryTransitionToDelivering(sub.id, "fired", { price: 149.8 });
  assert.ok(first);

  // A second, later caller (e.g. a delayed expiry timer racing the same
  // subscription) must not be able to establish a different reason, or
  // regress anything — this is the exact "B's slow write clobbers A's
  // established reason" race the atomic transition closes.
  const second = await tryTransitionToDelivering(sub.id, "expired", { price: 0 });
  assert.equal(second, null);

  const stored = await getSubscription(sub.id);
  assert.equal(stored?.deliverReason, "fired", "the first caller's reason must survive untouched");
  assert.deepEqual(stored?.deliverSnapshot, { price: 149.8 });
});

test("tryTransitionToDelivering: under real concurrency, exactly one of two racing callers with different reasons wins, and the loser never overwrites it", async (t) => {
  const conversationId = testConversationId();
  const sub = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 150 },
    expiresAt: null,
  });
  await updateSubscription(sub.id, { status: "armed", armedAt: new Date().toISOString() });
  t.after(() => deleteSubscription(sub.id));

  const [a, b] = await Promise.all([
    tryTransitionToDelivering(sub.id, "fired", { price: 149.8 }),
    tryTransitionToDelivering(sub.id, "expired", { price: 0 }),
  ]);

  const winners = [a, b].filter((r) => r !== null);
  assert.equal(winners.length, 1, "exactly one racing caller must win the transition");

  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "delivering");
  assert.equal(stored?.deliverReason, winners[0]?.deliverReason);
  assert.deepEqual(stored?.deliverSnapshot, winners[0]?.deliverSnapshot);
});

// Codex pass A''-1: the Lua decode/mutate/encode implementation round-trips
// data through cjson, which has two independent corruption modes on
// Upstash's actual Lua sandbox (not just contrived edge cases — proven live
// below): (1) lua-cjson decodes both `{}` and `[]` to the identical empty
// Lua table, and re-encodes an empty table as a JSON ARRAY by default — so
// an empty params/deliverSnapshot object silently becomes `[]`; (2) the
// NULL_MARKER gsub workaround for cjson's null-handling ran over the WHOLE
// encoded record, so any string value that happened to equal the marker
// would itself be corrupted into `null`. Both are eliminated structurally
// (not patched around) by never running the actual data through cjson at
// all — see tryTransitionToDelivering's CAS-based implementation.

test("tryTransitionToDelivering: an empty params/deliverSnapshot object survives the transition as an object, never an array", async (t) => {
  const conversationId = testConversationId();
  const sub = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: {},
    expiresAt: null,
  });
  await updateSubscription(sub.id, { status: "armed", armedAt: new Date().toISOString() });
  t.after(() => deleteSubscription(sub.id));

  const transitioned = await tryTransitionToDelivering(sub.id, "fired", {});

  assert.ok(transitioned);
  assert.ok(!Array.isArray(transitioned?.params), "params must stay an object, not become an array");
  assert.deepEqual(transitioned?.params, {});
  assert.ok(!Array.isArray(transitioned?.deliverSnapshot), "deliverSnapshot must stay an object, not become an array");
  assert.deepEqual(transitioned?.deliverSnapshot, {});

  const stored = await getSubscription(sub.id);
  assert.ok(!Array.isArray(stored?.params));
  assert.deepEqual(stored?.params, {});
  assert.ok(!Array.isArray(stored?.deliverSnapshot));
  assert.deepEqual(stored?.deliverSnapshot, {});
});

test("tryTransitionToDelivering: a params string value that happens to equal the old NULL_MARKER token survives untouched", async (t) => {
  const conversationId = testConversationId();
  const sub = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { note: "__catalog_null_marker__" },
    expiresAt: null,
  });
  await updateSubscription(sub.id, { status: "armed", armedAt: new Date().toISOString() });
  t.after(() => deleteSubscription(sub.id));

  const transitioned = await tryTransitionToDelivering(sub.id, "fired", null);

  assert.equal(
    transitioned?.params.note,
    "__catalog_null_marker__",
    "a data value that happens to collide with an internal marker token must never be corrupted",
  );

  const stored = await getSubscription(sub.id);
  assert.equal(stored?.params.note, "__catalog_null_marker__");
});

// Phase 3's expiry migration: the sorted-set index (dual-written inside
// writeSubscription) is the durable expiry sweep's own read side. These
// tests exercise it directly through the same public API every real caller
// uses (createSubscription/updateSubscription), never touching the ZSET
// key by hand, so a future change to the indexing rule is caught here too.
test("readDueExpirySubscriptionIds: an armed subscription with a past expiresAt is due; a future one is not", async (t) => {
  const conversationId = testConversationId();
  const past = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 150 },
    expiresAt: "2020-01-01T00:00:00.000Z",
  });
  t.after(() => deleteSubscription(past.id));
  await updateSubscription(past.id, { status: "armed", armedAt: new Date().toISOString() });

  const future = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 150 },
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  t.after(() => deleteSubscription(future.id));
  await updateSubscription(future.id, { status: "armed", armedAt: new Date().toISOString() });

  const due = await readDueExpirySubscriptionIds(Date.now());
  assert.ok(due.includes(past.id), "a subscription whose expiresAt is already past must be due");
  assert.ok(!due.includes(future.id), "a subscription whose expiresAt is still in the future must not be due");
});

test("readDueExpirySubscriptionIds: a pending (not yet armed) subscription with a past expiresAt is never due", async (t) => {
  const conversationId = testConversationId();
  const sub = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 150 },
    expiresAt: "2020-01-01T00:00:00.000Z",
  });
  t.after(() => deleteSubscription(sub.id));
  // Deliberately left "pending" — arming is what indexes it.

  const due = await readDueExpirySubscriptionIds(Date.now());
  assert.ok(!due.includes(sub.id), "an un-armed subscription must never appear as due, regardless of its expiresAt");
});

test("readDueExpirySubscriptionIds: an armed subscription with no expiresAt is never indexed at all", async (t) => {
  const conversationId = testConversationId();
  const sub = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 150 },
    expiresAt: null,
  });
  t.after(() => deleteSubscription(sub.id));
  await updateSubscription(sub.id, { status: "armed", armedAt: new Date().toISOString() });

  // Far in the future relative to any real clock — proves this isn't just
  // "not due yet," it's genuinely absent from the index.
  const due = await readDueExpirySubscriptionIds(Date.parse("2099-01-01T00:00:00.000Z"));
  assert.ok(!due.includes(sub.id));
});

test("readDueExpirySubscriptionIds: a subscription reaching a terminal status is removed from the index", async (t) => {
  const conversationId = testConversationId();
  const sub = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 150 },
    expiresAt: "2020-01-01T00:00:00.000Z",
  });
  t.after(() => deleteSubscription(sub.id));
  await updateSubscription(sub.id, { status: "armed", armedAt: new Date().toISOString() });

  assert.ok((await readDueExpirySubscriptionIds(Date.now())).includes(sub.id), "sanity check: indexed while armed");

  await updateSubscription(sub.id, { status: "expired", firedAt: new Date().toISOString() });

  const due = await readDueExpirySubscriptionIds(Date.now());
  assert.ok(!due.includes(sub.id), "a subscription that already reached a terminal status must not linger in the expiry index");
});
