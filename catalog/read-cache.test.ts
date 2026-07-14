import assert from "node:assert/strict";
import { test } from "node:test";

import { createCachedReader } from "./read-cache.ts";

function fakeClock(startMs: number) {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("createCachedReader: first read calls fetchFresh and returns its result", async () => {
  let calls = 0;
  const read = createCachedReader(async () => {
    calls += 1;
    return "fresh";
  }, 2000);

  assert.equal(await read(), "fresh");
  assert.equal(calls, 1);
});

test("createCachedReader: a second read within the TTL reuses the cached value, no second fetch", async () => {
  let calls = 0;
  const clock = fakeClock(0);
  const read = createCachedReader(
    async () => {
      calls += 1;
      return `fetch-${calls}`;
    },
    2000,
    clock.now,
  );

  assert.equal(await read(), "fetch-1");
  clock.advance(1999); // still inside the 2000ms TTL
  assert.equal(await read(), "fetch-1", "must still be the cached value");
  assert.equal(calls, 1, "fetchFresh must not be called a second time inside the TTL");
});

test("createCachedReader: a read AT/after the TTL boundary fetches fresh again", async () => {
  let calls = 0;
  const clock = fakeClock(0);
  const read = createCachedReader(
    async () => {
      calls += 1;
      return `fetch-${calls}`;
    },
    2000,
    clock.now,
  );

  assert.equal(await read(), "fetch-1");
  clock.advance(2000); // exactly at the TTL boundary — must count as stale, not fresh
  assert.equal(await read(), "fetch-2");
  assert.equal(calls, 2);
});

test("createCachedReader: independent readers never share state", async () => {
  let callsA = 0;
  let callsB = 0;
  const readA = createCachedReader(async () => {
    callsA += 1;
    return "a";
  }, 2000);
  const readB = createCachedReader(async () => {
    callsB += 1;
    return "b";
  }, 2000);

  await readA();
  await readA();
  await readB();

  assert.equal(callsA, 1);
  assert.equal(callsB, 1);
});
