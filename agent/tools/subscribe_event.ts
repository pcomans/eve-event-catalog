import { defineTool } from "eve/tools";
import { z } from "zod";

import { EVENT_TYPES, subscribe } from "#catalog/catalog.ts";
import { getConversationBySessionId } from "#catalog/registry.ts";

// Subscriptions are keyed by conversationId (the channel's continuation
// token — see agent/channels/catalog.ts), but a tool's ctx only exposes
// ctx.session.id, the eve-assigned sessionId. recordConversation writes a
// sessionId -> conversationId reverse index precisely so a tool can recover
// its own conversationId without the channel threading it through some
// other mechanism.

/** The subset of JSON Schema catalog.json's param fields actually use. */
interface ParamFieldSchema {
  type?: string;
  items?: ParamFieldSchema;
  description?: string;
}

function zodForJsonType(schema: ParamFieldSchema, field: string): z.ZodType {
  switch (schema.type) {
    case "string":
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(schema.items ? zodForJsonType(schema.items, field) : z.unknown());
    default:
      throw new Error(
        `subscribe_event cannot describe catalog.json's param "${field}" (type: ${schema.type}) to the model — ` +
          `extend zodForJsonType to cover it.`,
      );
  }
}

/**
 * Builds `params`' input schema from catalog.json instead of declaring it a
 * free-form record. eve compiles this Zod schema to JSON Schema at build
 * time (`compileToolEntry`, eve dist/src/compiler/normalize-tool.js) and
 * that JSON Schema is all the model's provider ever sees — and
 * `z.record(z.string(), z.unknown())` compiles to an object with NO declared
 * properties (`{"type":"object","propertyNames":{"type":"string"},
 * "additionalProperties":{}}`), leaving a streaming tool-call argument
 * parser nothing to bind values to. That matches the production symptom
 * exactly (2026-08-07 onward): every event type REQUIRING params got
 * `params: {}` while every event type requiring none armed fine, with the
 * model itself reporting it had intended to send the right value. Named,
 * typed fields are the fix hypothesis.
 *
 * Generated, never hand-listed: catalog.json stays the single source of
 * truth (AGENTS.md rule 4), so a param field added there is described to the
 * model without a matching edit here and the two cannot drift apart.
 *
 * Deliberately permissive — every field optional, no value constraints
 * (threshold's exclusiveMinimum, `at`'s futureDatetime, per-event required[],
 * additionalProperties: false) and unknown keys passed through. subscribe()'s
 * Ajv validators, compiled from the same catalog.json, stay the ONLY place
 * params are judged: they reject with the offending field AND the full schema
 * quoted, which the model can act on inside the same turn. A second, partial
 * validator here would only produce worse rejections for the same inputs.
 */
function buildParamsSchema(): z.ZodType<Record<string, unknown>> {
  const declared = new Map<string, { schema: ParamFieldSchema; owners: string[] }>();
  for (const eventType of EVENT_TYPES) {
    const properties = (eventType.params.properties ?? {}) as Record<string, ParamFieldSchema>;
    for (const [field, schema] of Object.entries(properties)) {
      const existing = declared.get(field);
      if (!existing) {
        declared.set(field, { schema, owners: [`${eventType.provider}.${eventType.event}`] });
        continue;
      }
      // One field name, one type — otherwise a single declared property
      // would have to lie about one of the event types that uses it.
      if (existing.schema.type !== schema.type) {
        throw new Error(
          `catalog.json declares param "${field}" as "${existing.schema.type}" for ` +
            `${existing.owners.join(", ")} but as "${schema.type}" for ${eventType.provider}.${eventType.event}.`,
        );
      }
      existing.owners.push(`${eventType.provider}.${eventType.event}`);
    }
  }

  const shape = Object.fromEntries(
    [...declared].map(([field, { schema, owners }]) => [
      field,
      zodForJsonType(schema, field)
        .optional()
        .describe(`For ${owners.join(", ")}. ${schema.description ?? ""}`.trim()),
    ]),
  );
  return z.looseObject(shape);
}

export default defineTool({
  description:
    "Subscribe to an event type found via search_events — the only way to wait on an external " +
    "condition; never poll or guess a schedule instead. `params` must satisfy the JSON Schema " +
    "search_events returned for this exact provider/event pair. A rejection here (unknown event type, " +
    "a still-planned provider, or params that fail the schema) is returned as the tool result with the " +
    "specific problem named — read it and correct the call in this same turn rather than repeating it " +
    "unchanged. After a successful call: tell the user, in one sentence, what you're waiting for and " +
    "until when; once every subscription this turn needs has been made (subscribing to several " +
    "events in one turn is normal), end your turn — do not loop, sleep, or re-check yourself. The Event Catalog wakes " +
    "this same conversation with a \"[event-catalog wake]\" message (carrying that event type's own " +
    "onWake guidance) when the predicate fires or the subscription expires.",
  inputSchema: z.object({
    provider: z.string().min(1).describe('Provider name from search_events, e.g. "alpaca".'),
    event: z.string().min(1).describe('Event name from search_events, e.g. "price.crossesBelow".'),
    resource: z
      .string()
      .min(1)
      .describe("The thing being watched: a ticker symbol, an order id, etc., per the event's description."),
    params: buildParamsSchema().describe(
      "Predicate params for the event type named above, matching the JSON Schema search_events " +
        "returned for it, e.g. { \"threshold\": 150 }. Every field here is optional because each one " +
        "belongs to specific event types (named in its own description): send exactly the ones that " +
        "event type requires and omit the rest — {} for an event type that takes no params.",
    ),
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
