import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeMembershipDelta,
  MEMBERSHIP_CHECK_CADENCE_MS,
  performMembershipCheck,
  shouldRecheckMembership,
} from "./membership-delta.ts";

test("computeMembershipDelta: identical sets produce a no-op delta", () => {
  const delta = computeMembershipDelta(["NVDA", "AAPL"], ["NVDA", "AAPL"]);
  assert.deepEqual(delta, { toSubscribe: [], toUnsubscribe: [] });
});

test("computeMembershipDelta: a symbol armed mid-session (newly in the desired set) appears in toSubscribe", () => {
  const delta = computeMembershipDelta(["NVDA"], ["NVDA", "AAPL"]);
  assert.deepEqual(delta.toSubscribe, ["AAPL"]);
  assert.deepEqual(delta.toUnsubscribe, []);
});

test("computeMembershipDelta: the last subscriber for a symbol unsubscribing (symbol no longer desired) produces a drop", () => {
  const delta = computeMembershipDelta(["NVDA", "AAPL"], ["NVDA"]);
  assert.deepEqual(delta.toUnsubscribe, ["AAPL"]);
  assert.deepEqual(delta.toSubscribe, []);
});

test("computeMembershipDelta: an empty desired set drops everything currently streamed — no special-casing needed", () => {
  const delta = computeMembershipDelta(["NVDA", "AAPL", "TSLA"], []);
  assert.deepEqual(new Set(delta.toUnsubscribe), new Set(["NVDA", "AAPL", "TSLA"]));
  assert.deepEqual(delta.toSubscribe, []);
});

test("computeMembershipDelta: an empty currentlyStreamed set with a non-empty desired set subscribes to everything", () => {
  const delta = computeMembershipDelta([], ["NVDA"]);
  assert.deepEqual(delta.toSubscribe, ["NVDA"]);
  assert.deepEqual(delta.toUnsubscribe, []);
});

test("shouldRecheckMembership: false before the cadence has elapsed, true at and after it", () => {
  const lastChecked = 1_000_000;
  assert.equal(shouldRecheckMembership(lastChecked, lastChecked + MEMBERSHIP_CHECK_CADENCE_MS - 1), false);
  assert.equal(shouldRecheckMembership(lastChecked, lastChecked + MEMBERSHIP_CHECK_CADENCE_MS), true);
  assert.equal(shouldRecheckMembership(lastChecked, lastChecked + MEMBERSHIP_CHECK_CADENCE_MS + 5000), true);
});

test("performMembershipCheck: a symbol armed mid-session appears in the delta on the VERY NEXT tick", async () => {
  // Tick 1: only NVDA is armed.
  const tick1 = await performMembershipCheck(async () => ["NVDA"], []);
  assert.deepEqual(tick1.delta.toSubscribe, ["NVDA"]);

  // Between tick 1 and tick 2, AAPL gets armed mid-session — the desired
  // set the NEXT read returns already reflects it (a real Redis read would
  // see whatever's currently armed, no staleness modeled here).
  const tick2 = await performMembershipCheck(async () => ["NVDA", "AAPL"], tick1.desired);

  assert.deepEqual(tick2.delta.toSubscribe, ["AAPL"], "AAPL must appear in the delta within this one tick, not delayed further");
  assert.deepEqual(tick2.delta.toUnsubscribe, []);
});

test("performMembershipCheck: the last-unsubscribed symbol produces a drop on the tick where it disappears from the desired set", async () => {
  const tick1 = await performMembershipCheck(async () => ["NVDA", "AAPL"], []);
  assert.deepEqual(new Set(tick1.desired), new Set(["NVDA", "AAPL"]));

  // AAPL's only subscriber disarms/expires between ticks.
  const tick2 = await performMembershipCheck(async () => ["NVDA"], tick1.desired);

  assert.deepEqual(tick2.delta.toUnsubscribe, ["AAPL"]);
  assert.deepEqual(tick2.delta.toSubscribe, []);
});

test("performMembershipCheck: nothing armed at all (empty desired set) drops every currently-streamed symbol", async () => {
  const tick1 = await performMembershipCheck(async () => ["NVDA", "AAPL"], []);
  const tick2 = await performMembershipCheck(async () => [], tick1.desired);

  assert.deepEqual(new Set(tick2.delta.toUnsubscribe), new Set(["NVDA", "AAPL"]));
  assert.deepEqual(tick2.delta.toSubscribe, []);
  assert.deepEqual(tick2.desired, []);
});
