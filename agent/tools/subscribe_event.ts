import { defineTool } from "eve/tools";
import { z } from "zod";

import { subscribe } from "#catalog/catalog.ts";
import { getConversationBySessionId } from "#catalog/registry.ts";

// Subscriptions are keyed by conversationId (the channel's continuation
// token — see agent/channels/catalog.ts), but a tool's ctx only exposes
// ctx.session.id, the eve-assigned sessionId. recordConversation writes a
// sessionId -> conversationId reverse index precisely so a tool can recover
// its own conversationId without the channel threading it through some
// other mechanism.
export default defineTool({
  description:
    "Subscribe to an event type found via search_events — the only way to wait on an external " +
    "condition; never poll or guess a schedule instead. `params` must satisfy the JSON Schema " +
    "search_events returned for this exact provider/event pair. A rejection here (unknown event type, " +
    "a still-planned provider, or params that fail the schema) is returned as the tool result with the " +
    "specific problem named — read it and correct the call in this same turn rather than repeating it " +
    "unchanged. After a successful call: tell the user, in one sentence, what you're waiting for and " +
    "until when, then end your turn — do not loop, sleep, or re-check yourself. The Event Catalog wakes " +
    "this same conversation with a \"[event-catalog wake]\" message (carrying that event type's own " +
    "onWake guidance) when the predicate fires or the subscription expires.",
  inputSchema: z.object({
    provider: z.string().min(1).describe('Provider name from search_events, e.g. "alpaca".'),
    event: z.string().min(1).describe('Event name from search_events, e.g. "price.crossesBelow".'),
    resource: z
      .string()
      .min(1)
      .describe("The thing being watched: a ticker symbol, an order id, etc., per the event's description."),
    params: z
      .record(z.string(), z.unknown())
      .describe("Predicate params matching the event type's JSON Schema, e.g. { \"threshold\": 150 }."),
    expiresInMinutes: z
      .number()
      .positive()
      .optional()
      .describe("Optional: auto-expire the subscription after this many minutes if the event never fires."),
  }),
  async execute({ provider, event, resource, params, expiresInMinutes }, ctx) {
    const conversation = await getConversationBySessionId(ctx.session.id);
    if (!conversation) {
      throw new Error(
        "Could not resolve this session to a conversation — the Event Catalog channel has no record of it.",
      );
    }

    const expiresAt = expiresInMinutes
      ? new Date(Date.now() + expiresInMinutes * 60_000).toISOString()
      : undefined;

    const subscription = await subscribe({
      conversationId: conversation.conversationId,
      provider,
      event,
      resource,
      params,
      expiresAt,
    });

    const expiryNote = expiresAt ? `, expires ${expiresAt}` : " (no expiry)";
    return {
      subscriptionId: subscription.id,
      status: subscription.status,
      summary: `Waiting for ${provider}.${event} on ${resource}${expiryNote}.`,
    };
  },
});
