import { start } from "workflow/api";
import { defineEventHandler } from "nitro/h3";

import { claimSupervisorLock, readHeartbeat } from "../../catalog/providers/chain-guard.ts";
import { isChainDead } from "../../catalog/providers/chain-supervisor.ts";
import {
  HEARTBEAT_STALE_AFTER_MS,
  WORKFLOW_NAME,
  marketDataConnectorWorkflow,
} from "../workflows/market-data-session.ts";

// The supervisor (team-lead directive, KNOWN_ISSUES.md #15): one mechanism,
// three jobs — bootstrap (nothing has ever run), fork-safe recovery (the
// chaining step's own claimChain() guard prevents duplicate chains, but if
// the chain dies for some OTHER reason — an unhandled crash, a bad deploy —
// nothing else would ever restart it), and "what if the chain dies for any
// other reason" in general. Wired as a Vercel Cron (root vercel.json,
// */5 * * * *) hitting this route on a GET, matching Vercel Cron's own
// invocation convention. Auth is still open, matching every other route in
// this connector tonight — fine for a preview, not for a real deploy (a
// public GET that can start a workflow run is exactly the kind of thing
// that needs the CRON_SECRET check before this goes to production).
//
// p2v Codex gate finding 7: the heartbeat-read-then-start below is not
// itself atomic — two concurrent invocations of this route (an overlapping
// Cron fire, a slow prior invocation still in flight) could both read a
// stale heartbeat and both start a fresh chain; each mints its own
// runNonce, so claimChain (inside marketDataConnectorWorkflow's own
// chaining step) can't stop this — it only prevents ONE run from forking
// twice, not two independent runs from being started in the first place.
// claimSupervisorLock guards the WHOLE decision: only the caller that wins
// this claim ever reads the heartbeat or calls start() at all.
export default defineEventHandler(async () => {
  const claimed = await claimSupervisorLock(WORKFLOW_NAME);
  if (!claimed) return { status: "skipped-concurrent-supervisor-run" };

  const heartbeat = await readHeartbeat(WORKFLOW_NAME);
  if (!isChainDead(heartbeat, Date.now(), HEARTBEAT_STALE_AFTER_MS)) {
    return { status: "alive" };
  }

  const run = await start(marketDataConnectorWorkflow, []);
  return { status: "restarted", runId: run.runId };
});
