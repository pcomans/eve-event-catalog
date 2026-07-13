import { start } from "workflow/api";
import { defineEventHandler } from "nitro/h3";

import { recoverySweepWorkflow } from "../workflows/recovery-sweep.ts";

// Manually triggers the recovery-sweep workflow — a smoke-test/deliberate-
// restart convenience, mirroring start.post.ts/start-edgar.post.ts/
// start-expiry.post.ts. The real bootstrap/recovery path is
// ensure-recovery-running.get.ts's supervisor (Vercel Cron). Which
// subscriptions are stranded is read fresh from the registry every tick,
// so there's nothing to configure at start time. Auth is still open here —
// fine for a preview smoke test, not for a real deploy.
export default defineEventHandler(async () => {
  const run = await start(recoverySweepWorkflow, []);
  return { message: "recovery sweep workflow started", runId: run.runId };
});
