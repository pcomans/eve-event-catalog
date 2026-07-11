import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

// Throwaway tool for the wake-loop smoke test (AT-2 step 6). Delete once the
// real catalog tools (subscribe_event, submit_order, ...) exist.
export default defineTool({
  description: "A no-op action gated on human approval, used to test the approval round-trip.",
  inputSchema: z.object({ note: z.string().optional() }),
  approval: always(),
  async execute({ note }) {
    return { ok: true, note: note ?? null };
  },
});
