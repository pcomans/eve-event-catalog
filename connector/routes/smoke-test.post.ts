import { start } from "workflow/api";
import { defineEventHandler } from "nitro/h3";

import { sleepResumeSmokeTest } from "../workflows/sleep-resume-smoke-test.ts";

// Triggers the throwaway sleep-resume/start(self) smoke test. Not part of
// the real connector — see sleep-resume-smoke-test.ts's own module comment.
export default defineEventHandler(async () => {
  const run = await start(sleepResumeSmokeTest, [{ runIndex: 0 }]);
  return { message: "sleep-resume smoke test started", runId: run.runId };
});
