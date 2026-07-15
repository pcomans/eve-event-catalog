import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveSubscriptionSectionState } from "./subscription-section-state.ts";
import type { Subscription } from "./catalog-types.ts";

const fakeSubscription = { id: "sub-1" } as Subscription;

// p6o gate (MED): a subscription absent from the poll's current `data`
// means three different things (still loading, this poll failed, or it's
// genuinely gone) — only the last one is true "no longer in registry".
// Collapsing all three into one `!subscription` check asserted a false
// "removed" claim on the public page during the initial load or any later
// poll error.
test("resolveSubscriptionSectionState: loading takes priority over everything else", () => {
  assert.deepEqual(resolveSubscriptionSectionState(undefined, true, "some error"), { kind: "loading" });
  assert.deepEqual(resolveSubscriptionSectionState(fakeSubscription, true, null), { kind: "loading" });
});

test("resolveSubscriptionSectionState: a poll error (not loading) reports 'error', not 'removed'", () => {
  assert.deepEqual(resolveSubscriptionSectionState(undefined, false, "/api/subscriptions -> 500"), {
    kind: "error",
  });
});

test("resolveSubscriptionSectionState: found (not loading, no error, subscription present) reports 'found'", () => {
  assert.deepEqual(resolveSubscriptionSectionState(fakeSubscription, false, null), {
    kind: "found",
    subscription: fakeSubscription,
  });
});

test("resolveSubscriptionSectionState: ONLY a successful load that genuinely lacks the id reports 'removed'", () => {
  assert.deepEqual(resolveSubscriptionSectionState(undefined, false, null), { kind: "removed" });
});
