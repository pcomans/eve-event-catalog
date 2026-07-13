import { randomUUID } from "node:crypto";
import { start } from "workflow/api";

import { claimChain, recordHeartbeat } from "../../catalog/providers/chain-guard.ts";
import { runFencedAlpacaSession } from "../lib/alpaca-session.ts";

// Gate 7 (docs/architecture.md "How workflow@4.6.0 expresses 'forever'"):
// there is no continueAsNew primitive — run-forever is recursion across
// runs. A single run's per-run ceilings (25,000 events hard cap, a step
// costs 3 events, a sleep costs 2; 10,000 steps; 240s max replay) mean an
// in-run `while (true)` eventually dies. Vercel's own guidance: chain to a
// fresh run well before ~2,000 events. A socket-holding step is ALSO capped
// independently by the Fluid function ceiling (800s GA), not by Workflows
// itself — so each session step is bounded to comfortably under that,
// leaving headroom (gap-replay + connect overhead) before the ceiling, not
// racing it.
const SESSION_STEPS_PER_RUN = 72; // 72 steps * ~10min sessions ~= 12h of sessions before this run recurses — comfortably under the ~2,000-event chain-before guidance (each step costs a handful of events, not thousands)
// Codex gate finding: 12 minutes of 15s membership-cadence ticks ALONE is
// 48*15s=720s — before adding connect/auth/gap-replay/reconciliation
// overhead at the start of the step, that leaves too little headroom under
// the 800s Fluid ceiling (nitro.config.ts's vercel.functions.maxDuration).
// 10 minutes of ticks is 40*15s=600s, leaving ~200s of real buffer for that
// startup overhead plus final cleanup — a session step config connector/
// nitro.config.ts's maxDuration:800 was written to match, verify together.
const SESSION_DURATION_MS = 10 * 60 * 1000; // ~10 minutes

// Shared with connector/routes/ensure-running.get.ts — the supervisor reads
// the SAME heartbeat key/staleness tolerance this workflow writes with.
export const WORKFLOW_NAME = "market-data-connector";
export const HEARTBEAT_STALE_AFTER_MS = 20 * 60 * 1000; // > one session step's SESSION_DURATION_MS, with buffer for connect/gap-replay/reconciliation overhead at the start of a step

/**
 * The connector's run-forever shape: a bounded loop of real, fenced socket
 * sessions (catalog/providers/alpaca-client.ts's own StockDataStream/
 * TradingStream clients, gap-replayed on every reconnect per prereq 1,
 * fenced per prereq 2, membership-rechecked on prereq 3's 15s cadence),
 * then the run recurses into a fresh one via start(self, ...) before its
 * own per-run ceilings would ever bind. Each session step also writes a
 * heartbeat (read by connector/routes/ensure-running.get.ts's supervisor)
 * and the final chaining step is guarded against forking a duplicate chain
 * on retry (KNOWN_ISSUES.md #15) — see startNextRun below.
 *
 * No state is carried across steps or runs — order reconciliation's own
 * redesign (alpaca-session.ts's reconcileOrders) dropped the last thing
 * that used to need one (an [after, until] bracket); price-crossing
 * cursors live in Redis per symbol (catalog/providers/gap-replay-cursor.ts)
 * independent of any run.
 */
export async function marketDataConnectorWorkflow(): Promise<never> {
  "use workflow";

  // A stable identity for THIS run, good across every retry/replay of it:
  // a step's return value is memoized for the run's entire lifetime once it
  // succeeds, so the first (real) execution of this step mints one runNonce
  // and every subsequent replay of the SAME run gets that exact value back
  // — a legitimate per-run nonce without the SDK needing to expose "my own
  // runId" directly (no such accessor was found on the workflow-context
  // surface).
  const runNonce = await generateRunNonce();

  for (let i = 0; i < SESSION_STEPS_PER_RUN; i++) {
    await runSocketSession();
  }

  // Recursion across runs — the only "forever" primitive this SDK offers
  // (see gate 7's own comment above). start() must be called from inside
  // its own "use step" wrapper, not directly in the workflow body —
  // confirmed against real infra by the sleep-resume smoke test's own
  // failure (KNOWN_ISSUES.md #15): calling it here directly throws "The
  // workflow environment doesn't allow this runtime usage of start."
  await startNextRun(runNonce);
  return undefined as never;
}

async function generateRunNonce(): Promise<string> {
  "use step";
  return randomUUID();
}

async function startNextRun(runNonce: string): Promise<void> {
  "use step";
  // KNOWN_ISSUES.md #15: this step is not safely retryable around a bare
  // start() call — a retry that re-executes this step's body AFTER
  // start() already succeeded (exactly what happened chasing the
  // now-fixed step-return-value serialization bug) would call start()
  // again and fork a second, redundant forever-chain. claimChain()
  // converts that into at-most-once chaining: only the attempt that wins
  // the claim for this run's own nonce ever proceeds to call start(); any
  // later retry of this same step finds the claim already taken and
  // returns without forking anything. Discards the Run object start()
  // resolves to either way — a step's return value must be
  // JSON-serializable (also KNOWN_ISSUES.md #15), and nothing here needs
  // the chained run's id.
  const claimed = await claimChain(runNonce);
  if (!claimed) return;
  await start(marketDataConnectorWorkflow, []);
}

/**
 * One bounded socket session: opens the real Alpaca stock-data and
 * trading-updates streams, gap-replays/reconciles on connect, and holds
 * both open for SESSION_DURATION_MS while rechecking desired subscription
 * membership on a cadence, then disconnects. Records a heartbeat first —
 * the supervisor (ensure-running.get.ts) treats a chain as dead once its
 * most recent heartbeat is older than HEARTBEAT_STALE_AFTER_MS.
 */
async function runSocketSession(): Promise<void> {
  "use step";
  await recordHeartbeat(WORKFLOW_NAME, HEARTBEAT_STALE_AFTER_MS);
  await runFencedAlpacaSession(SESSION_DURATION_MS);
}
