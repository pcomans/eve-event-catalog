// The trade_updates gap leg of correctness prerequisite 1 (docs/architecture.md
// "The future stream adapter" #4, "order.filled reconciliation stays easy
// everywhere: only the terminal state matters, and a single REST read
// recovers it after any gap"). A chained connector session can miss a
// pushed trade_updates event across a reconnect the same way a market-data
// session can miss a tick — recovery here queries each WATCHED order id's
// current status directly, rather than scanning a closed-orders date range.
//
// Redesigned 2026-07-13 after a Codex gate review found the original
// [after, until]-bracket design couldn't actually implement what it
// promised: Alpaca's closed-orders `after`/`until` filter applies to the
// order's `submitted_at`, not its terminal transition — an order submitted
// before the bracket but terminalized DURING the gap is invisible to that
// query regardless of how the bracket is chosen, and the endpoint pages at
// a default limit of 50 with no auto-pagination (and no `ids` filter
// exists to ask for a specific batch either — checked the SDK's own
// GetAllOrdersRequest type). Since every order this module ever needs to
// check is already a KNOWN, WATCHED id (a subscription's own `resource`),
// asking "what is order X's status right now" per watched id sidesteps
// all three problems at once — no time bracket, no pagination, no
// ambiguity about which timestamp field was filtered on.
//
// Pure by design: no Redis, no Alpaca SDK import. The real system plugs in
// a FetchOrderStatuses function (catalog/providers/alpaca-client.ts's
// getOrderStatuses) and reads the set of already-delivered order ids from
// Redis (the same dedupe idea deliverWake's own wake-delivery marker uses).

/** Matches alpaca-client.ts's own TERMINAL_ORDER_STATUSES set exactly. */
export type OrderTerminalStatus = "filled" | "canceled" | "rejected" | "expired";
const TERMINAL_ORDER_STATUSES = new Set<string>(["filled", "canceled", "rejected", "expired"]);

/** One order's current status, in the shape needed for reconciliation — Alpaca's `status` is a much larger enum than OrderTerminalStatus (e.g. "new", "partially_filled", "replaced", ...); only the four terminal values above ever produce a wake decision. */
export interface OrderStatusSnapshot {
  orderId: string;
  status: string;
  filledQty?: string | null;
  filledAvgPrice?: string | null;
}

export interface WakeDecision {
  orderId: string;
  status: OrderTerminalStatus;
  filledQty?: string | null;
  filledAvgPrice?: string | null;
}

/**
 * Decides which terminal wakes to emit from a batch of order-status
 * snapshots: only for orders that have actually reached one of the four
 * terminal statuses, only once — an order id already present in
 * `alreadyDeliveredOrderIds` is skipped, and a hypothetical duplicate
 * orderId within one `statuses` batch is only ever emitted once.
 */
export function reconcileOrderStatuses(
  statuses: OrderStatusSnapshot[],
  alreadyDeliveredOrderIds: Iterable<string>,
): WakeDecision[] {
  const delivered = new Set(alreadyDeliveredOrderIds);
  const emitted = new Set<string>();
  const decisions: WakeDecision[] = [];
  for (const snapshot of statuses) {
    if (!TERMINAL_ORDER_STATUSES.has(snapshot.status)) continue; // still open/pending — nothing to do yet
    if (delivered.has(snapshot.orderId)) continue;
    if (emitted.has(snapshot.orderId)) continue;
    emitted.add(snapshot.orderId);
    decisions.push({
      orderId: snapshot.orderId,
      status: snapshot.status as OrderTerminalStatus,
      filledQty: snapshot.filledQty,
      filledAvgPrice: snapshot.filledAvgPrice,
    });
  }
  return decisions;
}

/**
 * Returns up to `size` items starting at `offset`, wrapping around the end
 * of `items` back to the start — the rotation that bounds one cadence
 * tick's reconciliation batch while still guaranteeing every item is
 * eventually covered, a few ticks later, without ever re-querying the same
 * subset forever.
 *
 * Codex gate finding (p2v review, 2026-07-13): reconciling every watched
 * order on EVERY 15s cadence tick, with no batch/concurrency/deadline
 * bound, means enough armed order.filled subscriptions can stretch a
 * single tick's REST calls past the session step's own maxDuration budget
 * — a hard kill rather than a bounded, predictable session. Capping the
 * batch and rotating the offset each tick (alpaca-session.ts's
 * reconcileOrders) turns an unbounded per-tick cost into a bounded one,
 * spread over `ceil(total / size)` ticks instead. Pure.
 */
export function takeReconciliationBatch<T>(items: readonly T[], offset: number, size: number): T[] {
  if (items.length === 0 || size <= 0) return [];
  const boundedSize = Math.min(size, items.length);
  const normalizedOffset = ((offset % items.length) + items.length) % items.length;
  const batch: T[] = [];
  for (let i = 0; i < boundedSize; i++) {
    batch.push(items[(normalizedOffset + i) % items.length]);
  }
  return batch;
}

/** The seam a real Alpaca "get order by id" REST call (batched across every watched id) plugs into — tests inject a stub returning plain arrays. */
export type FetchOrderStatuses = (orderIds: string[]) => Promise<OrderStatusSnapshot[]>;

/**
 * The full reconciliation sweep: look up every watched order's CURRENT
 * status, then decide which terminal wakes to emit for the ones that
 * haven't already been delivered. An empty watch list short-circuits
 * without calling the fetch seam at all — nothing to reconcile.
 */
export async function performOrderReconciliation(
  fetchOrderStatuses: FetchOrderStatuses,
  watchedOrderIds: string[],
  alreadyDeliveredOrderIds: Iterable<string>,
): Promise<WakeDecision[]> {
  if (watchedOrderIds.length === 0) return [];
  const statuses = await fetchOrderStatuses(watchedOrderIds);
  return reconcileOrderStatuses(statuses, alreadyDeliveredOrderIds);
}
