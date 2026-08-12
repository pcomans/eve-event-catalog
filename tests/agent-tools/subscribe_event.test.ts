import assert from "node:assert/strict";
import { test } from "node:test";

import subscribeEvent from "../../agent/tools/subscribe_event.ts";
import catalogData from "../../catalog/catalog.json" with { type: "json" };

// Lives outside agent/tools/ on purpose (AGENTS.md rule 7): eve's discovery
// scans every .ts file directly under agent/tools/ as a tool definition, so a
// *.test.ts file there breaks `pnpm dev`/`pnpm build` outright.
//
// What these tests are about: the JSON Schema the MODEL sees for `params`.
// eve compiles a tool's Zod `inputSchema` to draft-07 JSON Schema at build
// time (`compileToolEntry` -> `normalizeJsonSchemaDefinition`, eve
// dist/src/compiler/normalize-tool.js + dist/src/shared/json-schema.js) and
// bakes the result into the manifest the provider is handed. Declared as
// `z.record(z.string(), z.unknown())`, `params` compiles to an object with
// NO declared properties -- nothing for a streaming tool-call argument parser
// to bind to, which is the leading hypothesis for the production symptom
// where the agent intends `{"threshold": 300}` and an empty object arrives
// (2026-08-10; every event type requiring params failed, every one requiring
// none succeeded).
//
// These tests read catalog.json directly, so they also serve as the drift
// guard AGENTS.md rule 4 demands: catalog.json is the single source of truth,
// and a param field added there must show up in what the model is shown.

// Every param field any catalog entry declares, name -> JSON Schema type.
const catalogParamTypes = new Map<string, string>();
for (const eventType of catalogData.eventTypes) {
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
// what is legal. The tool's schema exists to give the model named fields to
// bind to, and must stay strictly MORE permissive than Ajv -- otherwise a
// rejection happens somewhere that can't quote catalog.json's schema back,
// and two validators drift apart.
test("the tool's schema does not second-guess Ajv: cross-event and unknown params pass through", () => {
  const at = "2027-01-04T14:30:00Z";
  // `at` belongs to clock.time.at, not alpaca.price.crossesBelow: Ajv's job.
  assert.deepEqual(parseCall({ at }), { at });
  // A field no catalog entry declares must still reach subscribe(), so the
  // rejection the model reads is Ajv's (which quotes the full schema).
  assert.deepEqual(parseCall({ notAField: 1 }), { notAField: 1 });
});
