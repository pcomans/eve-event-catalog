import { defineTool } from "eve/tools";
import { z } from "zod";

import { search } from "#catalog/catalog.ts";

// Thin wrapper around catalog/catalog.ts's search(): the catalog is the
// single source of truth (catalog.json), so this tool returns its entries
// verbatim rather than reshaping or summarizing them — the model needs the
// full JSON Schema (to call subscribe_event correctly) and the full
// provider metadata (to reason about tradeoffs), not a paraphrase.
export default defineTool({
  description:
    'Search the Event Catalog for subscribable event types — things you can wait on, like a stock ' +
    'price crossing a threshold, a new SEC filing, or an order reaching "filled". Always call this ' +
    "before subscribe_event: it returns the exact provider/event names, the JSON Schema subscribe_event's " +
    "params must satisfy, each provider's metadata (freshness, latency, auth, cost, durability) so you " +
    "can pick a source for real reasons, and that event type's onWake — guidance for handling its wake " +
    "once you're subscribed (e.g. a re-check rule, or how to interpret its snapshot fields) that arrives " +
    "again inside the wake message itself when it fires, so you don't need to remember it now. A result " +
    'with status "planned" is documented in the catalog but has no working provider yet — never ' +
    "subscribe to it; tell the user it isn't available.",
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        "Natural-language description of the condition to wait for, e.g. 'NVDA drops below 150' or " +
          "'Apple files an 8-K'.",
      ),
  }),
  async execute({ query }) {
    const results = search(query);
    return {
      query,
      results: results.map((result) => ({
        provider: result.provider,
        event: result.event,
        status: result.status,
        description: result.description,
        params: result.params,
        metadata: result.metadata,
        tags: result.tags,
        onWake: result.onWake,
      })),
    };
  },
});
