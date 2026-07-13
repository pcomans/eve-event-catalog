import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { createSubscription, deleteSubscription, getSubscription, tryTransitionToDelivering, updateSubscription } from "../registry.ts";
import type { Subscription } from "../types.ts";
import { claimWakeDelivery, markWakeSent } from "../wake.ts";
import { deliverStrandedWakeFromConnector } from "../../connector/lib/deliver-wake.ts";
import { runRecoverySweepTick, type DeliverStranded } from "./recovery-sweep.ts";

// Real Redis (no mocking) for the registry/CAS. Only the true external
// boundary (the /catalog/wake POST itself) is faked — faithfully: the real
// route claims each subscriptionId exactly once and reports
// `alreadyInFlight: true` to a second concurrent caller for the SAME id,
// rather than sending twice (same convention as connector/lib/deliver-wake.test.ts's
// own stub — see its comment for why a naive always-ok stub would
// misrepresent deliverTerminalWakeFromConnector's intentional resume-on-
// CAS-miss behavior as a double-send).
//
// `preClaimed` lets a test model "someone else already holds the real
// route's wake-delivery claim for this subscriptionId" (team-lead's
// binding test (c): an actively-being-delivered row) without needing to
// reimplement the route's own claim logic in the stub — the FIRST call for
// a pre-claimed id gets alreadyInFlight immediately, same as every
// subsequent call for any id this stub itself already answered for.
function stubFetchOk(preClaimed: string[] = []) {
  const original = globalThis.fetch;
  // Per-subscriptionId, not a raw running total: node:test runs files
  // concurrently against the SAME live Redis, so runRecoverySweepTick's own
  // global listSubscriptions() scan can legitimately also pick up a
  // different, concurrently-running test file's own stranded row in the
  // same tick — a real send for THAT id must not count against THIS test's
  // one-and-only-one-send assertion for its own subscription.
  const callsBySubscriptionId = new Map<string, number>();
  const claimedSubscriptionIds = new Set<string>(preClaimed);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (!href.includes("/catalog/wake")) return original(url as never, init);

    const body = init?.body ? (JSON.parse(init.body as string) as { subscriptionId?: string }) : {};
    if (body.subscriptionId && claimedSubscriptionIds.has(body.subscriptionId)) {
      return new Response(JSON.stringify({ ok: true, alreadyInFlight: true }), { status: 200 });
    }
    if (body.subscriptionId) {
      claimedSubscriptionIds.add(body.subscriptionId);
      callsBySubscriptionId.set(body.subscriptionId, (callsBySubscriptionId.get(body.subscriptionId) ?? 0) + 1);
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  return {
    callCountFor: (subscriptionId: string) => callsBySubscriptionId.get(subscriptionId) ?? 0,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function testConversationId(): string {
  return `test:${randomUUID()}`;
}

/** Simulates a crash between establishing the "delivering" transition and finishing the wake POST — exactly what a real stranded row looks like. */
async function strandedSub(conversationId: string, reason: "fired" | "expired" = "fired"): Promise<Subscription> {
  const sub = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 150 },
    expiresAt: null,
  });
  await updateSubscription(sub.id, { status: "armed", armedAt: new Date().toISOString() });
  const transitioned = await tryTransitionToDelivering(sub.id, reason, reason === "fired" ? { price: 149 } : null);
  return transitioned!;
}

// BINDING TEST (a) — team-lead's framing: the Phase 1 canonical crash-
// recovery case, proven cross-service (the CONNECTOR's own sweep, not just
// wake.ts's in-process one). A row left "delivering" with its deliverReason
// persisted, no wake-delivery marker at all, and no lease held — exactly
// what a crash between establishing the transition and finishing the wake
// POST leaves behind. The connector sweep must deliver it exactly once and
// land it terminal.
test("(a) canonical crash-recovery: a stranded row with no marker and no lease is delivered exactly once and lands terminal", async (t) => {
  const conversationId = testConversationId();
  const sub = await strandedSub(conversationId, "fired");
  t.after(() => deleteSubscription(sub.id));

  const fetchStub = stubFetchOk();
  t.after(fetchStub.restore);

  await runRecoverySweepTick(deliverStrandedWakeFromConnector);

  assert.equal(fetchStub.callCountFor(sub.id), 1);
  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "fired");
  assert.equal(stored?.deliverReason, null);
});

// BINDING TEST (b) — team-lead's finding: the lease-skip is a liveness
// requirement, not just a safety one. A stranded row whose wake-delivery
// marker already reached "sent" (an earlier attempt crashed AFTER send()
// succeeded but BEFORE writing the terminal status) must be completed
// using the marker's OWN recorded firedAt, with ZERO wake POSTs — not
// re-sent, not given a fresh timestamp the agent's envelope never saw.
// This is the case deliverTerminalWakeFromConnector's marker check (added
// in response to team-lead's review) exists for.
test("(b) marker-present variant: a stranded row already marked 'sent' completes terminal from the stored firedAt with ZERO wake POSTs", async (t) => {
  const conversationId = testConversationId();
  const sub = await strandedSub(conversationId, "fired");
  t.after(() => deleteSubscription(sub.id));

  const markedFiredAt = "2024-06-01T12:00:00.000Z";
  const token = await claimWakeDelivery(sub.id);
  assert.ok(token, "sanity check: claiming the marker must succeed on a fresh subscription");
  const upgraded = await markWakeSent(sub.id, markedFiredAt, token!);
  assert.ok(upgraded, "sanity check: the marker upgrade to 'sent' must succeed");

  const fetchStub = stubFetchOk();
  t.after(fetchStub.restore);

  await runRecoverySweepTick(deliverStrandedWakeFromConnector);

  assert.equal(fetchStub.callCountFor(sub.id), 0, "a marker already 'sent' must never trigger a real wake POST");
  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "fired");
  assert.equal(stored?.firedAt, markedFiredAt, "must reuse the marker's own recorded firedAt, never invent a fresh one");
});

// BINDING TEST (c) — an actively-being-delivered row (someone else
// currently holds the real route's wake-delivery claim for this
// subscriptionId) must be a no-op for this sweep tick, not a duplicate
// send. Distinct from the genuine-race overlap test below: here there is
// only ONE connector-side attempt, arriving after the claim is already
// held, not two attempts racing each other.
test("(c) redundant retry: an actively-being-delivered row is a no-op, no duplicate send", async (t) => {
  const conversationId = testConversationId();
  const sub = await strandedSub(conversationId, "fired");
  t.after(() => deleteSubscription(sub.id));

  const fetchStub = stubFetchOk([sub.id]); // simulates the real route's claim already being held by someone else
  t.after(fetchStub.restore);

  await runRecoverySweepTick(deliverStrandedWakeFromConnector);

  assert.equal(fetchStub.callCountFor(sub.id), 0, "an already-claimed row must never be counted as a real send");
  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "delivering", "must be left delivering for whichever attempt actually owns the claim");
});

test("runRecoverySweepTick leaves an armed (not delivering) subscription alone", async (t) => {
  const conversationId = testConversationId();
  const sub = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 150 },
    expiresAt: null,
  });
  t.after(() => deleteSubscription(sub.id));
  await updateSubscription(sub.id, { status: "armed", armedAt: new Date().toISOString() });

  const fetchStub = stubFetchOk();
  t.after(fetchStub.restore);

  await runRecoverySweepTick(deliverStrandedWakeFromConnector);

  assert.equal(fetchStub.callCountFor(sub.id), 0, "an armed (not delivering) subscription must never be swept as stranded");
  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "armed");
});

test("runRecoverySweepTick isolates a poison row: one subscription's resume throwing does not starve the rest of the tick", async (t) => {
  const conversationId = testConversationId();
  const healthy = await strandedSub(conversationId, "fired");
  t.after(() => deleteSubscription(healthy.id));
  const poison = await strandedSub(conversationId, "expired");
  t.after(() => deleteSubscription(poison.id));

  const delivered: Subscription[] = [];
  const deliver: DeliverStranded = async (sub) => {
    if (sub.id === poison.id) throw new Error("simulated poison-row failure");
    delivered.push(sub);
  };

  await runRecoverySweepTick(deliver);

  // Scoped to these two specific subscriptions, not a raw total — see
  // stubFetchOk's own comment above on why a raw count is unsafe under
  // node:test's concurrent-file execution against one live Redis.
  assert.ok(delivered.some((s) => s.id === healthy.id), "the healthy subscription must still be resumed despite the poison row");
  assert.ok(!delivered.some((s) => s.id === poison.id), "the poison row must never appear as delivered");
});

// THE REQUIRED OVERLAP TEST: two genuinely concurrent sweep ticks racing
// the SAME stranded subscription must resume it exactly once — via the
// REAL production delivery function (deliverStrandedWakeFromConnector),
// end to end: the real tryTransitionToDelivering CAS (which BOTH calls
// lose, since the row is already "delivering" — both correctly fall
// through to the RESUME-via-reread path), and the real wake-delivery
// claim simulated by stubFetchOk (only the first of the two POSTs is
// treated as a genuine send; the second gets alreadyInFlight). This module
// deliberately does NOT check a delivery lease itself (see its own doc
// comment) — this test is the proof that skipping it is still safe.
test("two concurrent sweep ticks racing the same stranded subscription resume it exactly once", async (t) => {
  const conversationId = testConversationId();
  const sub = await strandedSub(conversationId, "fired");
  t.after(() => deleteSubscription(sub.id));

  const fetchStub = stubFetchOk();
  t.after(fetchStub.restore);

  await Promise.all([
    runRecoverySweepTick(deliverStrandedWakeFromConnector),
    runRecoverySweepTick(deliverStrandedWakeFromConnector),
  ]);

  assert.equal(fetchStub.callCountFor(sub.id), 1, "exactly one of the two concurrent ticks must trigger a real send — never zero, never doubled");
  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "fired");
});
