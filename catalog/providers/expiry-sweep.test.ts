import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { createSubscription, deleteSubscription, getSubscription, tryTransitionToDelivering, updateSubscription } from "../registry.ts";
import type { Subscription } from "../types.ts";
import { runExpirySweepTick, type DeliverExpiredWake } from "./expiry-sweep.ts";

function testConversationId(): string {
  return `test:${randomUUID()}`;
}

async function armedSubWithExpiry(conversationId: string, expiresAt: string): Promise<Subscription> {
  const sub = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 150 },
    expiresAt,
  });
  return updateSubscription(sub.id, { status: "armed", armedAt: new Date().toISOString() });
}

/** The production `deliver` contract (deliverExpiredWakeFromConnector) without the HTTP hop — same real CAS, same terminal write. */
function realCasDeliver(onDeliver: (sub: Subscription) => void): DeliverExpiredWake {
  return async (sub) => {
    const transitioned = await tryTransitionToDelivering(sub.id, "expired", null);
    if (!transitioned) return;
    await updateSubscription(sub.id, { status: "expired", firedAt: new Date().toISOString(), deliverReason: null, deliverSnapshot: null });
    onDeliver(sub);
  };
}

test("runExpirySweepTick delivers exactly one 'expired' wake for a due subscription", async (t) => {
  const conversationId = testConversationId();
  const sub = await armedSubWithExpiry(conversationId, "2020-01-01T00:00:00.000Z");
  t.after(() => deleteSubscription(sub.id));

  const delivered: Subscription[] = [];
  await runExpirySweepTick(realCasDeliver((s) => delivered.push(s)), Date.now());

  // Filtered to this test's own subscription, not a raw total: node:test
  // runs files concurrently against the SAME live Redis, so a due
  // subscription belonging to a different, concurrently-running test file
  // can legitimately also be swept in this same tick.
  const deliveredForSub = delivered.filter((s) => s.id === sub.id);
  assert.equal(deliveredForSub.length, 1);
  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "expired");
});

test("runExpirySweepTick never delivers a subscription whose expiresAt is still in the future", async (t) => {
  const conversationId = testConversationId();
  const sub = await armedSubWithExpiry(conversationId, "2099-01-01T00:00:00.000Z");
  t.after(() => deleteSubscription(sub.id));

  const delivered: Subscription[] = [];
  await runExpirySweepTick(realCasDeliver((s) => delivered.push(s)), Date.now());

  assert.equal(delivered.find((s) => s.id === sub.id), undefined);
  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "armed");
});

test("runExpirySweepTick isolates a poison row: one subscription's delivery throwing does not starve the rest of the tick", async (t) => {
  const conversationId = testConversationId();
  const healthy = await armedSubWithExpiry(conversationId, "2020-01-01T00:00:00.000Z");
  t.after(() => deleteSubscription(healthy.id));
  const poison = await armedSubWithExpiry(conversationId, "2020-01-01T00:00:00.000Z");
  t.after(() => deleteSubscription(poison.id));

  const delivered: Subscription[] = [];
  const deliver: DeliverExpiredWake = async (sub) => {
    if (sub.id === poison.id) throw new Error("simulated poison-row failure");
    delivered.push(sub);
  };

  await runExpirySweepTick(deliver, Date.now());

  // Scoped to these two specific subscriptions, not a raw total — see the
  // note on the first test above.
  assert.ok(delivered.some((s) => s.id === healthy.id), "the healthy subscription must still be delivered despite the poison row");
  assert.ok(!delivered.some((s) => s.id === poison.id), "the poison row must never appear as delivered");
});

// THE BINDING OVERLAP TEST: two genuinely concurrent sweep ticks racing the
// SAME due subscription must produce exactly one delivery, via the real
// tryTransitionToDelivering CAS — not the sweep's own read of the expiry
// index (which is a diffing aid, not a delivery lock; see
// expiry-sweep.ts's own doc comment).
test("two concurrent sweep ticks racing the same due subscription deliver exactly once", async (t) => {
  const conversationId = testConversationId();
  const sub = await armedSubWithExpiry(conversationId, "2020-01-01T00:00:00.000Z");
  t.after(() => deleteSubscription(sub.id));

  const delivered: Subscription[] = [];
  const deliver = realCasDeliver((s) => delivered.push(s));

  await Promise.all([runExpirySweepTick(deliver, Date.now()), runExpirySweepTick(deliver, Date.now())]);

  const deliveredForSub = delivered.filter((s) => s.id === sub.id);
  assert.equal(deliveredForSub.length, 1, "exactly one of the two concurrent ticks must win — never zero, never doubled");
  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "expired");
});
