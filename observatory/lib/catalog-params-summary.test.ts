import assert from "node:assert/strict";
import { test } from "node:test";

import { summarizeParamsSchema } from "./catalog-params-summary.ts";

// Real fixtures lifted straight from catalog/catalog.json — this function
// exists to turn THOSE exact JSON Schema shapes into a human-readable list
// for the Catalog page (task #34), not raw JSON Schema dumps.

test("summarizeParamsSchema: a single required number field (alpaca price.crossesBelow)", () => {
  const schema = {
    type: "object",
    properties: {
      threshold: {
        type: "number",
        exclusiveMinimum: 0,
        description: "Price level in USD. Fires when the trade price crosses from at-or-above this value to below it.",
      },
    },
    required: ["threshold"],
    additionalProperties: false,
  };

  assert.deepEqual(summarizeParamsSchema(schema), [
    {
      name: "threshold",
      type: "number",
      required: true,
      description: "Price level in USD. Fires when the trade price crosses from at-or-above this value to below it.",
    },
  ]);
});

test("summarizeParamsSchema: an optional array field describes its item type (edgar filing.new)", () => {
  const schema = {
    type: "object",
    properties: {
      formTypes: {
        type: "array",
        items: { type: "string" },
        description: 'Optional filter, e.g. ["8-K", "10-Q"]. Omit to match any filing type.',
      },
    },
    additionalProperties: false,
  };

  assert.deepEqual(summarizeParamsSchema(schema), [
    {
      name: "formTypes",
      type: "array of string",
      required: false,
      description: 'Optional filter, e.g. ["8-K", "10-Q"]. Omit to match any filing type.',
    },
  ]);
});

test("summarizeParamsSchema: no properties at all returns an empty list, not a throw (alpaca order.filled)", () => {
  const schema = { type: "object", properties: {}, additionalProperties: false };
  assert.deepEqual(summarizeParamsSchema(schema), []);
});

test("summarizeParamsSchema: a field with no description gets null, not undefined or a crash", () => {
  const schema = { type: "object", properties: { at: { type: "string" } }, required: ["at"] };
  assert.deepEqual(summarizeParamsSchema(schema), [{ name: "at", type: "string", required: true, description: null }]);
});

test("summarizeParamsSchema: a field whose type is missing/unrecognized falls back to 'unknown' rather than crashing", () => {
  const schema = { type: "object", properties: { mystery: {} } };
  assert.deepEqual(summarizeParamsSchema(schema), [{ name: "mystery", type: "unknown", required: false, description: null }]);
});

// p6k gate (MED): catalog.json is asserted to EventType[], not runtime-
// validated — a malformed entry (params itself absent/null, or one
// property's own schema being null) must return `null` (schema
// unavailable), never throw, since this runs inside a Server Component
// render (app/catalog/page.tsx). `null` is deliberately distinct from `[]`
// ("a valid schema that legitimately declares zero properties").
test("summarizeParamsSchema: params itself missing/null/not-an-object returns null (schema unavailable), never throws", () => {
  assert.equal(summarizeParamsSchema(undefined), null);
  assert.equal(summarizeParamsSchema(null), null);
  assert.equal(summarizeParamsSchema("not an object"), null);
  assert.equal(summarizeParamsSchema({ type: "object", properties: null }), null);
});

test("summarizeParamsSchema: one malformed property value (null) does not abort the whole list — falls back to unknown/null for that field only", () => {
  const schema = {
    type: "object",
    properties: {
      healthy: { type: "string", description: "a fine field" },
      corrupt: null,
    },
    required: ["healthy"],
  };

  assert.deepEqual(summarizeParamsSchema(schema), [
    { name: "healthy", type: "string", required: true, description: "a fine field" },
    { name: "corrupt", type: "unknown", required: false, description: null },
  ]);
});

// p6l gate (LOW): `[]` must stay reserved STRICTLY for a usable object
// schema with zero declared fields — an array is never a valid JSON Schema
// object node, even though `typeof [] === "object"` in JS.
test("summarizeParamsSchema: an array schema, or an array properties field, is invalid — returns null, not []", () => {
  assert.equal(summarizeParamsSchema([]), null);
  assert.equal(summarizeParamsSchema({ type: "object", properties: [] }), null);
});

// p6l gate (LOW): a schema that isn't type:"object" at all must never be
// treated as "valid and empty," even if it happens to carry a
// syntactically fine (but semantically irrelevant) `properties: {}`.
test("summarizeParamsSchema: a non-object top-level schema type is invalid even with an otherwise-valid empty properties field — returns null, not []", () => {
  assert.equal(summarizeParamsSchema({ type: "string", properties: {} }), null);
});
