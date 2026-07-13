import { getRun } from "workflow/api";
import { defineEventHandler, getQuery } from "nitro/h3";

// Polls a smoke-test (or any) run's status/return value by runId, without
// needing the full observability web UI. Throwaway, matching the rest of
// this smoke test's scope.
export default defineEventHandler(async (event) => {
  const { runId } = getQuery(event) as { runId?: string };
  if (!runId) return { error: "missing ?runId=" };

  const run = getRun(runId);
  const status = await run.status;
  const result = status === "completed" ? await run.returnValue : undefined;
  return { runId, status, result };
});
