import { test } from "node:test";
import assert from "node:assert/strict";

import { formatEtTime } from "./et-time.ts";

test("formatEtTime converts UTC to US/Eastern with an explicit ET label (winter, EST = UTC-5)", () => {
  assert.equal(formatEtTime("2026-01-15T14:30:05.000Z"), "09:30:05 ET");
});

test("formatEtTime converts UTC to US/Eastern with an explicit ET label (summer, EDT = UTC-4)", () => {
  assert.equal(formatEtTime("2026-07-15T13:30:05.000Z"), "09:30:05 ET");
});

test("formatEtTime renders midnight ET as 00:MM:SS, not 24:MM:SS", () => {
  assert.equal(formatEtTime("2026-07-15T04:05:09.000Z"), "00:05:09 ET");
});

test("formatEtTime zero-pads single-digit hour/minute/second", () => {
  assert.equal(formatEtTime("2026-07-15T05:06:07.000Z"), "01:06:07 ET");
});
