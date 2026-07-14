import { start } from "workflow/api";
import { defineEventHandler } from "nitro/h3";

import { claimSupervisorLock, readHeartbeat } from "../../catalog/providers/chain-guard.ts";
import { isChainDead } from "../../catalog/providers/chain-supervisor.ts";
import { requireCronSecret } from "../lib/auth.ts";
import { EDGAR_HEARTBEAT_STALE_AFTER_MS, EDGAR_WORKFLOW_NAME, edgarSweepWorkflow } from "../workflows/edgar-sweep.ts";

// The EDGAR sweep's own supervisor — same one-mechanism-three-jobs pattern
// as ensure-running.get.ts (bootstrap, fork-safe recovery, general dead-
// chain recovery), reused rather than reinvented, keyed by its own
// workflow name/heartbeat so it never collides with the market-data
// chain's. Wired as its own Vercel Cron entry (root vercel.json).
//
// p2v Codex gate finding 7 (same fix as ensure-running.get.ts, same
// reasoning — see that file's comment): claimSupervisorLock guards the
// WHOLE heartbeat-check-then-start decision, so two concurrent
// invocations of THIS route never both decide to restart the chain.
export default defineEventHandler(async (event) => {
  requireCronSecret(event);
  const claimed = await claimSupervisorLock(EDGAR_WORKFLOW_NAME);
  if (!claimed) return { status: "skipped-concurrent-supervisor-run" };

  const heartbeat = await readHeartbeat(EDGAR_WORKFLOW_NAME);
  if (!isChainDead(heartbeat, Date.now(), EDGAR_HEARTBEAT_STALE_AFTER_MS)) {
    return { status: "alive" };
  }

  const run = await start(edgarSweepWorkflow, []);
  return { status: "restarted", runId: run.runId };
});
