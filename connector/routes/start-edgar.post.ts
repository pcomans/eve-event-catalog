import { start } from "workflow/api";
import { defineEventHandler } from "nitro/h3";

import { requireCronSecret } from "../lib/auth.ts";
import { edgarSweepWorkflow } from "../workflows/edgar-sweep.ts";

// Manually triggers the EDGAR sweep workflow — a smoke-test/deliberate-
// restart convenience, mirroring start.post.ts. The real bootstrap/recovery
// path is ensure-edgar-running.get.ts's supervisor (Vercel Cron). Which
// CIKs to watch is read fresh from the registry every tick
// (catalog/providers/desired-membership.ts's readDesiredEdgarSubscriptions),
// so there's nothing to configure at start time. requireCronSecret
// (lib/auth.ts) gates this route — it's never Cron-invoked, so reaching it
// needs the header supplied by hand.
export default defineEventHandler(async (event) => {
  requireCronSecret(event);
  const run = await start(edgarSweepWorkflow, []);
  return { message: "edgar sweep workflow started", runId: run.runId };
});
