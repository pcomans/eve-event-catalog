// Turns one catalog.json event type's `params` JSON Schema (Ajv-shaped,
// catalog/catalog.ts's own enforced validator at subscribe() time) into a
// human-readable field list for the Catalog page (task #34) — that page's
// whole point is a non-engineer/skimming Vercel engineer being able to read
// "what does this event need," not a raw JSON Schema dump.

export interface ParamFieldSummary {
  name: string;
  type: string;
  required: boolean;
  description: string | null;
}

// p6l gate (LOW): arrays pass `typeof value === "object" && value !== null`
// in JS, but an array is never a valid JSON Schema OBJECT node — excluded
// explicitly so `params: []` / `properties: []` can't be treated as a
// (vacuously empty) valid object schema.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeType(propertySchema: unknown): string {
  if (!isPlainObject(propertySchema)) return "unknown";
  const type = propertySchema.type;
  if (type === "array") {
    const items = propertySchema.items;
    const itemType = isPlainObject(items) && typeof items.type === "string" ? items.type : "unknown";
    return `array of ${itemType}`;
  }
  return typeof type === "string" ? type : "unknown";
}

/**
 * Every catalog.json params schema so far is a flat `{ type: "object", properties: {...} }` — nested objects/oneOf/etc. aren't summarized specially, they'd just fall back to "object"/"unknown" (accurate, if terse) rather than throwing.
 *
 * p6k gate (MED): `lib/catalog-definition.ts` asserts the imported JSON to
 * `EventType[]` rather than runtime-validating it — a malformed entry
 * (`params` itself missing/null, or a `properties` value that's `null`)
 * must never throw here, because `app/catalog/page.tsx` calls this during
 * SERVER COMPONENT RENDER; an uncaught throw would fail the whole /catalog
 * route (or the production build, since the page is eligible for static
 * generation) over ONE bad field, not just that one card.
 *
 * Returns `null` — not `[]` — when the schema itself is unusable (missing,
 * not an object, or its own `properties` field is present but isn't a
 * valid object). This is deliberately distinct from `[]`, which means "a
 * VALID schema that legitimately declares zero properties" (e.g. alpaca
 * order.filled's own `properties: {}}`) — the page renders these two cases
 * differently (see ParamsSummary in app/catalog/page.tsx: `null` ->
 * "Params schema unavailable", `[]` -> "No parameters"). A single malformed
 * PROPERTY VALUE inside an otherwise-valid `properties` object (e.g.
 * `{ field: null }`) does NOT abort the whole list — only that one field
 * falls back to type "unknown" / description `null` (describeType above).
 *
 * p6l gate (LOW): `[]` is reserved STRICTLY for a usable object schema with
 * zero declared fields — so the top-level schema must itself declare
 * `type: "object"` (every real catalog.json entry already does). Without
 * this, `{ type: "string", properties: {} }` — not an object schema at all
 * — would have been summarized as "no parameters" instead of flagged as
 * unusable.
 */
export function summarizeParamsSchema(schema: unknown): ParamFieldSummary[] | null {
  if (!isPlainObject(schema)) return null;
  if (schema.type !== "object") return null;

  const rawProperties = schema.properties;
  if (rawProperties === undefined) return [];
  if (!isPlainObject(rawProperties)) return null;

  const requiredFields = new Set(
    Array.isArray(schema.required) ? schema.required.filter((field): field is string => typeof field === "string") : [],
  );

  return Object.entries(rawProperties).map(([name, propertySchema]) => ({
    name,
    type: describeType(propertySchema),
    required: requiredFields.has(name),
    description: isPlainObject(propertySchema) && typeof propertySchema.description === "string" ? propertySchema.description : null,
  }));
}
