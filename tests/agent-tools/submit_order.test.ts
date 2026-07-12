import assert from "node:assert/strict";
import { test } from "node:test";

import submitOrder from "../../agent/tools/submit_order.ts";

// Lives outside agent/tools/ on purpose: eve's discovery scans every .ts
// file directly under agent/tools/ as a tool definition and the model-facing
// name must be a bare identifier, so a *.test.ts file there fails discovery
// and blocks `pnpm dev`/`pnpm build` outright (no "not a tool" exception).
// catalog/*.test.ts can colocate because catalog/ isn't a discovery-scanned
// directory; agent/tools/ tests need a separate home instead.

// eve's public ToolDefinition types inputSchema as StandardJSONSchemaV1 |
// JsonObject (the interop surface it accepts — Zod, Standard Schema, or a
// plain JSON Schema object), which only declares a `jsonSchema` converter,
// not Zod's own `safeParse`. The object we actually passed to defineTool is
// a real Zod schema, so `safeParse` exists on it at runtime; this narrow
// structural cast is just recovering the one method this file needs.
const inputSchema = submitOrder.inputSchema as unknown as {
  safeParse: (input: unknown) => { success: boolean };
};

// Zod schema behavior only — no live Alpaca call, no approval flow. Verifies
// the input contract a tool call must satisfy before execute() ever runs.
test("submit_order rejects a notional below Alpaca's $1 minimum", () => {
  const result = inputSchema.safeParse({ symbol: "NVDA", notionalUsd: 0.5 });
  assert.equal(result.success, false);
});

test("submit_order rejects a zero notional", () => {
  const result = inputSchema.safeParse({ symbol: "NVDA", notionalUsd: 0 });
  assert.equal(result.success, false);
});

test("submit_order accepts a notional at or above the $1 minimum", () => {
  const result = inputSchema.safeParse({ symbol: "NVDA", notionalUsd: 1 });
  assert.equal(result.success, true);
});
