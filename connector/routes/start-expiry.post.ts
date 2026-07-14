import { start } from "workflow/api";
import { defineEventHandler } from "nitro/h3";

import { requireCronSecret } from "../lib/auth.ts";
import { expirySweepWorkflow } from "../workflows/expiry-sweep.ts";

// Manually triggers the expiry sweep workflow — a smoke-test/deliberate-
// restart convenience, mirroring start.post.ts/start-edgar.post.ts. The
// real bootstrap/recovery path is ensure-expiry-running.get.ts's supervisor
// (Vercel Cron). Which subscriptions are due is read fresh from the
// registry's own expiry index every tick, so there's nothing to configure
// at start time. requireCronSecret (lib/auth.ts) gates this route — it's
// never Cron-invoked, so reaching it needs the header supplied by hand.
export default defineEventHandler(async (event) => {
  requireCronSecret(event);
  const run = await start(expirySweepWorkflow, []);
  return { message: "expiry sweep workflow started", runId: run.runId };
});
