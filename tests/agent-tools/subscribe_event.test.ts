import assert from "node:assert/strict";
import { test } from "node:test";

import { asSchema } from "ai";
import Ajv from "ajv";

import subscribeEvent from "../../agent/tools/subscribe_event.ts";
import catalogData from "../../catalog/catalog.json" with { type: "json" };

// Lives outside agent/tools/ on purpose (AGENTS.md rule 7): eve's discovery
// scans every .ts file directly under agent/tools/ as a tool definition, so a
// *.test.ts file there breaks `pnpm dev`/`pnpm build` outright.
//
// What these tests are about: the JSON Schema the MODEL sees for `params`.
// There are TWO conversions of the same Zod schema and they do not agree:
//
//   compile time -- inputSchema["~standard"].jsonSchema.input({target}), what
//     eve bakes into the build manifest. Emits "additionalProperties": {}.
//   RUNTIME ------- what the provider is actually handed. eve resolves
//     `inputSchema: r.inputStandardSchema ?? jsonSchema(...)` (eve
//     dist/src/execution/node-step.js, resolveHarnessToolDefinition), i.e. the
//     LIVE Zod schema, which goes tool() -> asSchema -> zod4Schema ->
//     z4.toJSONSchema -> addAdditionalPropertiesToJsonSchema
//     (@ai-sdk/provider-utils), and that last step force-sets
//     "additionalProperties": FALSE on every object, unconditionally.
//
// That divergence IS the 2026-08-07 production bug (KNOWN_ISSUES #20). With
// `params` declared `z.record(z.string(), z.unknown())` the runtime schema was
//   {"type":"object","propertyNames":{"type":"string"},"additionalProperties":false}
// -- additionalProperties:false plus zero declared properties admits exactly
// one value, `{}`. A provider doing constrained tool decoding (Fireworks)
// physically could not emit `{"threshold": 300}`; the manifest, meanwhile,
// looked permissive. So the assertions that matter run against the RUNTIME
// conversion; a test written against the compile-time one passes happily on
// the broken schema and proves nothing.
//
// These tests read catalog.json directly, so they also serve as the drift
// guard AGENTS.md rule 4 demands: catalog.json is the single source of truth,
// and a param field added there must show up in what the model is shown.

// Every param field an ACTIVE catalog entry declares, name -> JSON Schema
// type. The "active" filter mirrors buildParamsSchema deliberately: a
// "planned" entry has no working provider and subscribe() rejects it
// outright, so advertising its params to the model would be advertising what
// isn't implemented (rule 4). Without this filter the drift guard below would
// fail a CORRECT implementation the moment someone adds an honest planned
// entry with a new field — and the obvious way to "fix" that failure is to
// start advertising planned fields, which is the thing rule 4 forbids.
const catalogParamTypes = new Map<string, string>();
for (const eventType of catalogData.eventTypes) {
  if (eventType.status === "planned") continue;
  for (const [name, schema] of Object.entries(eventType.params.properties ?? {})) {
    catalogParamTypes.set(name, (schema as { type: string }).type);
  }
}

// The exact conversion eve performs at compile time, via Standard Schema's
// own converter -- not an approximation of it.
const inputSchema = subscribeEvent.inputSchema as unknown as {
  "~standard": {
    jsonSchema: { input: (options: { target: "draft-07" }) => Record<string, unknown> };
  };
  parse: (input: unknown) => { params: Record<string, unknown> };
};

const emitted = inputSchema["~standard"].jsonSchema.input({ target: "draft-07" });
const emittedParams = (emitted.properties as Record<string, Record<string, unknown>>).params;

function parseCall(params: Record<string, unknown>): Record<string, unknown> {
  return inputSchema.parse({
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params,
  }).params;
}

test("the params JSON Schema the model sees declares named properties", () => {
  const properties = emittedParams.properties as Record<string, unknown> | undefined;
  assert.ok(
    properties && Object.keys(properties).length > 0,
    `params has no declared properties -- the model has nothing to bind arguments to. Emitted: ${JSON.stringify(emittedParams)}`,
  );
});

test("params declares exactly the fields catalog.json declares, with matching types", () => {
  const properties = (emittedParams.properties ?? {}) as Record<string, { type?: unknown }>;
  assert.deepEqual(Object.keys(properties).sort(), [...catalogParamTypes.keys()].sort());
  for (const [name, type] of catalogParamTypes) {
    assert.equal(properties[name]?.type, type, `params.${name} should be typed "${type}"`);
  }
});

test("a threshold survives the tool's own input schema intact", () => {
  assert.deepEqual(parseCall({ threshold: 300 }), { threshold: 300 });
});

test("an at datetime and a formTypes array survive intact", () => {
  const at = "2027-01-04T14:30:00Z";
  assert.deepEqual(parseCall({ at }), { at });
  assert.deepEqual(parseCall({ formTypes: ["8-K"] }), { formTypes: ["8-K"] });
});

test("no-params event types can still send an empty params object", () => {
  assert.deepEqual(parseCall({}), {});
});

// Ajv (catalog/catalog.ts subscribe()) is the single enforcement point for
// what is legal. Zod's job here is only to give the model named fields to
// bind to and then get out of the way, so anything that DOES arrive reaches
// subscribe() and gets Ajv's rejection -- the one that quotes catalog.json's
// schema back and can be acted on in the same turn.
//
// Note the deliberate asymmetry, and do not "fix" it: Zod stays loose, but
// the schema the model is SHOWN is closed (additionalProperties:false, forced
// by the AI SDK and not opt-out-able -- see the runtime test below). So this
// is about what survives the parse, not about what the model may send.
test("Zod stays loose so anything that arrives still reaches Ajv", () => {
  const at = "2027-01-04T14:30:00Z";
  // `at` belongs to clock.time.at, not alpaca.price.crossesBelow: Ajv's job.
  assert.deepEqual(parseCall({ at }), { at });
  // A field no catalog entry declares must still reach subscribe(), so the
  // rejection the model reads is Ajv's (which quotes the full schema).
  assert.deepEqual(parseCall({ notAField: 1 }), { notAField: 1 });
});

/**
 * The assertion that would have caught the incident, and the only one here
 * that runs against the schema the provider is ACTUALLY handed.
 *
 * Every test above uses eve's compile-time conversion. That conversion emitted
 * `"additionalProperties": {}` for the broken free-form schema and so looked
 * harmless; the runtime path emitted `"additionalProperties": false`, which
 * against zero declared properties admits exactly one value -- `{}`. A
 * provider that decodes tool calls against the schema could not emit a
 * threshold at all. Tests written against the compile-time conversion passed
 * happily throughout (KNOWN_ISSUES #20).
 *
 * So this asserts the property that actually matters -- a real threshold
 * VALIDATES against the emitted schema -- and pins the counterfactual: the
 * same schema stripped of its declared properties rejects it. Without that
 * second half the test would still pass on a property-less schema whose
 * additionalProperties the AI SDK had merely stopped closing.
 */
test("the RUNTIME schema handed to the provider actually admits a threshold", () => {
  const runtimeParams = (
    asSchema(subscribeEvent.inputSchema as never).jsonSchema.properties as Record<string, Record<string, unknown>>
  ).params;

  assert.equal(
    (runtimeParams.properties as Record<string, { type?: unknown }>)?.threshold?.type,
    "number",
    `runtime params schema declares no typed threshold. Emitted: ${JSON.stringify(runtimeParams)}`,
  );

  const ajv = new Ajv({ strict: false });
  assert.ok(
    ajv.compile(runtimeParams)({ threshold: 300 }),
    `the model cannot send a threshold: {"threshold":300} is invalid against ${JSON.stringify(runtimeParams)}`,
  );

  // The counterfactual — the exact shape that broke production.
  const withoutProperties = { ...runtimeParams };
  delete withoutProperties.properties;
  assert.equal(
    ajv.compile(withoutProperties)({ threshold: 300 }),
    false,
    "expected a property-less closed object to reject a threshold — if this passes, additionalProperties is no longer being closed and this test has stopped guarding anything",
  );
});
