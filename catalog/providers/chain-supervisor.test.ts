import assert from "node:assert/strict";
import { test } from "node:test";

import { isChainDead } from "./chain-supervisor.ts";

test("isChainDead: no heartbeat ever recorded counts as dead (bootstrap case)", () => {
  assert.equal(isChainDead(null, Date.now(), 20 * 60 * 1000), true);
});

test("isChainDead: a fresh heartbeat, well within tolerance, counts as alive", () => {
  const now = Date.now();
  const heartbeat = now - 5 * 60 * 1000; // 5 minutes ago
  assert.equal(isChainDead(heartbeat, now, 20 * 60 * 1000), false);
});

test("isChainDead: a heartbeat exactly at the staleness boundary counts as alive (strict greater-than, not >=)", () => {
  const now = Date.now();
  const staleAfterMs = 20 * 60 * 1000;
  const heartbeat = now - staleAfterMs;
  assert.equal(isChainDead(heartbeat, now, staleAfterMs), false);
});

test("isChainDead: a heartbeat older than the staleness window counts as dead", () => {
  const now = Date.now();
  const staleAfterMs = 20 * 60 * 1000;
  const heartbeat = now - staleAfterMs - 1;
  assert.equal(isChainDead(heartbeat, now, staleAfterMs), true);
});
