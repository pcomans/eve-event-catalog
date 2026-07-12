import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { armPendingForConversation, buildWakeEnvelope, buildWakePayload, deliverWake, shouldSkipArmFailure } from "./wake.ts";
import { registerProvider } from "./catalog.ts";
import { createSubscription, deleteSubscription, getSubscription } from "./registry.ts";
import type { Subscription } from "./types.ts";

const baseSub: Subscription = {
  id: "sub-1",
  conversationId: "demo-2",
  provider: "alpaca",
  event: "price.crossesBelow",
  resource: "NVDA",
  params: { threshold: 150 },
  expiresAt: null,
  status: "armed",
  createdAt: "2026-07-11T10:00:00.000Z",
  armedAt: "2026-07-11T10:00:01.000Z",
  firedAt: null,
  lastError: null,
};

test("buildWakePayload produces the stable WakePayload envelope shape", () => {
  const firedAt = "2026-07-11T10:03:00.000Z";
  const payload = buildWakePayload(baseSub, { reason: "fired", snapshot: { price: 149.8 } }, firedAt);

  assert.deepEqual(payload, {
    subscriptionId: "sub-1",
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    snapshot: { price: 149.8 },
    firedAt,
    reason: "fired",
  });
});

test("buildWakePayload carries reason: expired without a snapshot", () => {
  const firedAt = "2026-07-11T10:03:00.000Z";
  const payload = buildWakePayload(baseSub, { reason: "expired" }, firedAt);

  assert.equal(payload.reason, "expired");
  assert.equal(payload.snapshot, undefined);
  assert.equal(payload.subscriptionId, baseSub.id);
});

test("buildWakeEnvelope nests payload, so a payload field named subscribedAt/firedAt cannot shadow the real ones", () => {
  const envelope = buildWakeEnvelope("2026-07-11T10:00:01.000Z", "2026-07-11T10:03:00.000Z", {
    subscribedAt: "attacker-controlled",
    firedAt: "attacker-controlled",
    note: "hello",
  });

  assert.equal(envelope.subscribedAt, "2026-07-11T10:00:01.000Z");
  assert.equal(envelope.firedAt, "2026-07-11T10:03:00.000Z");
  // The colliding field names land inertly inside the nested payload — never at the top level.
  assert.equal(envelope.payload?.subscribedAt, "attacker-controlled");
  assert.equal(envelope.payload?.firedAt, "attacker-controlled");
  assert.equal(envelope.payload?.note, "hello");
});

test("buildWakeEnvelope omits payload when none was given", () => {
  const envelope = buildWakeEnvelope("2026-07-11T10:00:01.000Z", "2026-07-11T10:03:00.000Z");
  assert.equal(envelope.payload, undefined);
});

// deliverWake/armPendingForConversation tests below stub global.fetch so they
// run without a live dev server listening on CATALOG_BASE_URL, and register
// throwaway providers under unique names (never used by catalog.json) so
// they can't interfere with the real catalog's honesty check.

function stubFetchOk() {
  // globalThis.fetch is shared with @upstash/redis's own HTTP client — only
  // intercept the /catalog/wake loopback call this test cares about, and
  // pass everything else (Redis's REST calls) through to the real fetch.
  const original = globalThis.fetch;
  let calls = 0;
  let lastBody: unknown;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (!href.includes("/catalog/wake")) return original(url as never, init);

    calls++;
    lastBody = init?.body ? JSON.parse(init.body as string) : undefined;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  return {
    callCount: () => calls,
    lastBody: () => lastBody,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("deliverWake claims a subscription synchronously: two concurrent callers deliver exactly once", async (t) => {
  const conversationId = `test:${randomUUID()}`;
  const providerName = `test-noop-provider-${randomUUID()}`;
  registerProvider(providerName, { supportedEvents: ["price.crossesBelow"], arm: async () => {}, disarm: async () => {} });
  const sub = await createSubscription({
    conversationId,
    provider: providerName,
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 150 },
    expiresAt: null,
  });
  t.after(() => deleteSubscription(sub.id));

  const armed = { ...sub, status: "armed" as const, armedAt: new Date().toISOString() };
  const fetchStub = stubFetchOk();
  t.after(fetchStub.restore);

  await Promise.all([
    deliverWake(armed, { reason: "fired" }),
    deliverWake(armed, { reason: "fired" }),
  ]);

  assert.equal(fetchStub.callCount(), 1, "only the first caller should have POSTed the wake");

  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "fired");
});

test("deliverWake sends the exact same firedAt it stores on the subscription", async (t) => {
  const conversationId = `test:${randomUUID()}`;
  const providerName = `test-noop-provider-${randomUUID()}`;
  registerProvider(providerName, { supportedEvents: ["price.crossesBelow"], arm: async () => {}, disarm: async () => {} });
  const sub = await createSubscription({
    conversationId,
    provider: providerName,
    event: "price.crossesBelow",
    resource: "NVDA",
    params: { threshold: 150 },
    expiresAt: null,
  });
  t.after(() => deleteSubscription(sub.id));

  const armed = { ...sub, status: "armed" as const, armedAt: new Date().toISOString() };
  const fetchStub = stubFetchOk();
  t.after(fetchStub.restore);

  await deliverWake(armed, { reason: "fired" });

  const stored = await getSubscription(sub.id);
  const body = fetchStub.lastBody() as { firedAt: string };
  assert.equal(body.firedAt, stored?.firedAt);
});

test("deliverWake disarms the provider on both fired and expired terminal transitions", async (t) => {
  const conversationId = `test:${randomUUID()}`;
  const sub = await createSubscription({
    conversationId,
    provider: `test-disarm-provider-${randomUUID()}`,
    event: "fire",
    resource: "NVDA",
    params: {},
    expiresAt: null,
  });
  t.after(() => deleteSubscription(sub.id));

  let disarmCalls = 0;
  registerProvider(sub.provider, {
    supportedEvents: ["fire"],
    arm: async () => {},
    disarm: async () => {
      disarmCalls++;
    },
  });

  const armed = { ...sub, status: "armed" as const, armedAt: new Date().toISOString() };
  const fetchStub = stubFetchOk();
  t.after(fetchStub.restore);

  await deliverWake(armed, { reason: "fired" });
  assert.equal(disarmCalls, 1);

  const sub2 = await createSubscription({
    conversationId,
    provider: sub.provider,
    event: "fire",
    resource: "NVDA",
    params: {},
    expiresAt: null,
  });
  t.after(() => deleteSubscription(sub2.id));
  const armed2 = { ...sub2, status: "armed" as const, armedAt: new Date().toISOString() };

  await deliverWake(armed2, { reason: "expired" });
  assert.equal(disarmCalls, 2);
});

test("armPendingForConversation is idempotent: two concurrent calls arm a subscription exactly once", async (t) => {
  const conversationId = `test:${randomUUID()}`;
  const providerName = `test-arm-provider-${randomUUID()}`;
  let armCalls = 0;
  registerProvider(providerName, {
    supportedEvents: ["fire"],
    arm: async () => {
      armCalls++;
    },
    disarm: async () => {},
  });

  const sub = await createSubscription({
    conversationId,
    provider: providerName,
    event: "fire",
    resource: "NVDA",
    params: {},
    expiresAt: null,
  });
  t.after(() => deleteSubscription(sub.id));

  await Promise.all([armPendingForConversation(conversationId), armPendingForConversation(conversationId)]);

  assert.equal(armCalls, 1, "provider.arm must be called exactly once even under duplicate turn.completed events");

  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "armed");
});

test("shouldSkipArmFailure skips when delivery is already claimed, regardless of persisted status", () => {
  assert.equal(shouldSkipArmFailure(true, "armed"), true);
  assert.equal(shouldSkipArmFailure(true, undefined), true);
});

test("shouldSkipArmFailure skips when the persisted status already raced ahead to delivering/fired/expired", () => {
  assert.equal(shouldSkipArmFailure(false, "delivering"), true);
  assert.equal(shouldSkipArmFailure(false, "fired"), true);
  assert.equal(shouldSkipArmFailure(false, "expired"), true);
});

test("shouldSkipArmFailure does not skip a genuine arm failure", () => {
  assert.equal(shouldSkipArmFailure(false, "armed"), false);
  assert.equal(shouldSkipArmFailure(false, "pending"), false);
  assert.equal(shouldSkipArmFailure(false, "failed"), false);
  assert.equal(shouldSkipArmFailure(false, undefined), false);
});

test("armPendingForConversation does not overwrite a status that already raced ahead to fired during a failing arm()", async (t) => {
  const conversationId = `test:${randomUUID()}`;
  const providerName = `test-race-provider-${randomUUID()}`;
  const sub = await createSubscription({
    conversationId,
    provider: providerName,
    event: "fire",
    resource: "NVDA",
    params: {},
    expiresAt: null,
  });
  t.after(() => deleteSubscription(sub.id));

  const fetchStub = stubFetchOk();
  t.after(fetchStub.restore);

  // Simulates a provider tick firing successfully mid-arm() (e.g. a push
  // event racing a REST seed call), and then the arm's own remaining work
  // throwing afterward — armPendingForConversation's catch must not clobber
  // the "fired" status the successful delivery already wrote.
  registerProvider(providerName, {
    supportedEvents: ["fire"],
    arm: async (armedSub) => {
      await deliverWake(armedSub, { reason: "fired" });
      throw new Error("seed failed after push already fired");
    },
    disarm: async () => {},
  });

  await armPendingForConversation(conversationId);

  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "fired");
  assert.equal(stored?.lastError, null);
});
