import catalogData from "../../catalog/catalog.json";
import type { EventType } from "../../catalog/types.ts";

// task #34: unlike lib/catalog-types.ts's own Subscription/HistoryEntry/
// ConversationRecord (which mirror the SHAPE of data actually fetched at
// RUNTIME from the eve app's own routes — a genuinely separate deployed
// service, so those types are hand-kept in sync rather than shared),
// catalog.json is static content with no live endpoint exposing it. A
// build-time cross-root import of the SAME monorepo checkout is the
// natural source of truth here — verified to compile cleanly under both
// `tsc` and Next's production Turbopack build with a plain relative import
// (no prebuild copy step or eve-side proxy route needed; see the task
// report for the verification).
//
// `EventType` itself is imported type-only (erased at compile time, zero
// runtime/bundle cost) rather than hand-duplicated the way catalog-types.ts
// duplicates its own wire-shape types — catalog/types.ts has no imports of
// its own, so this stays fully self-contained. TypeScript's JSON-module
// inference widens `status` to plain `string`; the cast below recovers the
// real `"active" | "planned"` union from the authoritative source instead
// of re-declaring it by hand and risking drift.
export const eventTypes: EventType[] = catalogData.eventTypes as EventType[];

export type { EventType } from "../../catalog/types.ts";
