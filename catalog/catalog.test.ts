import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { assertCatalogHonesty, EVENT_TYPES, search, subscribe } from "./catalog.ts";

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
        conversationId: "test-conv",
        provider: "nonexistent-provider",
        event: "nonexistent.event",
        resource: "NVDA",
        params: {},
      }),
    /unknown event type/,
  );
});

test("subscribe rejects params that fail the event type's JSON Schema, naming the bad field", async () => {
  await assert.rejects(
    () =>
      subscribe({
        conversationId: "test-conv",
        provider: "alpaca",
        event: "price.crossesBelow",
        resource: "NVDA",
        // threshold must be a number; this predicate can never fire as a string.
        params: { threshold: "not-a-number" },
      }),
    /threshold/,
  );
});

test("subscribe accepts params that satisfy the event type's JSON Schema", async () => {
  const sub = await subscribe({
    conversationId: `test-${randomUUID()}`,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 150 },
  });

  assert.equal(sub.status, "pending");
  assert.deepEqual(sub.params, { threshold: 150 });
});

test("assertCatalogHonesty passes while every catalog.json entry is status: planned", () => {
  // No providers are registered anywhere in this codebase yet (task #4 adds
  // alpaca); every current entry is intentionally "planned", so the check
  // must not throw. Once an entry flips to "active" without a matching
  // registerProvider() call, this test's sibling below is what catches it.
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
