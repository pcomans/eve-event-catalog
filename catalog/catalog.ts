import Ajv, { type ErrorObject, type SchemaValidateFunction, type ValidateFunction } from "ajv";

import type { EventType, Subscription } from "./types.ts";
import { createSubscription, type NewSubscriptionInput } from "./registry.ts";
import catalogData from "./catalog.json" with { type: "json" };

// The catalog is a data file (catalog.json), not a code constant, so it can
// be read and edited without touching TypeScript. Each entry's `params` is
// hand-written JSON Schema: discovery documentation for the model AND (via
// Ajv, below) the enforced validator — one schema, two jobs. Imported (not
// read via fs + import.meta.url) so eve's bundler can see and inline it —
// runtime file paths don't survive eve's compile step.
export const EVENT_TYPES = catalogData.eventTypes as EventType[];

// A duplicate provider.event entry would silently overwrite its own Ajv
// validator below (Map key collision) — fail loudly at load instead.
{
  const seen = new Set<string>();
  for (const eventType of EVENT_TYPES) {
    const key = `${eventType.provider}.${eventType.event}`;
    if (seen.has(key)) throw new Error(`catalog.json has a duplicate event type: ${key}`);
    seen.add(key);
  }
}

// Compiled once at load time, keyed by "provider.event" — the same schema
// search_events shows the model is the one enforced in subscribe().
const ajv = new Ajv({ allErrors: true });

// Custom keyword for the one class of constraint static JSON Schema can't
// express: a rule that depends on the CURRENT moment, not just the shape of
// the data — e.g. clock.time.at's `at` needing to be a real, parseable, and
// (right now) still-future datetime. Kept entirely inside Ajv (no
// dependency on the providers registry below) deliberately: an earlier
// version of this check lived on a Provider.validateParams hook, called
// from subscribe() via getProvider() — but eve's runtime evaluates this
// module more than once across its own bundling/sandboxing contexts, each
// with its OWN independent `providers` Map, and subscribe() doesn't
// reliably run in the same instance that ran the provider-registering
// imports (agent/channels/catalog.ts's side-effecting imports of
// alpaca.ts/edgar.ts/clock.ts). Ajv validators, compiled from catalog.json
// alone with no cross-module state, don't have that problem — found via a
// live end-to-end check (a past `at` was silently accepted through the real
// subscribe_event tool despite passing red-green in isolated node:test
// runs); see git history for the debug trail.
// Requires an EXPLICIT offset (Z or ±HH:MM) — `new Date("2026-07-13T09:30:00")`
// (no offset) silently parses as *local time to the server*, which is a
// trap for a distributed system with no fixed server timezone. Captures the
// wall-clock components separately from the offset so they can be
// round-trip-validated below (JS silently normalizes an impossible date
// like 2026-02-30 into March 2 instead of rejecting it).
const ISO_DATETIME_NO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/;
// The offset itself is range-constrained (00-14 hours, 00-59 minutes —
// covers every real-world UTC offset, -12:00 to +14:00) rather than
// accepting any two digits: an unconstrained `\d{2}:\d{2}` matches garbage
// like "+99:99", which `new Date()` turns into a non-finite (NaN) instant
// — and NaN <= Date.now() is always false, so the "must be in the future"
// check below would never trip and silently let it through.
const ISO_DATETIME_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;

function setKeywordError(message: string): void {
  futureDatetimeValidate.errors = [{ message } as Partial<ErrorObject>];
}

const futureDatetimeValidate: SchemaValidateFunction = (schemaValue: unknown, data: unknown): boolean => {
  if (!schemaValue) return true;

  if (typeof data !== "string") {
    setKeywordError("is not a valid ISO-8601 datetime string");
    return false;
  }
  if (ISO_DATETIME_NO_OFFSET.test(data)) {
    setKeywordError(`must include an explicit UTC offset, e.g. "${data}Z"`);
    return false;
  }
  const match = ISO_DATETIME_WITH_OFFSET.exec(data);
  if (!match) {
    setKeywordError('is not a valid ISO-8601 datetime string (with explicit offset, e.g. "2026-07-13T13:30:00Z")');
    return false;
  }

  // Round-trip the wall-clock components through Date.UTC and back: JS
  // normalizes an out-of-range field (e.g. day 30 in February) instead of
  // rejecting it, so a value that doesn't survive the round trip unchanged
  // was never a real calendar date/time to begin with.
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = Number(secondStr);
  const roundTripped = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const survivedRoundTrip =
    roundTripped.getUTCFullYear() === year &&
    roundTripped.getUTCMonth() === month - 1 &&
    roundTripped.getUTCDate() === day &&
    roundTripped.getUTCHours() === hour &&
    roundTripped.getUTCMinutes() === minute &&
    roundTripped.getUTCSeconds() === second;
  if (!survivedRoundTrip) {
    setKeywordError(`"${data}" is not a real calendar date/time (a field is out of range, e.g. day 30 in February)`);
    return false;
  }

  // Paranoid catch-all: even with the offset range constrained above, a
  // non-finite instant must never silently pass — NaN <= Date.now() is
  // always false, which would otherwise read as "not in the past."
  const instant = new Date(data).getTime();
  if (!Number.isFinite(instant)) {
    setKeywordError(`"${data}" does not parse to a valid instant`);
    return false;
  }
  if (instant <= Date.now()) {
    setKeywordError("must be strictly in the future");
    return false;
  }
  return true;
};

ajv.addKeyword({
  keyword: "futureDatetime",
  schemaType: "boolean",
  errors: true,
  validate: futureDatetimeValidate,
});

const validators = new Map<string, ValidateFunction>(
  EVENT_TYPES.map((eventType) => [`${eventType.provider}.${eventType.event}`, ajv.compile(eventType.params)]),
);

export function findEventType(provider: string, event: string): EventType | undefined {
  return EVENT_TYPES.find((eventType) => eventType.provider === provider && eventType.event === event);
}

export interface SearchResult extends EventType {
  score: number;
}

/**
 * Keyword scoring over provider/event/description/tags. No embeddings, no
 * LLM calls — the model does the semantic reasoning; this just ranks
 * candidates and returns full metadata (including `status`, so a "planned"
 * event type is clearly labeled as not yet available) so it can pick a
 * source for real reasons.
 */
export function search(query: string): SearchResult[] {
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
  return EVENT_TYPES.map((eventType) => {
    const haystack =
      `${eventType.provider} ${eventType.event} ${eventType.description} ${eventType.tags.join(" ")}`.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
    return { ...eventType, score };
  })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score);
}

export interface SubscribeInput {
  conversationId: string;
  provider: string;
  event: string;
  resource: string;
  params: Record<string, unknown>;
  expiresAt?: string;
}

function formatAjvErrors(validate: ValidateFunction): string {
  return (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`).join("; ");
}

/**
 * Validates the event type and params against catalog.json's JSON Schema,
 * then creates a "pending" registry entry. Both checks happen here, at
 * subscribe time (inside the same turn), rather than at arm time (after the
 * turn ends) — so the model sees and can correct a bad call immediately,
 * instead of the subscription silently dying later as "failed".
 */
export async function subscribe(input: SubscribeInput): Promise<Subscription> {
  const eventType = findEventType(input.provider, input.event);
  if (!eventType) throw new Error(`unknown event type: ${input.provider}.${input.event}`);

  if (eventType.status === "planned") {
    throw new Error(
      `${input.provider}.${input.event} is in the catalog but its provider is not implemented yet ` +
        `(status: planned). Choose a different event type, or tell the user this one isn't available yet.`,
    );
  }

  const validate = validators.get(`${input.provider}.${input.event}`)!;
  if (!validate(input.params)) {
    throw new Error(`invalid params for ${input.provider}.${input.event}: ${formatAjvErrors(validate)}`);
  }

  const newSubscription: NewSubscriptionInput = {
    conversationId: input.conversationId,
    provider: input.provider,
    event: input.event,
    resource: input.resource,
    params: input.params,
    expiresAt: input.expiresAt ?? null,
  };
  return createSubscription(newSubscription);
}

export interface Provider {
  /** Event names (e.g. "price.crossesBelow") this provider actually implements arm/disarm for. */
  supportedEvents: string[];
  arm(sub: Subscription): void | Promise<void>;
  disarm(sub: Subscription): void | Promise<void>;
}

const providers = new Map<string, Provider>();

export function registerProvider(name: string, provider: Provider): void {
  providers.set(name, provider);
}

/** Throws "unknown provider" for anything not yet registered — task #4 registers alpaca, a later task registers edgar. */
export function getProvider(name: string): Provider {
  const provider = providers.get(name);
  if (!provider) throw new Error(`unknown provider: ${name}`);
  return provider;
}

export function hasProvider(name: string): boolean {
  return providers.has(name);
}

/**
 * True only if `name` is registered AND declares `event` in its
 * `supportedEvents` — registering a provider does not, by itself, vouch for
 * every event catalog.json lists under that provider's name.
 */
export function isEventSupported(provider: string, event: string): boolean {
  return providers.get(provider)?.supportedEvents.includes(event) ?? false;
}

/**
 * Fails loudly if catalog.json advertises an "active" event type with no
 * matching registered-and-supporting provider. Call this once, after all
 * providers for the current build are registered (e.g. at the bottom of
 * agent/channels/catalog.ts, after any provider-registering imports run —
 * ES module imports fully evaluate before the importing module's own
 * top-level code, so a provider registered via a top-of-file import is
 * guaranteed visible here). "planned" entries are exempt by design — that
 * status exists precisely for events not implemented yet. Task #4 must, as
 * part of registering the real alpaca provider: declare `supportedEvents`
 * for what it actually implements, flip the matching catalog.json entries
 * from "planned" to "active", and call this. Task #8 does the same for
 * edgar.
 */
export function assertCatalogHonesty(): void {
  const unimplemented = EVENT_TYPES.filter(
    (eventType) => eventType.status !== "planned" && !isEventSupported(eventType.provider, eventType.event),
  );
  if (unimplemented.length > 0) {
    const names = unimplemented.map((e) => `${e.provider}.${e.event}`).join(", ");
    throw new Error(
      `catalog.json advertises event types with no registered, supporting provider: ${names}. ` +
        `Register the provider (with this event in its supportedEvents), or mark the entry ` +
        `"status": "planned" until it exists.`,
    );
  }
}
