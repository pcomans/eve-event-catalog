import assert from "node:assert/strict";
import { test } from "node:test";

import {
  performOrderReconciliation,
  reconcileOrderStatuses,
  takeReconciliationBatch,
  type OrderStatusSnapshot,
} from "./order-reconciliation.ts";

function status(orderId: string, status: string, filledQty: string | null = null): OrderStatusSnapshot {
  return { orderId, status, filledQty, filledAvgPrice: filledQty ? "150.00" : null };
}

test("reconcileOrderStatuses: an order that's now filled produces exactly one wake decision", () => {
  const decisions = reconcileOrderStatuses([status("order-1", "filled", "10")], []);

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].orderId, "order-1");
  assert.equal(decisions[0].status, "filled");
  assert.equal(decisions[0].filledQty, "10");
});

test("reconcileOrderStatuses: an order already delivered produces zero decisions, even though it's still terminal", () => {
  const decisions = reconcileOrderStatuses([status("order-1", "filled", "10")], ["order-1"]);
  assert.equal(decisions.length, 0);
});

test("reconcileOrderStatuses: an order still open (non-terminal status) produces zero decisions", () => {
  const decisions = reconcileOrderStatuses(
    [status("order-1", "new"), status("order-2", "filled", "5"), status("order-3", "partially_filled")],
    [],
  );

  assert.equal(decisions.length, 1, "only order-2 (the one that's actually terminal) should produce a decision");
  assert.equal(decisions[0].orderId, "order-2");
});

test("reconcileOrderStatuses: cancel/reject/expire all produce a terminal wake decision carrying the correct status", () => {
  const statuses: OrderStatusSnapshot[] = [
    status("order-cancel", "canceled"),
    status("order-reject", "rejected"),
    status("order-expire", "expired"),
  ];
  const decisions = reconcileOrderStatuses(statuses, []);

  assert.equal(decisions.length, 3);
  const byId = Object.fromEntries(decisions.map((d) => [d.orderId, d.status]));
  assert.equal(byId["order-cancel"], "canceled");
  assert.equal(byId["order-reject"], "rejected");
  assert.equal(byId["order-expire"], "expired");
});

// Codex gate finding: the original module never guarded against a
// duplicate orderId appearing twice within ONE fetch's own results — a
// real bug for the old bulk date-range endpoint (pagination could return
// the same row twice); kept as a defensive guarantee here too even though
// the per-id fetch design makes it much less likely to occur in practice.
test("reconcileOrderStatuses: the SAME orderId appearing twice in one batch only produces one decision", () => {
  const decisions = reconcileOrderStatuses([status("order-1", "filled", "10"), status("order-1", "filled", "10")], []);
  assert.equal(decisions.length, 1, "a duplicate row for the same order within a single fetch must not double-wake");
});

test("reconcileOrderStatuses: an empty statuses list always produces zero decisions", () => {
  assert.deepEqual(reconcileOrderStatuses([], []), []);
});

test("performOrderReconciliation: an empty watched-order list short-circuits without calling the fetch seam at all", async () => {
  let called = false;
  const decisions = await performOrderReconciliation(
    async () => {
      called = true;
      return [];
    },
    [],
    [],
  );

  assert.equal(called, false, "nothing to reconcile — the fetch seam must not be called");
  assert.deepEqual(decisions, []);
});

test("performOrderReconciliation: fetches at the injected seam with every watched order id, then reconciles", async () => {
  let fetchCalledWith: string[] | undefined;
  const decisions = await performOrderReconciliation(
    async (orderIds) => {
      fetchCalledWith = orderIds;
      return [status("order-1", "filled", "10"), status("order-2", "canceled")];
    },
    ["order-1", "order-2"],
    [],
  );

  assert.deepEqual(fetchCalledWith, ["order-1", "order-2"]);
  assert.equal(decisions.length, 2);
});

// A GENUINE overlap scenario (not the previous design's manually-seeded
// "pass the first sweep's result to the second" shortcut, which Codex
// correctly flagged as vacuous — it never actually modeled two sweeps
// racing from the same starting information). Two sweeps both start not
// knowing about each other, both see the SAME watched order already
// terminal, and BOTH would decide to wake it — the alreadyDeliveredOrderIds
// set is what has to prevent the second one from acting on that decision;
// this test proves the dedup guard is what's carrying the safety, not the
// fetch happening to change between calls.
test("performOrderReconciliation: two overlapping sweeps starting from the SAME snapshot only wake once, via the alreadyDelivered guard", async () => {
  const fetchStatuses = async () => [status("order-1", "filled", "10")];

  const firstSweep = await performOrderReconciliation(fetchStatuses, ["order-1"], []);
  assert.equal(firstSweep.length, 1, "the first sweep to see this order terminal must produce a decision");

  // The second sweep is handed the SAME fetch result (as it would be, had
  // it raced the first and read the account's order state at the same
  // moment) — only the alreadyDeliveredOrderIds set (populated from
  // whatever the caller has ACTUALLY delivered by now, e.g. via
  // tryTransitionToDelivering succeeding) distinguishes them.
  const secondSweep = await performOrderReconciliation(fetchStatuses, ["order-1"], ["order-1"]);
  assert.equal(secondSweep.length, 0, "a sweep that already knows order-1 was delivered must not wake it again");
});

test("takeReconciliationBatch: fewer items than the cap returns everything, unrotated", () => {
  assert.deepEqual(takeReconciliationBatch(["a", "b", "c"], 0, 25), ["a", "b", "c"]);
});

test("takeReconciliationBatch: caps the batch size and wraps the offset around the end of the list", () => {
  const items = ["a", "b", "c", "d", "e"];
  assert.deepEqual(takeReconciliationBatch(items, 3, 3), ["d", "e", "a"], "must wrap from the end back to the start rather than stopping short");
});

test("takeReconciliationBatch: rotating the offset by the batch size across enough ticks eventually reaches every item, none skipped forever", () => {
  const items = ["a", "b", "c", "d", "e"];
  const size = 2;
  const seen = new Set<string>();
  let offset = 0;
  for (let i = 0; i < 3; i++) {
    // 3 ticks of size 2 over 5 items is enough to wrap around and touch
    // every item at least once (a real cadence loop keeps rotating
    // forever, so exact partitioning per cycle isn't required — only that
    // nothing is skipped permanently).
    const batch = takeReconciliationBatch(items, offset, size);
    for (const item of batch) seen.add(item);
    offset = (offset + batch.length) % items.length;
  }
  assert.deepEqual([...seen].sort(), [...items].sort(), "every item must be reached across enough ticks, none skipped forever");
});

test("takeReconciliationBatch: an empty list or a non-positive size returns nothing", () => {
  assert.deepEqual(takeReconciliationBatch([], 0, 10), []);
  assert.deepEqual(takeReconciliationBatch(["a"], 0, 0), []);
});
