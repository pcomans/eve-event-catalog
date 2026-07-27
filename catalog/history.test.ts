import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Redis } from "@upstash/redis";

import { computeCursor } from "./event-feed.ts";
import { fetchEventFeed, listEvents, recordEvent } from "./history.ts";

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

// listEvents/fetchEventFeed's cap and delta tests below push 100+ rows per
// test — too much noise to add to the shared production list (catalog:events)
// even under a test: conversationId, and the count itself would be
// meaningless there (other writers interleave). Both functions take an
// optional key precisely so these tests can point at a disposable list
// instead — same "test:" naming convention as registry.test.ts's
// testConversationId, just for a list key rather than a hash/set key.
const redis = Redis.fromEnv();
const testEventsKey = () => `test:events:${randomUUID()}`;

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

test("listEvents caps at 100 even when the list holds more", async (t) => {
  const key = testEventsKey();
  t.after(() => redis.del(key));

  for (let i = 0; i < 105; i++) {
    await recordEvent("arm", baseSub(), {}, key);
  }

  const events = await listEvents(key);
  assert.equal(events.length, 100);
});

test("fetchEventFeed: no after returns a full snapshot (reset true, cursor of the newest row)", async (t) => {
  const key = testEventsKey();
  t.after(() => redis.del(key));

  await recordEvent("arm", baseSub(), {}, key);
  await recordEvent("delivering", baseSub(), {}, key);

  const feed = await fetchEventFeed(null, key);

  assert.equal(feed.reset, true);
  assert.equal(feed.events.length, 2);
  assert.equal(feed.cursor, computeCursor(feed.events[0]));
});

test("fetchEventFeed: an unchanged cursor returns zero events via the LINDEX fast path", async (t) => {
  const key = testEventsKey();
  t.after(() => redis.del(key));

  await recordEvent("arm", baseSub(), {}, key);
  const snapshot = await fetchEventFeed(null, key);

  const unchanged = await fetchEventFeed(snapshot.cursor, key);

  assert.equal(unchanged.reset, false);
  assert.equal(unchanged.cursor, snapshot.cursor);
  assert.deepEqual(unchanged.events, []);
});

test("fetchEventFeed: rows appended after the last poll come back as the delta, newest-first", async (t) => {
  const key = testEventsKey();
  t.after(() => redis.del(key));

  await recordEvent("arm", baseSub(), {}, key);
  const snapshot = await fetchEventFeed(null, key);

  const second = baseSub();
  const third = baseSub();
  await recordEvent("arm", second, {}, key);
  await recordEvent("arm", third, {}, key);

  const delta = await fetchEventFeed(snapshot.cursor, key);

  assert.equal(delta.reset, false);
  assert.equal(delta.events.length, 2);
  assert.equal(delta.events[0].subscriptionId, third.id, "newest-first: the most recently appended row comes first");
  assert.equal(delta.events[1].subscriptionId, second.id);
});

test("fetchEventFeed: a cursor no longer present in the window (trimmed away) resets instead of silently skipping rows", async (t) => {
  const key = testEventsKey();
  t.after(() => redis.del(key));

  const staleCursor = computeCursor({
    action: "arm",
    timestamp: "2020-01-01T00:00:00.000Z",
    subscriptionId: "sub:never-existed",
    conversationId: "test:never-existed",
    provider: "alpaca",
    event: "price.crossesBelow",
    status: "armed",
  });

  await recordEvent("arm", baseSub(), {}, key);

  const feed = await fetchEventFeed(staleCursor, key);

  assert.equal(feed.reset, true);
  assert.equal(feed.events.length, 1);
});

test("fetchEventFeed: an empty list returns cursor null and no events", async (t) => {
  const key = testEventsKey();
  t.after(() => redis.del(key));

  const feed = await fetchEventFeed(null, key);

  assert.deepEqual(feed, { cursor: null, reset: true, events: [] });
});
