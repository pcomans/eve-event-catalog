import { Redis } from "@upstash/redis";

// Real Redis backing for KNOWN_ISSUES.md #15's fork-prevention fix: a
// connector run-forever workflow's chaining step (the one that calls
// start(self, ...) to recurse into a fresh run) is not safely retryable as
// written — the smoke test proved a step that throws AFTER start() already
// succeeded gets re-executed from the top on retry, calling start() again
// and forking a second, redundant forever-chain. This module converts that
// into at-most-once chaining via a SET NX claim, plus the heartbeat/read
// half of the supervisor pattern that recovers from (or bootstraps) a dead
// chain. Same two-phase-claim shape as wake.ts's own delivery lease/marker
// (SET NX wins exactly once; a crash between claim and the actual side
// effect fails closed, not open).
const redis = Redis.fromEnv();

// Generous — this claim's whole job is "has THIS run's chaining step ever
// succeeded in claiming," which is meaningful for the run's entire
// lifetime, not a short window. TTL is hygiene (so the keyspace doesn't
// grow forever across a long-running campaign), not a correctness knob.
const CHAIN_CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;

function chainClaimKey(runNonce: string): string {
  return `connector:chained:${runNonce}`;
}

function heartbeatKey(workflowName: string): string {
  return `connector:heartbeat:${workflowName}`;
}

function supervisorLockKey(workflowName: string): string {
  return `connector:supervisor-lock:${workflowName}`;
}

// p2v Codex gate finding (2026-07-13, finding 7): a supervisor route
// (connector/routes/ensure-running.get.ts, ensure-edgar-running.get.ts)
// reads the heartbeat and conditionally starts a fresh chain — but that
// read-then-act is not itself atomic. Vercel Cron can, in principle,
// deliver the same scheduled invocation concurrently (overlapping retries,
// a slow prior invocation still running when the next tick fires); two
// concurrent supervisor runs can both read a stale heartbeat and both
// decide "dead, restart" — and since each mints its OWN runNonce,
// claimChain (this module's other claim) doesn't help here at all: it only
// stops ONE run from forking twice, not two INDEPENDENT runs from both
// being started in the first place. This is a second, separate claim, on
// the supervisor DECISION itself, not on chaining.
const SUPERVISOR_LOCK_TTL_SECONDS = 60; // >> a Cron tick's own realistic overlap window; short enough that a crash while holding it self-heals well before the next scheduled invocation (every 5 min)

/**
 * Claims the right to act as THE supervisor for `workflowName` right now —
 * SET NX, so of any number of concurrent invocations (e.g. two overlapping
 * Cron fires), exactly one proceeds to read the heartbeat and possibly
 * start a fresh chain; every other caller must return immediately without
 * touching either. Same two-phase honesty as every other claim in this
 * module: a crash while holding the lock is not specially handled — it
 * just expires after `SUPERVISOR_LOCK_TTL_SECONDS`, and the next scheduled
 * supervisor tick retries normally.
 */
export async function claimSupervisorLock(workflowName: string): Promise<boolean> {
  const result = await redis.set(supervisorLockKey(workflowName), Date.now(), { nx: true, ex: SUPERVISOR_LOCK_TTL_SECONDS });
  return result === "OK";
}

/**
 * Claims the right to chain a fresh run from THIS run (identified by
 * `runNonce` — a value stable across every retry/replay of this one run,
 * e.g. generated once via a memoized step at the top of the workflow).
 * Returns true for the caller that wins (must proceed to call start());
 * false for anyone else (a retry of the same step after the first attempt
 * already claimed and called start() — must skip start() entirely, since
 * calling it again would fork a duplicate forever-chain).
 */
export async function claimChain(runNonce: string): Promise<boolean> {
  const result = await redis.set(chainClaimKey(runNonce), Date.now(), { nx: true, ex: CHAIN_CLAIM_TTL_SECONDS });
  return result === "OK";
}

/**
 * Records that `workflowName`'s run-forever chain is alive right now.
 * TTL is set a little past `staleAfterMs` — a heartbeat stale enough for
 * the supervisor to act on should also simply not exist anymore, rather
 * than lingering as a key nobody's reading meaningfully.
 */
export async function recordHeartbeat(workflowName: string, staleAfterMs: number): Promise<void> {
  await redis.set(heartbeatKey(workflowName), Date.now(), { ex: Math.ceil(staleAfterMs / 1000) + 60 });
}

/** Reads the most recent heartbeat timestamp (ms since epoch) for `workflowName`, or null if none has ever been recorded (or it's expired). */
export async function readHeartbeat(workflowName: string): Promise<number | null> {
  const value = await redis.get<number>(heartbeatKey(workflowName));
  return value ?? null;
}
