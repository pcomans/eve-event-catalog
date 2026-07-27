import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Redis } from "@upstash/redis";

import { computeCursor } from "./event-feed.ts";
import { fetchEventFeed, listEvents, recordEvent } from "./history.ts";

// These tests hit real Redis (Upstash) — see the disposable-key contract
// below (testEventsKey) before assuming otherwise. Every entry carries a
// unique randomUUID subscriptionId, so — like registry.test.ts — assertions
// find that one entry within a key rather than asserting exact list
// contents/length.
const baseSub = () => ({
  id: `sub:${randomUUID()}`,
  conversationId: `test:${randomUUID()}`,
  provider: "alpaca",
  event: "price.crossesBelow",
  status: "armed" as const,
});

// Every test in this file uses a disposable "test:events:<uuid>" list key,
// deleted in a t.after() hook — none of them may read or write the shared
// production list (catalog:events), which the live campaign appends to and
// which the recovery sweep etc. also depend on being in a known state.
// Gate finding (MEDIUM, history.test.ts:33): earlier revisions of this file
// left five tests on the real key by omitting it; recordEvent/listEvents/
// fetchEventFeed's optional `key` param (defaulting to the real HISTORY_KEY
// only in production call sites) exists precisely so every test here can
// avoid that.
const redis = Redis.fromEnv();
const testEventsKey = () => `test:events:${randomUUID()}`;

test("recordEvent appends an entry that listEvents can find by subscriptionId", async (t) => {
  const key = testEventsKey();
  t.after(() => redis.del(key));

  const sub = baseSub();
  await recordEvent("arm", sub, {}, key);

  const events = await listEvents(key);
  const found = events.find((e) => e.subscriptionId === sub.id);

  assert.ok(found, "recorded entry should be findable in listEvents()");
  assert.equal(found?.action, "arm");
  assert.equal(found?.conversationId, sub.conversationId);
  assert.equal(found?.provider, sub.provider);
  assert.equal(found?.event, sub.event);
  assert.equal(found?.status, sub.status);
  assert.ok(found?.timestamp);
  assert.ok(found?.id, "recordEvent must mint a per-occurrence id");
});

test("recordEvent folds extra fields (e.g. reason, error) into the entry", async (t) => {
  const key = testEventsKey();
  t.after(() => redis.del(key));

  const sub = baseSub();
  await recordEvent("deliver-failed", sub, { error: "wake POST 500: boom" }, key);

  const events = await listEvents(key);
  const found = events.find((e) => e.subscriptionId === sub.id);

  assert.equal(found?.error, "wake POST 500: boom");
});

test("listEvents returns newest-first: the most recently recorded entry for a subscription comes before an earlier one", async (t) => {
  const key = testEventsKey();
  t.after(() => redis.del(key));

  const sub = baseSub();
  await recordEvent("arm", sub, {}, key);
  await recordEvent("delivering", sub, {}, key);
  await recordEvent("deliver", sub, {}, key);

  const events = await listEvents(key);
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

test("recordEvent: extra cannot shadow the canonical fields (subscriptionId, status, etc.) — same shadowing discipline as buildWakeEnvelope", async (t) => {
  const key = testEventsKey();
  t.after(() => redis.del(key));

  const sub = baseSub();
  await recordEvent(
    "deliver",
    sub,
    { subscriptionId: "spoofed", status: "fired-by-attacker", action: "spoofed-action", id: "spoofed-id" },
    key,
  );

  const events = await listEvents(key);
  const found = events.find((e) => e.subscriptionId === sub.id);

  assert.ok(found, "the real subscriptionId must still be findable — extra must not have overwritten it");
  assert.equal(found?.status, sub.status, "extra.status must not shadow the real canonical status");
  assert.equal(found?.action, "deliver", "extra.action must not shadow the real action argument");
  assert.notEqual(found?.id, "spoofed-id", "extra.id must not shadow the real minted id");
});

test("recordEvent entries never contain a guidance field — the history stream is observability, not a wake-guidance channel", async (t) => {
  const key = testEventsKey();
  t.after(() => redis.del(key));

  const sub = baseSub();
  await recordEvent("deliver", sub, { reason: "fired" }, key);

  const events = await listEvents(key);
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
    id: randomUUID(),
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

// Gate finding (HIGH, catalog/history.ts:95), accepted-semantics half: a
// Redis-level retry of the exact same LPUSH re-sends the literal same
// stored row (including its id), producing a genuine byte-identical
// duplicate at the head of the list. That must be indistinguishable from
// "nothing changed" — it IS the same occurrence, not a new one — so the
// LINDEX fast path is expected to treat it as unchanged. This simulates the
// retry directly (re-pushing the already-stored row) rather than calling
// recordEvent again, which would mint a fresh id and a genuinely new
// occurrence instead.
test("fetchEventFeed: a byte-identical duplicate head (same id, simulating a retried LPUSH) is treated as unchanged", async (t) => {
  const key = testEventsKey();
  t.after(() => redis.del(key));

  await recordEvent("arm", baseSub(), {}, key);
  const snapshot = await fetchEventFeed(null, key);

  const [storedRow] = await listEvents(key);
  await redis.lpush(key, storedRow); // re-push the SAME row object — a true byte-identical duplicate

  const feed = await fetchEventFeed(snapshot.cursor, key);

  assert.equal(feed.reset, false);
  assert.deepEqual(feed.events, []);
});

test("fetchEventFeed: an empty list returns cursor null and no events", async (t) => {
  const key = testEventsKey();
  t.after(() => redis.del(key));

  const feed = await fetchEventFeed(null, key);

  assert.deepEqual(feed, { cursor: null, reset: true, events: [] });
});
