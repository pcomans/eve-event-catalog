import { randomUUID } from "node:crypto";
import { sleep } from "workflow";
import { start } from "workflow/api";

import { claimChain, recordHeartbeat } from "../../catalog/providers/chain-guard.ts";
import { runExpirySweepTick } from "../../catalog/providers/expiry-sweep.ts";
import { deliverExpiredWakeFromConnector } from "../lib/deliver-wake.ts";

// Phase 3's expiry migration: the durable driver for subscription expiry —
// same run-forever shape as edgar-sweep.ts (gate 7: no continueAsNew, so
// "forever" is recursion across runs via start(self, ...)), reused
// deliberately rather than reinvented (team-lead directive). wake.ts's own
// scheduleExpiry/expire (an in-process setTimeout) stays exactly as-is for
// local dev — one code path per host, not replaced — this workflow is the
// OTHER host's path, for anywhere a serverless eve instance can recycle
// between a subscription arming and its expiresAt arriving.
const SWEEP_INTERVAL_MS = 30_000;
// Smoke-test override, same convention as edgar-sweep.ts's own
// EDGAR_SWEEP_TICKS_PER_RUN — shrinks the TICK COUNT only, never the sleep
// duration, so a preview smoke test can observe a chain handoff without
// waiting out the real production cadence. Unset (falls back to 360) in
// production.
//
// p3 Codex gate finding 1 (event budget): capped at 360 ticks (same
// reasoning as edgar-sweep.ts's own cap) — comfortably under the ~2,000
// workflow-event chain-before guidance.
const SWEEP_TICKS_PER_RUN = Number(process.env.EXPIRY_SWEEP_TICKS_PER_RUN) || 360;

// Shared with connector/routes/ensure-expiry-running.get.ts — the
// supervisor reads the SAME heartbeat key/staleness tolerance this
// workflow writes with.
export const EXPIRY_WORKFLOW_NAME = "expiry-sweep-connector";
// p3 Codex gate finding 4 (same reasoning as edgar-sweep.ts's own
// EDGAR_HEARTBEAT_STALE_AFTER_MS): a step can legitimately stay live for the
// platform's full function duration plus retry headroom, so 5 minutes was
// tight enough for the supervisor to mistake a slow-but-healthy tick for a
// dead chain and start a second one alongside it. 20 minutes is comfortably
// past the worst realistic single-tick duration.
export const EXPIRY_HEARTBEAT_STALE_AFTER_MS = 20 * 60 * 1000;

/**
 * The connector's expiry run-forever shape: a bounded loop of durable sweep
 * ticks (each one a real read of every subscription currently due —
 * catalog/providers/expiry-sweep.ts's runExpirySweepTick — delivering
 * through the SAME armed->delivering->terminal lifecycle every other
 * connector leg uses), then the run recurses into a fresh one via
 * start(self, ...) before its own per-run ceilings would ever bind —
 * identical fork-prevention shape to market-data-session.ts and
 * edgar-sweep.ts (KNOWN_ISSUES.md #15).
 */
export async function expirySweepWorkflow(): Promise<never> {
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
 * (connector/lib/deliver-wake.ts's deliverExpiredWakeFromConnector). No
 * fencing wrapper — deliberately, same reasoning as edgar-sweep.ts's own
 * sweepStep: there's no socket session to be superseded here, and the
 * binding requirement is that tryTransitionToDelivering's CAS alone makes
 * overlapping sweeps (and a local timer racing this durable sweep) safe,
 * not fencing.
 */
async function sweepStep(): Promise<void> {
  "use step";
  await recordHeartbeat(EXPIRY_WORKFLOW_NAME, EXPIRY_HEARTBEAT_STALE_AFTER_MS);
  await runExpirySweepTick(deliverExpiredWakeFromConnector);
  // p3 Codex gate finding 4: also written after the tick — see
  // edgar-sweep.ts's own sweepStep for the full reasoning.
  await recordHeartbeat(EXPIRY_WORKFLOW_NAME, EXPIRY_HEARTBEAT_STALE_AFTER_MS);
}

async function startNextRun(runNonce: string): Promise<void> {
  "use step";
  const claimed = await claimChain(runNonce);
  if (!claimed) return;
  await start(expirySweepWorkflow, []);
}
