import { listSubscriptions } from "../registry.ts";
import type { Subscription } from "../types.ts";

// Real Redis backing for correctness prerequisite 3 (dynamic membership)'s
// read side: membership-delta.ts's pure computeMembershipDelta() decides
// what to subscribe/unsubscribe GIVEN a desired set; this module derives
// that desired set from the actual subscription registry. "Live" here means
// "armed" ONLY — NOT "delivering".
//
// Codex gate finding (2026-07-13, reversing an earlier design choice): a
// "delivering" subscription's fate is already sealed — its
// deliverReason/deliverSnapshot are already durably recorded
// (tryTransitionToDelivering), and it resolves to fired/expired/failed via
// the delivery pipeline or wake.ts's own recovery sweep, never by being
// checked against a NEW live tick. Keeping it in the desired set doesn't
// protect anything: another ARMED subscription on the same symbol keeps
// that symbol desired independently, and a fresh re-arm creates its own new
// "armed" row. All including "delivering" accomplished was keeping a
// symbol's stream subscription alive indefinitely if THIS was the only
// watcher and it got stranded in "delivering" (e.g. a crash before
// resolving), plus redundant guardedDeliver attempts against an
// already-claimed subscription on every subsequent tick for that symbol
// (harmless — tryTransitionToDelivering correctly no-ops them — but
// pointless work).
const PRICE_CROSSING_EVENTS = new Set(["price.crossesBelow", "price.crossesAbove"]);
const LIVE_STATUSES = new Set(["armed"]);

async function readLiveSubscriptionsByProvider(provider: string): Promise<Subscription[]> {
  const subs = await listSubscriptions();
  return subs.filter((sub) => sub.provider === provider && LIVE_STATUSES.has(sub.status));
}

/** Every currently-live alpaca price-crossing subscription, full detail (symbol/direction/threshold all derive from these). */
export async function readDesiredAlpacaPriceSubscriptions(): Promise<Subscription[]> {
  const subs = await readLiveSubscriptionsByProvider("alpaca");
  return subs.filter((sub) => PRICE_CROSSING_EVENTS.has(sub.event));
}

/**
 * Matches membership-delta.ts's ReadDesiredMembership seam exactly: the
 * symbol set the live stock-data stream should be subscribed to right now.
 */
export async function readDesiredAlpacaSymbols(): Promise<string[]> {
  const subs = await readDesiredAlpacaPriceSubscriptions();
  return [...new Set(subs.map((sub) => sub.resource))];
}

/** Every currently-live alpaca order.filled subscription — the trade_updates leg's watch list. */
export async function readDesiredAlpacaOrderSubscriptions(): Promise<Subscription[]> {
  const subs = await readLiveSubscriptionsByProvider("alpaca");
  return subs.filter((sub) => sub.event === "order.filled");
}

/**
 * Every currently-live edgar filing.new subscription — Phase 3's EDGAR sweep
 * watch list. `resource` is the ticker (see edgar.ts's own armFilingNew,
 * which resolves CIK from this same field); grouping by CIK for the
 * coalesced poll is the sweep's own job (multiple tickers/subscriptions can
 * legitimately resolve to the same CIK).
 */
export async function readDesiredEdgarSubscriptions(): Promise<Subscription[]> {
  const subs = await readLiveSubscriptionsByProvider("edgar");
  return subs.filter((sub) => sub.event === "filing.new");
}
