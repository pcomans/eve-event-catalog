import assert from "node:assert/strict";
import { test } from "node:test";

import { isMarketWeekday } from "./market-day.ts";

// All times 13:30 UTC — the schedule's actual fire time (see
// agent/schedules/market-open.ts) — 2026-07-13 is a Monday (see HANDOFF.md's
// campaign-5 note: "market-open clock wake 2026-07-14T13:30Z — correctly
// Tuesday").

test("isMarketWeekday is true Monday through Friday", () => {
  assert.equal(isMarketWeekday(new Date("2026-07-13T13:30:00Z")), true); // Mon
  assert.equal(isMarketWeekday(new Date("2026-07-14T13:30:00Z")), true); // Tue
  assert.equal(isMarketWeekday(new Date("2026-07-15T13:30:00Z")), true); // Wed
  assert.equal(isMarketWeekday(new Date("2026-07-16T13:30:00Z")), true); // Thu
  assert.equal(isMarketWeekday(new Date("2026-07-17T13:30:00Z")), true); // Fri
});

test("isMarketWeekday is false on Saturday and Sunday", () => {
  assert.equal(isMarketWeekday(new Date("2026-07-18T13:30:00Z")), false); // Sat
  assert.equal(isMarketWeekday(new Date("2026-07-19T13:30:00Z")), false); // Sun
});
