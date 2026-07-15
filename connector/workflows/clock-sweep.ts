import { randomUUID } from "node:crypto";
import { sleep } from "workflow";
import { start } from "workflow/api";

import { claimChain, recordHeartbeat } from "../../catalog/providers/chain-guard.ts";
import { runClockSweepTick } from "../../catalog/providers/clock-sweep.ts";
import { deliverWakeFromConnector } from "../lib/deliver-wake.ts";

// Launch blocker fix (production finding, 2026-07-14): the durable driver
// for catalog/providers/clock-sweep.ts's runClockSweepTick — same
// run-forever shape as expiry-sweep.ts (its own template; gate 7: no
// continueAsNew, so "forever" is recursion across runs via start(self,
// ...)), reused deliberately rather than reinvented. catalog/providers/
// clock.ts's own in-process setTimeout stays exactly as-is for local dev —
// one code path per host, not replaced — this workflow is the OTHER
// host's path, for anywhere a serverless eve instance can recycle between
// a clock.time.at subscription arming and its `at` arriving (which, unlike
// expiry/EDGAR, used to mean the wake NEVER fired at all on Vercel — no
// durable path existed for it before this).
const SWEEP_INTERVAL_MS = 30_000;
// Smoke-test override, same convention as expiry-sweep.ts's own
// EXPIRY_SWEEP_TICKS_PER_RUN — shrinks the TICK COUNT only, never the sleep
// duration. Unset (falls back to 360) in production.
//
// p3 Codex gate finding 1 (event budget), same reasoning as the other
// sweeps: capped at 360 ticks, comfortably under the ~2,000 workflow-event
// chain-before guidance.
const SWEEP_TICKS_PER_RUN = Number(process.env.CLOCK_SWEEP_TICKS_PER_RUN) || 360;

// Shared with connector/routes/ensure-clock-running.get.ts — the
// supervisor reads the SAME heartbeat key/staleness tolerance this
// workflow writes with.
export const CLOCK_WORKFLOW_NAME = "clock-sweep-connector";
// Same reasoning as expiry-sweep.ts's own EXPIRY_HEARTBEAT_STALE_AFTER_MS:
// a step can legitimately stay live for the platform's full function
// duration plus retry headroom, so 5 minutes was tight enough for the
// supervisor to mistake a slow-but-healthy tick for a dead chain and start
// a second one alongside it. 20 minutes is comfortably past the worst
// realistic single-tick duration.
export const CLOCK_HEARTBEAT_STALE_AFTER_MS = 20 * 60 * 1000;

/**
 * The connector's clock run-forever shape: a bounded loop of durable sweep
 * ticks (each one a real read of every clock.time.at subscription
 * currently due — catalog/providers/clock-sweep.ts's runClockSweepTick —
 * delivering through the SAME armed->delivering->fired lifecycle every
 * other connector leg uses), then the run recurses into a fresh one via
 * start(self, ...) before its own per-run ceilings would ever bind —
 * identical fork-prevention shape to market-data-session.ts, edgar-sweep.ts,
 * and expiry-sweep.ts (KNOWN_ISSUES.md #15).
 */
export async function clockSweepWorkflow(): Promise<never> {
  "use workflow";

  const runNonce = await generateRunNonce();

  for (let i = 0; i < SWEEP_TICKS_PER_RUN; i++) {
    await sweepStep();
    await sleep(SWEEP_INTERVAL_MS);
  }

  await startNextRun(runNonce);
  return undefined as never;
}

async function generateRunNonce(): Promise<string> {
  "use step";
  return randomUUID();
}

/**
 * One durable step: record a heartbeat (read by the supervisor route) then
 * run one real sweep tick, wired to the production delivery leg
 * (connector/lib/deliver-wake.ts's deliverWakeFromConnector — a "fired"
 * wake, NOT "expired"; a clock.time.at subscription that reaches its `at`
 * has fired, not expired). No fencing wrapper — deliberately, same
 * reasoning as expiry-sweep.ts's own sweepStep: there's no socket session
 * to be superseded here, and the binding requirement is that
 * tryTransitionToDelivering's CAS alone makes overlapping sweeps (and a
 * local timer racing this durable sweep) safe, not fencing.
 */
async function sweepStep(): Promise<void> {
  "use step";
  await recordHeartbeat(CLOCK_WORKFLOW_NAME, CLOCK_HEARTBEAT_STALE_AFTER_MS);
  await runClockSweepTick(deliverWakeFromConnector);
  // Same reasoning as expiry-sweep.ts's own sweepStep: also written AFTER
  // the tick, not just before, so the recorded heartbeat stays close to
  // "now" for the whole duration this step is actually alive.
  await recordHeartbeat(CLOCK_WORKFLOW_NAME, CLOCK_HEARTBEAT_STALE_AFTER_MS);
}

async function startNextRun(runNonce: string): Promise<void> {
  "use step";
  const claimed = await claimChain(runNonce);
  if (!claimed) return;
  await start(clockSweepWorkflow, []);
}
