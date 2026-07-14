import { start } from "workflow/api";
import { defineEventHandler } from "nitro/h3";

import { requireCronSecret } from "../lib/auth.ts";
import { recoverySweepWorkflow } from "../workflows/recovery-sweep.ts";

// Manually triggers the recovery-sweep workflow — a smoke-test/deliberate-
// restart convenience, mirroring start.post.ts/start-edgar.post.ts/
// start-expiry.post.ts. The real bootstrap/recovery path is
// ensure-recovery-running.get.ts's supervisor (Vercel Cron). Which
// subscriptions are stranded is read fresh from the registry every tick,
// so there's nothing to configure at start time. requireCronSecret
// (lib/auth.ts) gates this route — it's never Cron-invoked, so reaching it
// needs the header supplied by hand.
export default defineEventHandler(async (event) => {
  requireCronSecret(event);
  const run = await start(recoverySweepWorkflow, []);
  return { message: "recovery sweep workflow started", runId: run.runId };
});
