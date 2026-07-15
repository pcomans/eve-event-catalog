import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Redis } from "@upstash/redis";

import { addClockDue, readDueClockSubscriptionIds, removeClockDue } from "./clock-redis.ts";

// Real Redis (no mocking) — same convention as gap-replay-cursor.test.ts.
// Each test uses its own randomUUID-suffixed fake subscription id so
// concurrent runs never collide, and cleans its own key up.
//
// p6g gate (LOW, clock-redis.test.ts:18): every assertion below is scoped
// to includes/excludes of each test's OWN fixture id(s), never a whole-
// ZRANGE deepEqual — catalog:clock-due is a shared production/test sorted
// set, and a legitimate real or concurrently-running-test due row must
// never make this suite flaky (same convention clock-watcher-host.test.ts
// already uses).
const redis = Redis.fromEnv();
const CLOCK_DUE_KEY = "catalog:clock-due";
const fakeSubId = () => `test:${randomUUID()}`;

test("readDueClockSubscriptionIds: an id never registered is never due", async () => {
  const id = fakeSubId();
  const due = await readDueClockSubscriptionIds(Date.now() + 1_000_000);
  assert.ok(!due.includes(id), "an id that was never added must never appear as due");
  // Sanity: confirms this test's own id genuinely isn't lurking in the
  // shared index from a prior run — not just an empty-index coincidence.
  assert.equal(await redis.zscore(CLOCK_DUE_KEY, id), null);
});

test("addClockDue then readDueClockSubscriptionIds: due at-or-before nowMs, not due strictly after", async (t) => {
  const id = fakeSubId();
  t.after(() => removeClockDue(id));

  const atMs = Date.now() + 5000;
  await addClockDue(id, atMs);

  assert.ok(!(await readDueClockSubscriptionIds(atMs - 1)).includes(id), "not yet due one ms before its own at-time");
  assert.ok((await readDueClockSubscriptionIds(atMs)).includes(id), "due exactly at its own at-time");
  assert.ok((await readDueClockSubscriptionIds(atMs + 1)).includes(id), "still due after its own at-time");
});

test("removeClockDue: removes the id from the due index; a redundant remove is a harmless no-op", async () => {
  const id = fakeSubId();
  const atMs = Date.now() + 5000;
  await addClockDue(id, atMs);

  await removeClockDue(id);
  assert.ok(!(await readDueClockSubscriptionIds(atMs + 1)).includes(id));

  // Removing an id that's already gone must not throw.
  await assert.doesNotReject(() => removeClockDue(id));
});

test("readDueClockSubscriptionIds: multiple due ids at different times all come back once due", async (t) => {
  const earlyId = fakeSubId();
  const lateId = fakeSubId();
  t.after(() => Promise.all([removeClockDue(earlyId), removeClockDue(lateId)]));

  const now = Date.now();
  await addClockDue(earlyId, now + 1000);
  await addClockDue(lateId, now + 5000);

  const due = await readDueClockSubscriptionIds(now + 5000);
  assert.ok(due.includes(earlyId) && due.includes(lateId), "both fixtures must be present among whatever else is due");
});
