import { start } from "workflow/api";
import { defineEventHandler } from "nitro/h3";

import { edgarSweepWorkflow } from "../workflows/edgar-sweep.ts";

// Manually triggers the EDGAR sweep workflow — a smoke-test/deliberate-
// restart convenience, mirroring start.post.ts. The real bootstrap/recovery
// path is ensure-edgar-running.get.ts's supervisor (Vercel Cron). Which
// CIKs to watch is read fresh from the registry every tick
// (catalog/providers/desired-membership.ts's readDesiredEdgarSubscriptions),
// so there's nothing to configure at start time. Auth is still open here —
// fine for a preview smoke test, not for a real deploy.
export default defineEventHandler(async () => {
  const run = await start(edgarSweepWorkflow, []);
  return { message: "edgar sweep workflow started", runId: run.runId };
});
