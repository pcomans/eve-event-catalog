import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Redis } from "@upstash/redis";

import { claimChain, claimSupervisorLock, readHeartbeat, recordHeartbeat } from "./chain-guard.ts";
import { isChainDead } from "./chain-supervisor.ts";

// Real Redis (no mocking) — same "test:"-namespaced, t.after()-cleaned
// convention as registry.test.ts. Each test uses its own runNonce/workflow
// name so concurrent runs never share a claim or heartbeat key.
const redis = Redis.fromEnv();
const testNonce = () => `test:${randomUUID()}`;
const testWorkflowName = () => `test:${randomUUID()}`;

// KNOWN_ISSUES.md #15's own scenario, this time against a real Redis SET NX:
// the first attempt to chain a run claims and must proceed; ANY retry of
// that same step (same runNonce) must find the claim already taken and skip
// start() entirely — this is what turns "4 retries forked 4 runs" into
// at-most-once chaining.
test("claimChain: the first claim for a runNonce wins; a retry of the same run's chaining step is skipped", async (t) => {
  const runNonce = testNonce();
  t.after(() => redis.del(`connector:chained:${runNonce}`));

  const firstAttempt = await claimChain(runNonce);
  assert.equal(firstAttempt, true, "the first attempt to chain this run must win the claim");

  // A retry of the SAME step (the step threw after start() already
  // succeeded, e.g. the serialization bug KNOWN_ISSUES.md #15 describes) —
  // must NOT win a second time, or it would call start() again and fork a
  // duplicate forever-chain.
  const retryAttempt = await claimChain(runNonce);
  assert.equal(retryAttempt, false, "a retry must find the claim already taken and skip start()");

  // A third, later retry must still be rejected — the claim isn't
  // single-use-then-reopened, it's permanent for this run's lifetime.
  const thirdAttempt = await claimChain(runNonce);
  assert.equal(thirdAttempt, false);
});

test("claimChain: two DIFFERENT runs (different runNonce) never contend with each other", async (t) => {
  const nonceA = testNonce();
  const nonceB = testNonce();
  t.after(() => Promise.all([redis.del(`connector:chained:${nonceA}`), redis.del(`connector:chained:${nonceB}`)]));

  assert.equal(await claimChain(nonceA), true);
  assert.equal(await claimChain(nonceB), true, "a different run's own claim must be independent");
});

test("recordHeartbeat then readHeartbeat round-trips through real Redis, and isChainDead reads it as alive", async (t) => {
  const workflowName = testWorkflowName();
  t.after(() => redis.del(`connector:heartbeat:${workflowName}`));

  const staleAfterMs = 20 * 60 * 1000;
  const before = Date.now();
  await recordHeartbeat(workflowName, staleAfterMs);
  const after = Date.now();

  const heartbeat = await readHeartbeat(workflowName);
  assert.ok(heartbeat !== null);
  assert.ok(heartbeat! >= before && heartbeat! <= after, "the recorded heartbeat must be a real, current timestamp");
  assert.equal(isChainDead(heartbeat, Date.now(), staleAfterMs), false, "a heartbeat recorded moments ago must read as alive");
});

// The "stale claim" scenario the supervisor exists for: nothing has
// recorded a heartbeat in a very long time (or ever) — the chain must be
// considered dead so the supervisor knows to bootstrap a fresh one.
test("readHeartbeat + isChainDead: a workflow that never recorded a heartbeat reads as dead (bootstrap case)", async () => {
  const heartbeat = await readHeartbeat(testWorkflowName()); // never written
  assert.equal(heartbeat, null);
  assert.equal(isChainDead(heartbeat, Date.now(), 20 * 60 * 1000), true);
});

test("readHeartbeat + isChainDead: a heartbeat written far enough in the past reads as dead", async (t) => {
  const workflowName = testWorkflowName();
  t.after(() => redis.del(`connector:heartbeat:${workflowName}`));

  const staleAfterMs = 1000; // 1s tolerance, so a real elapsed delay proves staleness without a slow test
  await recordHeartbeat(workflowName, staleAfterMs);
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const heartbeat = await readHeartbeat(workflowName);
  assert.equal(isChainDead(heartbeat, Date.now(), staleAfterMs), true, "a heartbeat older than the staleness window must read as dead");
});

// p2v Codex gate finding 7: two concurrent supervisor invocations for the
// SAME workflow (e.g. overlapping Cron fires) must not both decide to act
// — exactly one wins the lock.
test("claimSupervisorLock: the first claim for a workflow wins; a concurrent second claim is rejected", async (t) => {
  const workflowName = testWorkflowName();
  t.after(() => redis.del(`connector:supervisor-lock:${workflowName}`));

  const [first, second] = await Promise.all([claimSupervisorLock(workflowName), claimSupervisorLock(workflowName)]);
  const wins = [first, second].filter(Boolean).length;
  assert.equal(wins, 1, "exactly one of two concurrent supervisor claims must win, never zero, never both");
});

test("claimSupervisorLock: two DIFFERENT workflows never contend with each other", async (t) => {
  const workflowA = testWorkflowName();
  const workflowB = testWorkflowName();
  t.after(() => Promise.all([redis.del(`connector:supervisor-lock:${workflowA}`), redis.del(`connector:supervisor-lock:${workflowB}`)]));

  assert.equal(await claimSupervisorLock(workflowA), true);
  assert.equal(await claimSupervisorLock(workflowB), true, "a different workflow's supervisor lock must be independent");
});
