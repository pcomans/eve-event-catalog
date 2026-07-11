import assert from "node:assert/strict";
import { test } from "node:test";

import { buildWakePayload } from "./wake.ts";
import type { Subscription } from "./types.ts";

const baseSub: Subscription = {
  id: "sub-1",
  conversationId: "demo-2",
  provider: "alpaca",
  event: "price.crossesBelow",
  resource: "NVDA",
  params: { threshold: 150 },
  once: true,
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
