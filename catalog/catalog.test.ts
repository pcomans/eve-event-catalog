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
  // "planned" entries must be clearly labeled, not silently offered as usable.
  assert.equal(results[0].status, "planned");
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
  const entry = EVENT_TYPES.find((e) => e.provider === "alpaca" && e.event === "price.crossesBelow")!;
  assert.equal(entry.status, "planned", "test premise: this entry has no provider registered yet");

  await assert.rejects(
    () =>
      subscribe({
        conversationId: "test:planned-rejection",
        provider: "alpaca",
        event: "price.crossesBelow",
        resource: "NVDA",
        params: { threshold: "this is not even valid — planned must be checked first" },
      }),
    /not implemented yet/,
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

test("assertCatalogHonesty passes while every catalog.json entry is status: planned", () => {
  // No providers are registered anywhere in this codebase yet (task #4 adds
  // alpaca); every current entry is intentionally "planned", so the check
  // must not throw.
  assert.doesNotThrow(() => assertCatalogHonesty());
});

test("assertCatalogHonesty throws when an active event type has no registered provider", () => {
  const entry = EVENT_TYPES.find((e) => e.provider === "edgar" && e.event === "filing.new")!;
  const original = entry.status;
  entry.status = "active"; // simulate the file advertising something unimplemented
  try {
    assert.throws(() => assertCatalogHonesty(), /edgar\.filing\.new/);
  } finally {
    entry.status = original; // restore — this array is shared module state
  }
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
