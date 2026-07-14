import { start } from "workflow/api";
import { defineEventHandler } from "nitro/h3";

import { requireCronSecret } from "../lib/auth.ts";
import { sleepResumeSmokeTest } from "../workflows/sleep-resume-smoke-test.ts";

// Triggers the throwaway sleep-resume/start(self) smoke test. Not part of
// the real connector — see sleep-resume-smoke-test.ts's own module comment.
// requireCronSecret (lib/auth.ts) gates this like every other route here —
// this one is never Cron-invoked, so reaching it needs the header by hand.
export default defineEventHandler(async (event) => {
  requireCronSecret(event);
  const run = await start(sleepResumeSmokeTest, [{ runIndex: 0 }]);
  return { message: "sleep-resume smoke test started", runId: run.runId };
});
