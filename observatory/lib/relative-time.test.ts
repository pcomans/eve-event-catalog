import { test } from "node:test";
import assert from "node:assert/strict";

import { relativeTime } from "./relative-time.ts";

const now = new Date("2026-07-14T00:00:00.000Z");

test("relativeTime formats seconds", () => {
  assert.equal(relativeTime("2026-07-13T23:59:45.000Z", now), "15s ago");
});

test("relativeTime formats minutes", () => {
  assert.equal(relativeTime("2026-07-13T23:50:00.000Z", now), "10m ago");
});

test("relativeTime formats hours", () => {
  assert.equal(relativeTime("2026-07-13T18:00:00.000Z", now), "6h ago");
});

test("relativeTime formats days", () => {
  assert.equal(relativeTime("2026-07-10T00:00:00.000Z", now), "4d ago");
});

test("relativeTime treats a future timestamp as just now", () => {
  assert.equal(relativeTime("2026-07-14T00:05:00.000Z", now), "just now");
});
