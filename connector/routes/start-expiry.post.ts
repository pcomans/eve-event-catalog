import { start } from "workflow/api";
import { defineEventHandler } from "nitro/h3";

import { expirySweepWorkflow } from "../workflows/expiry-sweep.ts";

// Manually triggers the expiry sweep workflow — a smoke-test/deliberate-
// restart convenience, mirroring start.post.ts/start-edgar.post.ts. The
// real bootstrap/recovery path is ensure-expiry-running.get.ts's supervisor
// (Vercel Cron). Which subscriptions are due is read fresh from the
// registry's own expiry index every tick, so there's nothing to configure
// at start time. Auth is still open here — fine for a preview smoke test,
// not for a real deploy.
export default defineEventHandler(async () => {
  const run = await start(expirySweepWorkflow, []);
  return { message: "expiry sweep workflow started", runId: run.runId };
});
