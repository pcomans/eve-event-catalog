import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Redis } from "@upstash/redis";

import { acquireFenceToken, fencedSet, getCurrentFenceToken, isFencedWriteAllowed } from "./fence-redis.ts";

// Real Redis (no mocking) — same "test:"-namespaced, t.after()-cleaned
// convention as registry.test.ts. Each test mints its own streamId so
// concurrent test runs (or a re-run before cleanup lands) never share a
// counter.
const redis = Redis.fromEnv();
const testStreamId = () => `test:fence:${randomUUID()}`;

test("getCurrentFenceToken: a never-fenced stream reads as 0", async () => {
  const streamId = testStreamId();
  assert.equal(await getCurrentFenceToken(streamId), 0);
});

test("acquireFenceToken: real Redis INCR mints a strictly increasing sequence", async (t) => {
  const streamId = testStreamId();
  t.after(() => redis.del(`catalog:fence:${streamId}`));

  assert.equal(await acquireFenceToken(streamId), 1);
  assert.equal(await acquireFenceToken(streamId), 2);
  assert.equal(await acquireFenceToken(streamId), 3);
  assert.equal(await getCurrentFenceToken(streamId), 3);
});

// Codex gate finding: the sequential test above never actually exercises
// concurrent acquisition — three awaited calls in a row prove ordering
// under NO contention, not uniqueness UNDER it. Firing many acquisitions
// at once (real concurrent Redis INCRs) and checking the returned token
// set is exactly {1..N} with no repeats is what actually tests the
// "strictly increasing, one holder per token" guarantee INCR is relied on
// for.
test("acquireFenceToken: concurrent acquisitions never collide — every token in {1..N} is issued exactly once", async (t) => {
  const streamId = testStreamId();
  t.after(() => redis.del(`catalog:fence:${streamId}`));

  const CONCURRENT_ACQUISITIONS = 20;
  const tokens = await Promise.all(Array.from({ length: CONCURRENT_ACQUISITIONS }, () => acquireFenceToken(streamId)));

  assert.equal(new Set(tokens).size, CONCURRENT_ACQUISITIONS, "every concurrently-acquired token must be unique");
  assert.deepEqual(
    [...tokens].sort((a, b) => a - b),
    Array.from({ length: CONCURRENT_ACQUISITIONS }, (_, i) => i + 1),
    "the token set must be exactly {1..N}, with no gaps or repeats",
  );
  assert.equal(await getCurrentFenceToken(streamId), CONCURRENT_ACQUISITIONS);
});

// Correctness prerequisite 2's own named scenario, this time against REAL
// Redis INCR tokens rather than the pure fenced-lease.ts decision functions
// directly: "a 'zombie' holder resuming after lease expiry cannot deliver
// or corrupt state."
test("isFencedWriteAllowed: a zombie holder's real INCR token is rejected once a newer holder has acquired the stream", async (t) => {
  const streamId = testStreamId();
  t.after(() => redis.del(`catalog:fence:${streamId}`));

  const holderAToken = await acquireFenceToken(streamId);
  assert.equal(await isFencedWriteAllowed(streamId, holderAToken), true, "A's write is valid while A is still current");

  // B reconnects (A's session is still alive but unaware it's been
  // superseded — a delayed reconnect, a stalled event loop).
  const holderBToken = await acquireFenceToken(streamId);

  assert.equal(
    await isFencedWriteAllowed(streamId, holderAToken),
    false,
    "A's now-stale token must be rejected even though it was once valid",
  );
  assert.equal(await isFencedWriteAllowed(streamId, holderBToken), true, "B's current token is honored");
});

// Codex gate finding: a check-then-act (isFencedWriteAllowed followed by a
// separate write) leaves a real race window. fencedSet closes it by making
// the check and the write one atomic Redis round trip (a single EVAL,
// guaranteed atomic by Redis's own single-threaded script execution).
// Honest limitation: the tests below verify fencedSet's OBSERVABLE
// behavior at each boundary (stale token never writes, current token does)
// — they run sequentially and can't manufacture genuine concurrent
// interleaving, so they cannot themselves distinguish "atomic Lua CAS" from
// a hypothetical check-then-act with no delay between the two calls. The
// atomicity guarantee itself rests on using ONE redis.eval() call rather
// than two separate round trips, not on anything these tests can race.
test("fencedSet: writes through when writeToken is still current", async (t) => {
  const streamId = testStreamId();
  const key = `test:fencedSet:${randomUUID()}`;
  t.after(() => Promise.all([redis.del(`catalog:fence:${streamId}`), redis.del(key)]));

  const token = await acquireFenceToken(streamId);
  const wrote = await fencedSet(streamId, token, key, { hello: "world" });

  assert.equal(wrote, true);
  assert.deepEqual(await redis.get(key), { hello: "world" });
});

test("fencedSet: a zombie's write is skipped once a newer holder has acquired the stream — the key is never touched", async (t) => {
  const streamId = testStreamId();
  const key = `test:fencedSet:${randomUUID()}`;
  t.after(() => Promise.all([redis.del(`catalog:fence:${streamId}`), redis.del(key)]));

  const holderAToken = await acquireFenceToken(streamId);
  await acquireFenceToken(streamId); // B supersedes A

  const wrote = await fencedSet(streamId, holderAToken, key, { hello: "stale" });

  assert.equal(wrote, false, "a zombie's fencedSet must report that it did NOT write");
  assert.equal(await redis.get(key), null, "the key must be untouched — not overwritten with stale data");
});

// The exact race Codex flagged: a newer token is acquired IN BETWEEN a
// stale holder's check and its write — fencedSet must not be fooled by
// having read a "current" token a moment ago; it re-checks atomically at
// write time.
test("fencedSet: a token that goes stale AFTER acquisition but BEFORE the write is still rejected", async (t) => {
  const streamId = testStreamId();
  const key = `test:fencedSet:${randomUUID()}`;
  t.after(() => Promise.all([redis.del(`catalog:fence:${streamId}`), redis.del(key)]));

  const holderAToken = await acquireFenceToken(streamId);
  assert.equal(await isFencedWriteAllowed(streamId, holderAToken), true, "A looked current at this moment");

  // A newer holder acquires BEFORE A's write actually lands.
  await acquireFenceToken(streamId);

  const wrote = await fencedSet(streamId, holderAToken, key, { hello: "stale" });
  assert.equal(wrote, false);
  assert.equal(await redis.get(key), null);
});
