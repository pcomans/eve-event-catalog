import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { assertCatalogHonesty, EVENT_TYPES, registerProvider, search, subscribe } from "./catalog.ts";
import { deleteSubscription } from "./registry.ts";

/**
 * Every catalog.json entry is "planned" until its provider is registered
 * (see the assertCatalogHonesty doc comment in catalog.ts). subscribe()
 * rejects planned entries outright, so testing the Ajv-validation path
 * needs a temporarily-"active" entry. Flips it for the duration of `fn`
 * and always restores it — EVENT_TYPES is shared module state.
 */
async function withActiveEventType<T>(provider: string, event: string, fn: () => Promise<T> | T): Promise<T> {
  const entry = EVENT_TYPES.find((e) => e.provider === provider && e.event === event)!;
  const original = entry.status;
  entry.status = "active";
  try {
    return await fn();
  } finally {
    entry.status = original;
  }
}

/**
 * Mirror of withActiveEventType: every catalog.json entry is "active" as of
 * task #8 (edgar.filing.new was the last one still "planned"), so exercising
 * the "planned" code paths (subscribe's rejection, search's labeling) needs a
 * temporarily-"planned" entry instead of a naturally-occurring one. Flips it
 * for the duration of `fn` and always restores it.
 */
async function withPlannedEventType<T>(provider: string, event: string, fn: () => Promise<T> | T): Promise<T> {
  const entry = EVENT_TYPES.find((e) => e.provider === provider && e.event === event)!;
  const original = entry.status;
  entry.status = "planned";
  try {
    return await fn();
  } finally {
    entry.status = original;
  }
}

test("search ranks event types by keyword overlap and returns full provider metadata", () => {
  const results = search("realtime NVDA price drop below a threshold");

  assert.ok(results.length > 0, "expected at least one match");
  assert.equal(results[0].provider, "alpaca");
  assert.equal(results[0].event, "price.crossesBelow");
  // Metadata must be present so the model can reason about tradeoffs, not just the event name.
  assert.equal(results[0].metadata.freshness, "realtime");
  assert.ok(results[0].metadata.latency.length > 0);
  assert.ok(results[0].metadata.auth.length > 0);
  assert.ok(results[0].metadata.cost.length > 0);
  // alpaca went "active" in task #4 — this result is genuinely usable now.
  assert.equal(results[0].status, "active");
  // Wakes carry their manual: onWake is discoverable up front, not just at fire time.
  assert.ok(results[0].onWake.length > 0);
});

test("every catalog.json entry declares non-empty onWake guidance — wakes always carry their manual", () => {
  for (const eventType of EVENT_TYPES) {
    assert.ok(
      eventType.onWake && eventType.onWake.length > 0,
      `${eventType.provider}.${eventType.event} is missing onWake guidance`,
    );
  }
});

test("search clearly labels a 'planned' entry as such, not silently offered as usable", async () => {
  await withPlannedEventType("edgar", "filing.new", () => {
    const results = search("SEC filing 8-K regulatory");
    assert.ok(results.length > 0, "expected at least one match");
    assert.equal(results[0].provider, "edgar");
    assert.equal(results[0].status, "planned");
  });
});

test("search returns an empty list for a query with no keyword overlap", () => {
  const results = search("zzz nonexistent gibberish qqq");
  assert.deepEqual(results, []);
});

test("search ranks a more specific query above a generic one for the same event type", () => {
  const specific = search("crossesBelow threshold price alpaca");
  const generic = search("price");

  assert.ok(specific[0].score >= generic[0].score);
});

test("subscribe rejects an unknown provider/event pair before touching the registry", async () => {
  await assert.rejects(
    () =>
      subscribe({
        conversationId: "test:unknown-event",
        provider: "nonexistent-provider",
        event: "nonexistent.event",
        resource: "NVDA",
        params: {},
      }),
    /unknown event type/,
  );
});

test("subscribe rejects a 'planned' event type immediately, before validating params", async () => {
  // All of catalog.json is "active" as of task #8 — temporarily flip edgar
  // back to "planned" to exercise this rejection path (withPlannedEventType).
  await withPlannedEventType("edgar", "filing.new", () =>
    assert.rejects(
      () =>
        subscribe({
          conversationId: "test:planned-rejection",
          provider: "edgar",
          event: "filing.new",
          resource: "AAPL",
          params: { formTypes: "this is not even valid — planned must be checked first" },
        }),
      /not implemented yet/,
    ),
  );
});

test("subscribe rejects params that fail the event type's JSON Schema, naming the bad field", async () => {
  await withActiveEventType("alpaca", "price.crossesBelow", () =>
    assert.rejects(
      () =>
        subscribe({
          conversationId: "test:bad-params",
          provider: "alpaca",
          event: "price.crossesBelow",
          resource: "NVDA",
          // threshold must be a number; this predicate can never fire as a string.
          params: { threshold: "not-a-number" },
        }),
      /threshold/,
    ),
  );
});

test("subscribe accepts params that satisfy the event type's JSON Schema", async (t) => {
  const sub = await withActiveEventType("alpaca", "price.crossesBelow", () =>
    subscribe({
      conversationId: `test:${randomUUID()}`,
      provider: "alpaca",
      event: "price.crossesBelow",
      resource: "NVDA",
      params: { threshold: 150 },
    }),
  );
  t.after(() => deleteSubscription(sub.id));

  assert.equal(sub.status, "pending");
  assert.deepEqual(sub.params, { threshold: 150 });
});

// Ordered before the "passes" test below, deliberately: it depends on
// neither alpaca nor edgar having been registerProvider'd yet in this
// process (the Map registerProvider writes to is shared module state across
// every test in this file), which is only true before any test calls it.
test("assertCatalogHonesty throws when an active event type has no registered provider", () => {
  // Every catalog.json entry is genuinely "active" as of task #8, and none
  // has been registered yet at this point in the file — edgar.filing.new is
  // reused here (rather than flipping a status) since there's no
  // still-"planned" entry left to point at.
  assert.throws(() => assertCatalogHonesty(), /edgar\.filing\.new/);
});

test("assertCatalogHonesty passes once every active event type has a registered, supporting provider", () => {
  // This test file runs isolated from catalog/providers/{alpaca,edgar}.ts
  // (node:test runs each file separately), so it registers stubs matching
  // their real supportedEvents rather than relying on those modules' import
  // side effects.
  registerProvider("alpaca", {
    supportedEvents: ["price.crossesBelow", "price.crossesAbove", "order.filled"],
    arm: async () => {},
    disarm: async () => {},
  });
  registerProvider("edgar", {
    supportedEvents: ["filing.new"],
    arm: async () => {},
    disarm: async () => {},
  });
  registerProvider("clock", {
    supportedEvents: ["time.at"],
    arm: async () => {},
    disarm: async () => {},
  });
  assert.doesNotThrow(() => assertCatalogHonesty());
});

test("assertCatalogHonesty is event-granular: a registered provider doesn't vouch for events outside its supportedEvents", () => {
  const target = EVENT_TYPES.find((e) => e.provider === "alpaca" && e.event === "order.filled")!;
  const originalStatus = target.status;
  target.status = "active";
  // Registers "alpaca" but only declares support for a *different* event —
  // order.filled must still be flagged as unimplemented.
  registerProvider("alpaca", {
    supportedEvents: ["price.crossesBelow"],
    arm: async () => {},
    disarm: async () => {},
  });
  try {
    assert.throws(() => assertCatalogHonesty(), /alpaca\.order\.filled/);
  } finally {
    target.status = originalStatus;
  }
});
