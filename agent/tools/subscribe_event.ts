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

const showType = (schema: ParamFieldSchema): string =>
  schema.type === "array" ? `array of ${schema.items?.type}` : `${schema.type}`;

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
 * free-form record. `z.record(z.string(), z.unknown())` declares NO
 * properties, and what the model was actually handed for it was
 * `{"type":"object","propertyNames":{"type":"string"},"additionalProperties":false}`
 * — an object schema that admits exactly ONE value, `{}`. That is the proven
 * cause of the 2026-08-07 production incident (KNOWN_ISSUES #20): every event
 * type REQUIRING params got `params: {}` while every event type requiring
 * none armed fine, because `{}` was the only value the model was permitted to
 * emit. Named, typed properties are the fix.
 *
 * Generated, never hand-listed: catalog.json stays the single source of
 * truth (AGENTS.md rule 4), so a param field added there is described to the
 * model without a matching edit here and the two cannot drift apart.
 *
 * What the model sees is CLOSED, and we cannot make it otherwise. eve hands
 * the provider the LIVE Zod schema at runtime (`resolveHarnessToolDefinition`,
 * eve dist/src/execution/node-step.js: `inputSchema: r.inputStandardSchema ??
 * jsonSchema(...)`), not the build-time manifest, and on the way out the AI
 * SDK's `addAdditionalPropertiesToJsonSchema` (@ai-sdk/provider-utils)
 * force-sets `additionalProperties: false` on every object — unconditionally,
 * no opt-out. So the advertised field set IS the complete field set, and a
 * provider that decodes tool calls against the schema (Fireworks does; the
 * incident is what that looks like) can emit nothing else. Declaring every
 * catalog field here is therefore not tidiness, it is the difference between
 * sendable and unsendable.
 *
 * Zod, by contrast, stays as loose as it can — `z.looseObject`, every field
 * optional, and none of the VALUE constraints (threshold's exclusiveMinimum,
 * `at`'s futureDatetime, per-event required[], per-event
 * additionalProperties) — so cross-event and unknown keys reach subscribe()
 * untouched and get Ajv's rejection, which quotes the offending field AND the
 * full schema and can be acted on inside the same turn.
 *
 * It is not literally zero judgement, and the earlier version of this comment
 * overclaimed: declaring a field's TYPE necessarily means Zod checks it, so
 * `{"threshold":"300"}` is rejected here rather than by Ajv, with a worse
 * message. That is the unavoidable price of declaring types at all, and
 * declaring them is the whole fix. It costs nothing real: the types are
 * generated from the same catalog.json Ajv compiles, so the two cannot
 * disagree, and every such input was going to be rejected anyway. What must
 * NOT appear here is a value constraint Ajv also owns — that is where two
 * validators start drifting.
 */
function buildParamsSchema(): z.ZodType<Record<string, unknown>> {
  const declared = new Map<string, { schema: ParamFieldSchema; owners: string[] }>();
  for (const eventType of EVENT_TYPES) {
    // subscribe() rejects "planned" entries outright, so describing their
    // params to the model would advertise what isn't implemented (rule 4).
    if (eventType.status === "planned") continue;
    const properties = (eventType.params.properties ?? {}) as Record<string, ParamFieldSchema>;
    for (const [field, schema] of Object.entries(properties)) {
      const existing = declared.get(field);
      if (!existing) {
        declared.set(field, { schema, owners: [`${eventType.provider}.${eventType.event}`] });
        continue;
      }
      // One field name, one type — otherwise a single declared property would
      // have to lie about one of the event types that uses it. `items.type`
      // counts: array-of-string and array-of-number are different declarations.
      if (existing.schema.type !== schema.type || existing.schema.items?.type !== schema.items?.type) {
        throw new Error(
          `catalog.json declares param "${field}" as "${showType(existing.schema)}" for ` +
            `${existing.owners.join(", ")} but as "${showType(schema)}" for ${eventType.provider}.${eventType.event}.`,
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
        // One owner: its prose is unambiguously about this field. Several
        // owners: it isn't, and picking the first one's prose would state
        // something false about the others — `threshold`'s description is
        // directional, and direction is the entire difference between
        // price.crossesBelow and price.crossesAbove. Point at the per-event
        // schema instead of guessing (rule 4: never tell the model something
        // that isn't so).
        .describe(
          owners.length === 1
            ? `For ${owners[0]}. ${schema.description ?? ""}`.trim()
            : `For ${owners.join(", ")} — see the per-event JSON Schema from search_events for this field's exact meaning.`,
        ),
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
