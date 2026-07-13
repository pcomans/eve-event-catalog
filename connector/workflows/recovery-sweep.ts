import { randomUUID } from "node:crypto";
import { sleep } from "workflow";
import { start } from "workflow/api";

import { claimChain, recordHeartbeat } from "../../catalog/providers/chain-guard.ts";
import { runRecoverySweepTick } from "../../catalog/providers/recovery-sweep.ts";
import { deliverStrandedWakeFromConnector } from "../lib/deliver-wake.ts";

// Phase 3's recovery-sweep migration: the durable driver for
// catalog/providers/recovery-sweep.ts's runRecoverySweepTick — same
// run-forever shape as edgar-sweep.ts/expiry-sweep.ts (gate 7: no
// continueAsNew, so "forever" is recursion across runs via start(self,
// ...)), reused deliberately rather than reinvented. wake.ts's own
// startRecoverySweep/sweepStrandedDeliveries (an in-process setInterval)
// stays exactly as-is for local dev — one code path per host — this
// workflow is the OTHER host's path, for wherever a serverless eve
// instance can crash/recycle mid-delivery and never get to finish its own
// sweep.
const SWEEP_INTERVAL_MS = 15_000; // matches wake.ts's own startRecoverySweep default cadence
// Smoke-test override, same convention as edgar-sweep.ts's
// EDGAR_SWEEP_TICKS_PER_RUN / expiry-sweep.ts's EXPIRY_SWEEP_TICKS_PER_RUN —
// shrinks the TICK COUNT only, never the sleep duration. Unset (falls back
// to 360) in production.
//
// p3 Codex gate finding 1 (event budget): capped at 360 ticks (same
// reasoning as edgar-sweep.ts's own cap) — comfortably under the ~2,000
// workflow-event chain-before guidance.
const SWEEP_TICKS_PER_RUN = Number(process.env.RECOVERY_SWEEP_TICKS_PER_RUN) || 360;

// Shared with connector/routes/ensure-recovery-running.get.ts — the
// supervisor reads the SAME heartbeat key/staleness tolerance this
// workflow writes with.
export const RECOVERY_WORKFLOW_NAME = "recovery-sweep-connector";
// p3 Codex gate finding 4 (same reasoning as edgar-sweep.ts's own
// EDGAR_HEARTBEAT_STALE_AFTER_MS): a step can legitimately stay live for the
// platform's full function duration plus retry headroom, so 5 minutes was
// tight enough for the supervisor to mistake a slow-but-healthy tick for a
// dead chain and start a second one alongside it. 20 minutes is comfortably
// past the worst realistic single-tick duration.
export const RECOVERY_HEARTBEAT_STALE_AFTER_MS = 20 * 60 * 1000;

/**
 * The connector's recovery-sweep run-forever shape: a bounded loop of
 * durable sweep ticks (each one a real read of every subscription
 * currently stuck "delivering" — runRecoverySweepTick — resumed through
 * the SAME armed->delivering->terminal lifecycle every other connector leg
 * uses), then the run recurses into a fresh one via start(self, ...)
 * before its own per-run ceilings would ever bind — identical
 * fork-prevention shape to market-data-session.ts, edgar-sweep.ts, and
 * expiry-sweep.ts (KNOWN_ISSUES.md #15).
 */
export async function recoverySweepWorkflow(): Promise<never> {
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
 * (connector/lib/deliver-wake.ts's deliverStrandedWakeFromConnector). No
 * fencing wrapper and no delivery-lease check — deliberately, per
 * recovery-sweep.ts's own doc comment: tryTransitionToDelivering's CAS plus
 * the wake-delivery marker's alreadyInFlight/alreadyDelivered dedup are the
 * actual correctness guarantee, independent of any lease; skipping the
 * lease check here only means an occasional redundant (safe, verified
 * no-op) retry against a row wake.ts's own eve-side sweep is already
 * mid-resuming.
 */
async function sweepStep(): Promise<void> {
  "use step";
  await recordHeartbeat(RECOVERY_WORKFLOW_NAME, RECOVERY_HEARTBEAT_STALE_AFTER_MS);
  await runRecoverySweepTick(deliverStrandedWakeFromConnector);
  // p3 Codex gate finding 4: also written after the tick — see
  // edgar-sweep.ts's own sweepStep for the full reasoning.
  await recordHeartbeat(RECOVERY_WORKFLOW_NAME, RECOVERY_HEARTBEAT_STALE_AFTER_MS);
}

async function startNextRun(runNonce: string): Promise<void> {
  "use step";
  const claimed = await claimChain(runNonce);
  if (!claimed) return;
  await start(recoverySweepWorkflow, []);
}
