import { start } from "workflow/api";
import { defineEventHandler } from "nitro/h3";

import { claimSupervisorLock, readHeartbeat } from "../../catalog/providers/chain-guard.ts";
import { isChainDead } from "../../catalog/providers/chain-supervisor.ts";
import { requireCronSecret } from "../lib/auth.ts";
import { EXPIRY_HEARTBEAT_STALE_AFTER_MS, EXPIRY_WORKFLOW_NAME, expirySweepWorkflow } from "../workflows/expiry-sweep.ts";

// The expiry sweep's own supervisor — same one-mechanism-three-jobs pattern
// as ensure-running.get.ts/ensure-edgar-running.get.ts (bootstrap, fork-safe
// recovery, general dead-chain recovery), reused rather than reinvented,
// keyed by its own workflow name/heartbeat so it never collides with the
// other chains'. claimSupervisorLock guards the WHOLE heartbeat-check-then-
// start decision from the start (p2v finding 7's fix, applied here rather
// than retrofitted later) — two concurrent invocations of this route (an
// overlapping Cron fire) never both decide to restart the chain. Wired as
// its own Vercel Cron entry (root vercel.json).
export default defineEventHandler(async (event) => {
  requireCronSecret(event);
  const claimed = await claimSupervisorLock(EXPIRY_WORKFLOW_NAME);
  if (!claimed) return { status: "skipped-concurrent-supervisor-run" };

  const heartbeat = await readHeartbeat(EXPIRY_WORKFLOW_NAME);
  if (!isChainDead(heartbeat, Date.now(), EXPIRY_HEARTBEAT_STALE_AFTER_MS)) {
    return { status: "alive" };
  }

  const run = await start(expirySweepWorkflow, []);
  return { status: "restarted", runId: run.runId };
});
