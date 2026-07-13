import { start } from "workflow/api";
import { defineEventHandler } from "nitro/h3";

import { marketDataConnectorWorkflow } from "../workflows/market-data-session.ts";

// Manually triggers the real connector run-forever workflow — useful for a
// smoke test or a deliberate restart. The actual bootstrap/recovery path is
// ensure-running.get.ts's supervisor (Vercel Cron, every 5 min): it starts
// the chain the first time and restarts it if the heartbeat ever goes
// stale, so this route isn't the only way the connector comes alive.
// Which symbols/orders to watch is NOT passed in here — every session step
// reads the live desired set straight from the subscription registry
// (catalog/providers/desired-membership.ts), so there's nothing to
// configure at start time at all. Auth on this route is still open — fine
// for a preview smoke test, not for a real deploy.
export default defineEventHandler(async () => {
  const run = await start(marketDataConnectorWorkflow, []);
  return { message: "connector workflow started", runId: run.runId };
});
