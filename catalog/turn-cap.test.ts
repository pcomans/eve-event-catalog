import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Redis } from "@upstash/redis";

import { incrementAndCheckTurnCap, isWithinTurnCap, readMaxTurnsPerDay, utcDateString } from "./turn-cap.ts";

// Pure logic — no Redis, always safe to run solo.

test("utcDateString formats a UTC date as YYYY-MM-DD", () => {
  assert.equal(utcDateString(new Date("2026-07-13T23:59:59.999Z")), "2026-07-13");
});

test("utcDateString rolls over exactly at UTC midnight", () => {
  assert.equal(utcDateString(new Date("2026-07-14T00:00:00.000Z")), "2026-07-14");
});

test("isWithinTurnCap allows counts at or below the limit", () => {
  assert.equal(isWithinTurnCap(5, 5), true);
  assert.equal(isWithinTurnCap(1, 5), true);
});

test("isWithinTurnCap rejects counts above the limit", () => {
  assert.equal(isWithinTurnCap(6, 5), false);
});

test("readMaxTurnsPerDay falls back to the default when unset", () => {
  assert.equal(readMaxTurnsPerDay({}), 200);
});

test("readMaxTurnsPerDay falls back to the default on a non-numeric value", () => {
  assert.equal(readMaxTurnsPerDay({ MAX_TURNS_PER_DAY: "not-a-number" }), 200);
});

test("readMaxTurnsPerDay falls back to the default on a non-positive value", () => {
  assert.equal(readMaxTurnsPerDay({ MAX_TURNS_PER_DAY: "0" }), 200);
  assert.equal(readMaxTurnsPerDay({ MAX_TURNS_PER_DAY: "-5" }), 200);
});

test("readMaxTurnsPerDay uses a configured positive value", () => {
  assert.equal(readMaxTurnsPerDay({ MAX_TURNS_PER_DAY: "42" }), 42);
});

// Real Redis integration tests below — each uses a fresh, randomly-scoped
// key (test:turn-cap:<uuid>:turns:<date>), never the "catalog" scope any
// live campaign counts turns against, and cleans up immediately in t.after.
// Touches no subscription/conversation/delivery key (catalog:sub:*,
// catalog:conv:*, the wake lease/marker keys) — a wholly separate namespace
// — so per the process rules this is safe to run solo (it can never put a
// subscription into "delivering").

test("incrementAndCheckTurnCap increments across calls and flips to disallowed once the limit is exceeded", async (t) => {
  const scope = `test:turn-cap:${randomUUID()}`;
  const redis = Redis.fromEnv();
  const now = new Date("2026-07-13T12:00:00.000Z");
  const key = `${scope}:turns:2026-07-13`;
  t.after(() => redis.del(key));

  const first = await incrementAndCheckTurnCap({ now, scope, limit: 2 });
  assert.deepEqual(first, { allowed: true, count: 1, limit: 2 });

  // TTL repair (fix round p4b, LOW): simulate a crash between an earlier
  // call's INCR and its EXPIRE by stripping the TTL PERSIST sets after the
  // count === 1 call above — under the old "only EXPIRE when count === 1"
  // code, nothing would ever repair this: every later call sees count > 1
  // and used to skip EXPIRE entirely, so a key that lost its TTL this way
  // stayed TTL-less forever. incrementAndCheckTurnCap now re-asserts the TTL
  // on every call, unconditionally.
  await redis.persist(key);
  assert.equal(await redis.ttl(key), -1, "PERSIST should have removed the TTL");

  const second = await incrementAndCheckTurnCap({ now, scope, limit: 2 });
  assert.deepEqual(second, { allowed: true, count: 2, limit: 2 });
  assert.ok(
    (await redis.ttl(key)) > 0,
    "TTL should be repaired by a call with count > 1, not just count === 1",
  );

  const third = await incrementAndCheckTurnCap({ now, scope, limit: 2 });
  assert.deepEqual(third, { allowed: false, count: 3, limit: 2 });
});

test("incrementAndCheckTurnCap scopes by UTC day — a new day starts its own counter", async (t) => {
  const scope = `test:turn-cap:${randomUUID()}`;
  const redis = Redis.fromEnv();
  const day1 = new Date("2026-07-13T23:59:59.000Z");
  const day2 = new Date("2026-07-14T00:00:01.000Z");
  t.after(async () => {
    await redis.del(`${scope}:turns:2026-07-13`);
    await redis.del(`${scope}:turns:2026-07-14`);
  });

  const a = await incrementAndCheckTurnCap({ now: day1, scope, limit: 1 });
  assert.equal(a.count, 1);

  const b = await incrementAndCheckTurnCap({ now: day2, scope, limit: 1 });
  assert.equal(b.count, 1); // fresh counter for the new UTC day, not carried over as 2
});

// Fix round p4b, MED: no real Redis involved here at all — a fake client
// that throws on every call, injected via the redisClient test seam, so this
// exercises the fail-open policy without needing to knock over the real
// (shared, live-campaign) Upstash instance to prove it.
test("incrementAndCheckTurnCap fails OPEN when the cap store errors — a store outage must never block a turn", async () => {
  const throwingClient = {
    incr: async () => {
      throw new Error("ECONNRESET (simulated)");
    },
    expire: async () => {
      throw new Error("ECONNRESET (simulated)");
    },
  };

  const result = await incrementAndCheckTurnCap({ redisClient: throwingClient, limit: 5 });
  assert.equal(result.allowed, true);
  assert.equal(result.degraded, true);
});
