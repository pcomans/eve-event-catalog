import assert from "node:assert/strict";
import { test } from "node:test";
import { streaming } from "@alpacahq/alpaca-trade-api";

import { countOrderFilledSubs, describeAuthFailure, subscriptionsForOrderUpdate } from "./alpaca.ts";
import type { Subscription } from "../types.ts";

const { STREAM_AUTH_STATUS } = streaming;

function makeSub(id: string, resource: string): Subscription {
  return {
    id,
    conversationId: `test:${id}`,
    provider: "alpaca",
    event: "order.filled",
    resource,
    params: {},
    expiresAt: null,
    status: "armed",
    createdAt: "2026-07-12T10:00:00.000Z",
    armedAt: "2026-07-12T10:00:01.000Z",
    firedAt: null,
    lastError: null,
  };
}

test("describeAuthFailure names the label, status, and message", () => {
  const message = describeAuthFailure("trade-updates", {
    status: STREAM_AUTH_STATUS.SERVER_REJECTED,
    authenticated: false,
    message: "invalid credentials",
  });
  assert.match(message, /trade-updates/);
  assert.match(message, /server_rejected/);
  assert.match(message, /invalid credentials/);
});

test("describeAuthFailure includes the server code when present", () => {
  const message = describeAuthFailure("market-data", {
    status: STREAM_AUTH_STATUS.SERVER_REJECTED,
    authenticated: false,
    code: 402,
    message: "auth failed",
  });
  assert.match(message, /402/);
});

test("describeAuthFailure omits a code section when none was given", () => {
  const message = describeAuthFailure("market-data", {
    status: STREAM_AUTH_STATUS.TIMEOUT,
    authenticated: false,
    message: "no response",
  });
  assert.doesNotMatch(message, /code=/);
});

test("subscriptionsForOrderUpdate returns every subscription watching the order on a terminal event", () => {
  const subA = makeSub("sub-a", "order-1");
  const subB = makeSub("sub-b", "order-1");
  const registry = new Map([["order-1", new Map([["sub-a", subA], ["sub-b", subB]])]]);

  const result = subscriptionsForOrderUpdate(registry, "order-1", "fill");
  assert.deepEqual(new Set(result), new Set([subA, subB]));
});

test("subscriptionsForOrderUpdate returns nothing for a non-terminal event (e.g. partial_fill)", () => {
  const subA = makeSub("sub-a", "order-1");
  const registry = new Map([["order-1", new Map([["sub-a", subA]])]]);

  assert.deepEqual(subscriptionsForOrderUpdate(registry, "order-1", "partial_fill"), []);
  assert.deepEqual(subscriptionsForOrderUpdate(registry, "order-1", "new"), []);
});

test("subscriptionsForOrderUpdate returns nothing when no subscription watches that order id", () => {
  const registry = new Map([["order-1", new Map([["sub-a", makeSub("sub-a", "order-1")]])]]);
  assert.deepEqual(subscriptionsForOrderUpdate(registry, "order-999", "fill"), []);
});

test("subscriptionsForOrderUpdate returns nothing when the order id is undefined", () => {
  const registry = new Map([["order-1", new Map([["sub-a", makeSub("sub-a", "order-1")]])]]);
  assert.deepEqual(subscriptionsForOrderUpdate(registry, undefined, "fill"), []);
});

test("countOrderFilledSubs sums subscriptions across every watched order", () => {
  const registry = new Map([
    ["order-1", new Map([["sub-a", makeSub("sub-a", "order-1")], ["sub-b", makeSub("sub-b", "order-1")]])],
    ["order-2", new Map([["sub-c", makeSub("sub-c", "order-2")]])],
  ]);
  assert.equal(countOrderFilledSubs(registry), 3);
});

test("countOrderFilledSubs is zero for an empty registry", () => {
  assert.equal(countOrderFilledSubs(new Map()), 0);
});
