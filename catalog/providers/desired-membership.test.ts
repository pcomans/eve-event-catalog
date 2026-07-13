import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { createSubscription, deleteSubscription, updateSubscription } from "../registry.ts";
import {
  readDesiredAlpacaOrderSubscriptions,
  readDesiredAlpacaPriceSubscriptions,
  readDesiredAlpacaSymbols,
  readDesiredEdgarSubscriptions,
} from "./desired-membership.ts";

// Real Redis (no mocking), real listSubscriptions() reads — same
// "test:"-namespaced, t.after()-cleaned convention as registry.test.ts.
// listSubscriptions() has no filter of its own, so these tests share
// whatever else is in the registry at run time; every assertion below
// checks for presence/absence of THIS test's own ids/resources, never the
// total count. Codex gate finding: the previous version used fixed common
// symbols (NVDA, AAPL, ...) and batched cleanup registration to the end of
// each test — a real "NVDA" row from elsewhere in a shared dev Redis, or a
// concurrent test run, could produce a false pass/failure, and a mid-setup
// throw would leak every subscription created before it. Fixed by giving
// every test its own unique resource per call and registering t.after()
// immediately after each create, not batched.
const testConversationId = () => `test:${randomUUID()}`;
const testSymbol = () => `TEST-${randomUUID().slice(0, 8)}`;
const testOrderId = () => `test-order-${randomUUID()}`;

test("readDesiredAlpacaSymbols: only ARMED price-crossing alpaca subscriptions count, deduped by symbol", async (t) => {
  const conversationId = testConversationId();
  const sharedSymbol = testSymbol();
  const deliveringSymbol = testSymbol();
  const pendingSymbol = testSymbol();
  const firedSymbol = testSymbol();
  const nonAlpacaSymbol = testSymbol();

  const armed1 = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: sharedSymbol,
    params: { threshold: 150 },
    expiresAt: null,
  });
  t.after(() => deleteSubscription(armed1.id));

  const armed2 = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesAbove",
    resource: sharedSymbol, // same symbol as armed1 — must be deduped, not doubled
    params: { threshold: 200 },
    expiresAt: null,
  });
  t.after(() => deleteSubscription(armed2.id));

  // Codex gate finding (reversed design): "delivering" no longer counts as
  // desired — its fate is already sealed via tryTransitionToDelivering, and
  // it must not keep a symbol subscribed to the live stream on its own.
  const delivering = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: deliveringSymbol,
    params: { threshold: 100 },
    expiresAt: null,
  });
  t.after(() => deleteSubscription(delivering.id));

  const pending = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: pendingSymbol, // still pending — not yet armed, must not appear
    params: { threshold: 300 },
    expiresAt: null,
  });
  t.after(() => deleteSubscription(pending.id));

  const fired = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: firedSymbol, // already terminal — must not appear
    params: { threshold: 100 },
    expiresAt: null,
  });
  t.after(() => deleteSubscription(fired.id));

  const nonAlpaca = await createSubscription({
    conversationId,
    provider: "edgar",
    event: "filing.new",
    resource: nonAlpacaSymbol, // right shape, wrong provider — must not appear
    params: {},
    expiresAt: null,
  });
  t.after(() => deleteSubscription(nonAlpaca.id));

  await updateSubscription(armed1.id, { status: "armed" });
  await updateSubscription(armed2.id, { status: "armed" });
  await updateSubscription(delivering.id, { status: "delivering" });
  // pending stays "pending" (its create-time default)
  await updateSubscription(fired.id, { status: "fired" });

  const symbols = await readDesiredAlpacaSymbols();
  assert.ok(symbols.includes(sharedSymbol), "armed price-crossing symbol must be desired");
  assert.ok(!symbols.includes(deliveringSymbol), "a delivering-only subscription must NOT keep its symbol desired");
  assert.equal(symbols.filter((s) => s === sharedSymbol).length, 1, "two subs on the same symbol must not duplicate it");
  assert.ok(!symbols.includes(pendingSymbol), "a pending (not yet armed) subscription must not be desired");
  assert.ok(!symbols.includes(firedSymbol), "a fired (terminal) subscription must not be desired");
  assert.ok(!symbols.includes(nonAlpacaSymbol), "a non-alpaca provider's resource must never be desired here");

  const priceSubs = await readDesiredAlpacaPriceSubscriptions();
  const priceSubIds = priceSubs.map((s) => s.id);
  assert.ok(priceSubIds.includes(armed1.id));
  assert.ok(!priceSubIds.includes(delivering.id), "delivering must not appear in the full-detail reader either");
  assert.ok(!priceSubIds.includes(pending.id));
  assert.ok(!priceSubIds.includes(fired.id));
});

test("readDesiredAlpacaOrderSubscriptions: only ARMED order.filled subscriptions count, and price-crossing subs never leak in", async (t) => {
  const conversationId = testConversationId();

  const armedOrder = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "order.filled",
    resource: testOrderId(),
    params: {},
    expiresAt: null,
  });
  t.after(() => deleteSubscription(armedOrder.id));

  const deliveringOrder = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "order.filled",
    resource: testOrderId(),
    params: {},
    expiresAt: null,
  });
  t.after(() => deleteSubscription(deliveringOrder.id));

  const armedPrice = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: testSymbol(),
    params: { threshold: 150 },
    expiresAt: null,
  });
  t.after(() => deleteSubscription(armedPrice.id));

  await updateSubscription(armedOrder.id, { status: "armed" });
  await updateSubscription(deliveringOrder.id, { status: "delivering" });
  await updateSubscription(armedPrice.id, { status: "armed" });

  const orderSubs = await readDesiredAlpacaOrderSubscriptions();
  const orderSubIds = orderSubs.map((s) => s.id);
  assert.ok(orderSubIds.includes(armedOrder.id));
  assert.ok(!orderSubIds.includes(deliveringOrder.id), "a delivering order.filled subscription must not be desired");
  assert.ok(!orderSubIds.includes(armedPrice.id), "a price-crossing subscription must never appear in the order.filled reader");
});

test("readDesiredEdgarSubscriptions: only ARMED filing.new subscriptions count, and alpaca subs never leak in", async (t) => {
  const conversationId = testConversationId();

  const armedFiling = await createSubscription({
    conversationId,
    provider: "edgar",
    event: "filing.new",
    resource: testSymbol(),
    params: {},
    expiresAt: null,
  });
  t.after(() => deleteSubscription(armedFiling.id));

  const deliveringFiling = await createSubscription({
    conversationId,
    provider: "edgar",
    event: "filing.new",
    resource: testSymbol(),
    params: {},
    expiresAt: null,
  });
  t.after(() => deleteSubscription(deliveringFiling.id));

  const pendingFiling = await createSubscription({
    conversationId,
    provider: "edgar",
    event: "filing.new",
    resource: testSymbol(),
    params: {},
    expiresAt: null,
  });
  t.after(() => deleteSubscription(pendingFiling.id));

  const armedAlpaca = await createSubscription({
    conversationId,
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: testSymbol(),
    params: { threshold: 150 },
    expiresAt: null,
  });
  t.after(() => deleteSubscription(armedAlpaca.id));

  await updateSubscription(armedFiling.id, { status: "armed" });
  await updateSubscription(deliveringFiling.id, { status: "delivering" });
  // pendingFiling stays "pending" (its create-time default)
  await updateSubscription(armedAlpaca.id, { status: "armed" });

  const edgarSubs = await readDesiredEdgarSubscriptions();
  const edgarSubIds = edgarSubs.map((s) => s.id);
  assert.ok(edgarSubIds.includes(armedFiling.id));
  assert.ok(!edgarSubIds.includes(deliveringFiling.id), "a delivering filing.new subscription must not be desired");
  assert.ok(!edgarSubIds.includes(pendingFiling.id), "a pending (not yet armed) subscription must not be desired");
  assert.ok(!edgarSubIds.includes(armedAlpaca.id), "an alpaca subscription must never appear in the edgar reader");
});
