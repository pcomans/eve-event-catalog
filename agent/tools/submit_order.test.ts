import assert from "node:assert/strict";
import { test } from "node:test";

import submitOrder from "./submit_order.ts";

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
// Not yet wired into package.json's "test" script glob (catalog/*.test.ts,
// catalog/providers/*.test.ts) — run directly with
// `node --test agent/tools/submit_order.test.ts` until that's extended to
// cover agent/tools/*.test.ts too.
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
