import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { createSubscription, deleteSubscription, getSubscription, tryTransitionToDelivering, updateSubscription } from "../../catalog/registry.ts";
import { deliverWake } from "../../catalog/wake.ts";
import { registerProvider } from "../../catalog/catalog.ts";
import { listEvents } from "../../catalog/history.ts";
import { deliverExpiredWakeFromConnector, deliverStrandedWakeFromConnector, deliverWakeFromConnector } from "./deliver-wake.ts";

// Real Redis (no mocking) for the registry/CAS — same "test:"-namespaced,
// t.after()-cleaned convention as every other provider test in this
// project. Only the true external boundary (the /catalog/wake POST itself)
// is faked — but faithfully: the REAL route (agent/channels/catalog.ts)
// claims each subscriptionId exactly once (claimWakeDelivery, a Redis
// SET NX) and reports `alreadyInFlight: true` to any concurrent second
// caller for the SAME subscriptionId, rather than sending twice. A naive
// stub that always returns `{ok: true}` would let deliverTerminalWakeFromConnector's
// intentional RESUME-on-CAS-miss behavior (see its own doc comment) look
// like a double-send in a test, when the real route's own claim is what
// actually prevents that in production — so `callCount()` here tracks only
// the FIRST caller per subscriptionId (the one that would have triggered a
// REAL send()); every subsequent caller for the same id gets
// `alreadyInFlight: true`, exactly like the real route.
function stubFetchOk() {
  const original = globalThis.fetch;
  let calls = 0;
  const claimedSubscriptionIds = new Set<string>();
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (!href.includes("/catalog/wake")) return original(url as never, init);

    const body = init?.body ? (JSON.parse(init.body as string) as { subscriptionId?: string }) : {};
    if (body.subscriptionId && claimedSubscriptionIds.has(body.subscriptionId)) {
      return new Response(JSON.stringify({ ok: true, alreadyInFlight: true }), { status: 200 });
    }
    if (body.subscriptionId) claimedSubscriptionIds.add(body.subscriptionId);

    calls++;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  return {
    callCount: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function testConversationId(): string {
  return `test:${randomUUID()}`;
}

test("deliverExpiredWakeFromConnector transitions an armed subscription to 'expired' with no snapshot", async (t) => {
  const conversationId = testConversationId();
  const sub = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 150 },
    expiresAt: "2020-01-01T00:00:00.000Z",
  });
  t.after(() => deleteSubscription(sub.id));
  const armed = await updateSubscription(sub.id, { status: "armed", armedAt: new Date().toISOString() });

  const fetchStub = stubFetchOk();
  t.after(fetchStub.restore);

  await deliverExpiredWakeFromConnector(armed);

  assert.equal(fetchStub.callCount(), 1);
  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "expired");
  assert.equal(stored?.deliverReason, null);
});

test("deliverExpiredWakeFromConnector is a no-op against an already-terminal subscription", async (t) => {
  const conversationId = testConversationId();
  const sub = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 150 },
    expiresAt: "2020-01-01T00:00:00.000Z",
  });
  t.after(() => deleteSubscription(sub.id));
  const fired = await updateSubscription(sub.id, {
    status: "fired",
    armedAt: new Date().toISOString(),
    firedAt: new Date().toISOString(),
  });

  const fetchStub = stubFetchOk();
  t.after(fetchStub.restore);

  await deliverExpiredWakeFromConnector(fired);

  assert.equal(fetchStub.callCount(), 0, "an already-fired subscription must never be re-delivered as expired");
  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "fired", "the earlier terminal status must not be overwritten");
});

// THE RESUME TEST (found while building the Phase 3 recovery-sweep
// migration, not originally specced): a subscription already STRANDED in
// "delivering" — its transition already established by an earlier attempt
// that crashed before finishing the POST — must still be resumable by a
// LATER call, using the ALREADY-ESTABLISHED reason/snapshot. Without this,
// no connector-side caller could ever act as a recovery sweep at all: every
// resume attempt would just see "already delivering" and give up forever.
test("deliverStrandedWakeFromConnector resumes a subscription already stuck in 'delivering', using its own established deliverReason", async (t) => {
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

  // Simulates a crash between establishing the transition and finishing
  // the wake POST — exactly what a real stranded row looks like.
  const stranded = await tryTransitionToDelivering(sub.id, "fired", { price: 149 });
  assert.ok(stranded, "sanity check: the transition itself must succeed");

  const fetchStub = stubFetchOk();
  t.after(fetchStub.restore);

  await deliverStrandedWakeFromConnector(stranded!);

  assert.equal(fetchStub.callCount(), 1, "the stranded row must actually be resumed, not silently given up on");
  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "fired");
  assert.equal(stored?.deliverReason, null);
});

// p3 Codex gate finding 5 (a one-liner, but a real bug): the history row
// recordEvent writes must reflect the ACTUAL terminal status just written
// by updateSubscription, not the caller's own stale `sub` parameter (whose
// `.status` is still whatever it was when the caller first read it — e.g.
// "armed" or "delivering" — since deliverWakeFromConnector's own callers
// never mutate their in-memory copy after arming). Without this fix,
// connector-fired history rows say action="fired"/"expired" but
// status="armed" (or "delivering" on a recovery resume), which is exactly
// the kind of self-contradictory row GET /catalog/events must never show.
test("connector delivery records history with the ACTUAL terminal status, not the caller's stale status", async (t) => {
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
  // The caller's own in-memory copy stays "armed" — deliverWakeFromConnector
  // is never told about its own eventual "fired"/"delivering" status change.
  const armed = await updateSubscription(sub.id, { status: "armed", armedAt: new Date().toISOString() });
  assert.equal(armed.status, "armed", "sanity check: this is the exact stale object passed to deliverWakeFromConnector below");

  const fetchStub = stubFetchOk();
  t.after(fetchStub.restore);

  await deliverWakeFromConnector(armed, { price: 149 });

  const events = await listEvents();
  const recorded = events.find((e) => e.subscriptionId === sub.id);
  assert.ok(recorded, "sanity check: a history row must have been recorded for this subscription");
  assert.equal(recorded?.action, "fired");
  assert.equal(recorded?.status, "fired", "the recorded status must be the ACTUAL terminal status, not the caller's stale 'armed' copy");
});

// THE BINDING TEST (team-lead's spec for the expiry migration): a LOCAL
// in-process expiry timer (wake.ts's own deliverWake, called by
// scheduleExpiry/expire — kept for local dev) and the DURABLE connector-side
// expiry sweep (deliverExpiredWakeFromConnector) can both decide, at
// roughly the same moment, that the SAME subscription is due — one because
// its in-process setTimeout just fired, the other because the durable
// sweep's own Redis-sorted-set read found it past its expiresAt. Both call
// into registry.ts's tryTransitionToDelivering(sub.id, "expired", ...) —
// the SAME atomic CAS every other one-shot delivery path in this codebase
// shares — so exactly one of them must ever win, regardless of which
// mechanism (local timer vs. durable sweep) got there first.
test("both-fire race: a local expiry timer and the durable expiry sweep racing the SAME subscription deliver exactly once", async (t) => {
  const conversationId = testConversationId();
  const providerName = `test-noop-provider-${randomUUID()}`;
  registerProvider(providerName, { supportedEvents: ["price.crossesBelow"], arm: async () => {}, disarm: async () => {} });

  const sub = await createSubscription({
    conversationId,
    provider: providerName,
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 150 },
    expiresAt: "2020-01-01T00:00:00.000Z",
  });
  t.after(() => deleteSubscription(sub.id));
  const armed = await updateSubscription(sub.id, { status: "armed", armedAt: new Date().toISOString() });

  const fetchStub = stubFetchOk();
  t.after(fetchStub.restore);

  // Genuinely concurrent: both mechanisms start before either finishes,
  // racing the exact same subscription object.
  await Promise.all([
    deliverWake(armed, { reason: "expired" }), // the LOCAL, in-process path (wake.ts)
    deliverExpiredWakeFromConnector(armed), // the DURABLE, connector-side path
  ]);

  assert.equal(fetchStub.callCount(), 1, "only ONE of the two racing mechanisms must ever POST the wake — never zero, never both");

  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "expired");
});
