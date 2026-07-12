import assert from "node:assert/strict";
import { test } from "node:test";

import { crosses } from "./crossing.ts";

// AT-4 step 1: fixed scenario from the acceptance test doc.
test("crossesBelow: 150.2 -> 149.8 against threshold 150 fires exactly once", () => {
  assert.equal(crosses("below", 150.2, 149.8, 150), true);
});

test("crossesBelow: 149.8 -> 149.5 against threshold 150 fires zero times (already below at seed)", () => {
  assert.equal(crosses("below", 149.8, 149.5, 150), false);
});

test("crossesAbove: 149.8 -> 150.2 against threshold 150 fires exactly once", () => {
  assert.equal(crosses("above", 149.8, 150.2, 150), true);
});

test("crossesAbove: 150.2 -> 150.5 against threshold 150 fires zero times (already above at seed)", () => {
  assert.equal(crosses("above", 150.2, 150.5, 150), false);
});

test("crossesBelow: previous exactly at threshold, current below, fires (at-or-above -> below)", () => {
  assert.equal(crosses("below", 150, 149.99, 150), true);
});

test("crossesAbove: previous exactly at threshold, current above, fires (at-or-below -> above)", () => {
  assert.equal(crosses("above", 150, 150.01, 150), true);
});

test("crossesBelow: no movement across the threshold does not fire", () => {
  assert.equal(crosses("below", 151, 150.5, 150), false);
});
