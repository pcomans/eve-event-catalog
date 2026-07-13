import { getRun } from "workflow/api";
import { defineEventHandler, getQuery } from "nitro/h3";

// Cancels a workflow run by runId — the piece HANDOFF-PHASE3.md's "OPEN
// (Phase 6, not now): find/build a workflow run-cancellation path" flagged
// as unchased. Turns out no new mechanism was needed: `Run.cancel():
// Promise<void>` is a public instance method on the SAME `Run` class
// status.get.ts already uses successfully (`getRun(runId)`), re-exported
// from `workflow/api` — the missing piece was just trying it, not a real
// auth/invocation gap. Throwaway, matching status.get.ts's own scope: used
// to stop the item-2/item-3 smoke-test chains after observing one short
// cycle each, so nothing new is left running besides the EDGAR chain.
export default defineEventHandler(async (event) => {
  const { runId } = getQuery(event) as { runId?: string };
  if (!runId) return { error: "missing ?runId=" };

  const run = getRun(runId);
  await run.cancel();
  return { runId, status: await run.status };
});
