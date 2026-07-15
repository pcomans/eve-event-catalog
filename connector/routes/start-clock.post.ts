import { start } from "workflow/api";
import { defineEventHandler } from "nitro/h3";

import { requireCronSecret } from "../lib/auth.ts";
import { clockSweepWorkflow } from "../workflows/clock-sweep.ts";

// Manually triggers the clock sweep workflow — a smoke-test/deliberate-
// restart convenience, mirroring start-expiry.post.ts/start-edgar.post.ts.
// Not explicitly requested by the launch-blocker task this route ships
// alongside — added for consistency with every OTHER sweep's own manual
// trigger sibling, and to give a way to smoke-test the fix directly rather
// than only via the real 30s cadence or waiting for a real `at` to pass.
// The real bootstrap/recovery path is ensure-clock-running.get.ts's
// supervisor (Vercel Cron). Which subscriptions are due is read fresh from
// clock-redis.ts's own due-time index every tick, so there's nothing to
// configure at start time. requireCronSecret (lib/auth.ts) gates this
// route — it's never Cron-invoked, so reaching it needs the header
// supplied by hand.
export default defineEventHandler(async (event) => {
  requireCronSecret(event);
  const run = await start(clockSweepWorkflow, []);
  return { message: "clock sweep workflow started", runId: run.runId };
});
