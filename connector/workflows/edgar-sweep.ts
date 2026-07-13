import { randomUUID } from "node:crypto";
import { sleep } from "workflow";
import { start } from "workflow/api";

import { claimChain, recordHeartbeat } from "../../catalog/providers/chain-guard.ts";
import { runEdgarSweepTick } from "../../catalog/providers/edgar-sweep.ts";
import { fetchFilingsFromSec, resolveCik } from "../../catalog/providers/edgar-client.ts";
import { deliverWakeFromConnector } from "../lib/deliver-wake.ts";

// Phase 3's EDGAR sweep: the SAME run-forever shape market-data-session.ts
// uses (gate 7: no continueAsNew, so "forever" is recursion across runs via
// start(self, ...)) — reused deliberately, not reinvented, per team-lead
// directive. Where it differs: there is no socket to hold open, so each
// step is a single sweep tick (catalog/providers/edgar-sweep.ts's
// runEdgarSweepTick) followed by a durable sleep() — sleep()/run duration
// are unlimited (gate 7), so this is the one place in the connector that
// leans on durable sleep rather than a bounded Fluid-function-duration step.
const SWEEP_INTERVAL_MS = 30_000; // matches edgar.ts's own POLL_INTERVAL_MS — AGENTS.md rule 3's ~30s freshness target
// Smoke-test override (Phase 3 preview verification, 2026-07-13): the real
// production cadence lets a smoke test shrink the TICK COUNT only — never
// the sleep duration, since the whole point of the smoke test is watching
// the REAL sleep(30_000) primitive hold inside an actual workflow body, not
// a shortened stand-in (that's what the throwaway sleep-resume-smoke-test.ts
// already covers). Unset (falls back to 360) in production.
//
// p3 Codex gate finding 1 (event budget): 500 ticks emits ~2,506 workflow
// events per run (500 x [3-event step + 2-event sleep] + nonce/chaining
// steps), over the ~2,000-event guidance for chaining before. Capped at
// 360 — comfortably under 400 — so this chains at roughly 3 hours instead
// of ~4h10m.
const SWEEP_TICKS_PER_RUN = Number(process.env.EDGAR_SWEEP_TICKS_PER_RUN) || 360;

// Shared with connector/routes/ensure-edgar-running.get.ts — the supervisor
// reads the SAME heartbeat key/staleness tolerance this workflow writes with.
export const EDGAR_WORKFLOW_NAME = "edgar-sweep-connector";
// p3 Codex gate finding 4: a connector step can legitimately stay live for
// the platform's full function duration (~800s) plus retry headroom before
// finishing — 5 minutes was tight enough that a slow-but-healthy tick could
// look dead to the supervisor, which would then start a SECOND chain while
// the original one later resumes and keeps ticking too (claimChain only
// stops one run from forking itself; it can't stop two independently-started
// runs from coexisting). 20 minutes is comfortably past the worst realistic
// single-tick duration; the supervisor is a backstop for genuinely dead
// chains, not a tight liveness check, so a slower recovery of a truly-dead
// chain is an acceptable trade.
export const EDGAR_HEARTBEAT_STALE_AFTER_MS = 20 * 60 * 1000;

/**
 * The connector's EDGAR run-forever shape: a bounded loop of durable sweep
 * ticks (each one a real, coalesced poll of every currently-armed
 * filing.new subscription's CIK — catalog/providers/edgar-sweep.ts's
 * runEdgarSweepTick — delivering through the SAME armed->delivering->fired
 * lifecycle the price-crossing/order-reconciliation legs use), then the run
 * recurses into a fresh one via start(self, ...) before its own per-run
 * ceilings would ever bind — identical fork-prevention shape to
 * market-data-session.ts (KNOWN_ISSUES.md #15): the chaining step is
 * guarded by claimChain() so a step retried after start() already succeeded
 * cannot fork a duplicate forever-chain.
 *
 * No state is carried across ticks, steps, or runs — the seen-set
 * (edgar-redis.ts) and the registry are both in Redis, independent of any
 * particular run.
 */
export async function edgarSweepWorkflow(): Promise<never> {
  "use workflow";

  // Stable per-run identity, same reasoning as market-data-session.ts's own
  // runNonce: a step's return value is memoized for this run's entire
  // lifetime once it succeeds, so every retry/replay of the SAME run gets
  // the SAME nonce back.
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
 * run one real sweep tick, wired to the production dependencies —
 * fetchFilingsFromSec/resolveCik (edgar-client.ts, the same REST seam
 * edgar.ts's own in-process watcher uses) and deliverWakeFromConnector
 * (connector/lib/deliver-wake.ts, shared with the price-crossing/
 * order-reconciliation legs). No fencing wrapper here, unlike the
 * alpaca-session.ts legs' guardedDeliver — deliberately: this sweep has no
 * "stream session" to be superseded, and the binding design requirement
 * (catalog/providers/edgar-sweep.ts's sweepOneCik doc comment) is that
 * tryTransitionToDelivering's CAS alone is what makes overlapping sweep
 * ticks safe, not fencing.
 */
async function sweepStep(): Promise<void> {
  "use step";
  await recordHeartbeat(EDGAR_WORKFLOW_NAME, EDGAR_HEARTBEAT_STALE_AFTER_MS);
  await runEdgarSweepTick({
    fetchFilings: fetchFilingsFromSec,
    resolveCik,
    deliver: deliverWakeFromConnector,
  });
  // p3 Codex gate finding 4: also written AFTER the tick, not just before —
  // a heartbeat written only at the start of a long tick can go stale
  // mid-tick even though the run is healthy and about to finish; writing
  // again here keeps the recorded heartbeat close to "now" for the whole
  // duration this step is actually alive, not just its first instant.
  await recordHeartbeat(EDGAR_WORKFLOW_NAME, EDGAR_HEARTBEAT_STALE_AFTER_MS);
}

async function startNextRun(runNonce: string): Promise<void> {
  "use step";
  // KNOWN_ISSUES.md #15: not safely retryable around a bare start() call —
  // claimChain() converts that into at-most-once chaining, identical to
  // market-data-session.ts's own startNextRun.
  const claimed = await claimChain(runNonce);
  if (!claimed) return;
  await start(edgarSweepWorkflow, []);
}
