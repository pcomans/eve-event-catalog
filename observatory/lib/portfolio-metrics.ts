import type { PortfolioHistoryDto } from "./campaign-dto.ts";

export interface EquityPoint {
  readonly at: string; // ISO timestamp
  readonly equity: number;
}

/**
 * Zips portfolio-history's parallel timestamp/equity arrays into points.
 * Two kinds of non-data are handled differently, per Alpaca's actual schema:
 *
 * - LEADING zero/null run: dropped entirely. Alpaca's portfolio/history
 *   returns a fixed lookback window (period=1M) padded with placeholder rows
 *   (0 or null) for every day before the account existed (this account is
 *   only ~2.5 days old, so most of a 1-month window is padding). Plotting
 *   them would falsely claim the account started at zero.
 * - Interior null (after real data has started): dropped, never plotted as
 *   $0 — null means "no sample for this day", not "recorded as zero". An
 *   interior 0, in contrast, is a real recorded value and is kept (it would
 *   be a real, if unusual, event).
 *
 * The two arrays are supposed to be parallel (one timestamp per equity
 * value), but a malformed response could make them unequal length —
 * reading past the end of the shorter one yields `undefined`, which slips
 * past the `=== null` guard and would emit a broken point. The loop is
 * bounded to the shorter array's length rather than trusting either one.
 */
export function toEquitySeries(history: Pick<PortfolioHistoryDto, "timestamp" | "equity">): EquityPoint[] {
  const isPlaceholder = (value: number | null): boolean => value === null || value === 0;
  const firstRealIndex = history.equity.findIndex((value) => !isPlaceholder(value));
  const startIndex = firstRealIndex === -1 ? history.equity.length : firstRealIndex;
  const sharedLength = Math.min(history.timestamp.length, history.equity.length);

  const points: EquityPoint[] = [];
  for (let i = startIndex; i < sharedLength; i++) {
    const equity = history.equity[i];
    if (equity === null) continue; // a missing sample, not a real $0 — drop rather than plot
    points.push({ at: new Date(history.timestamp[i] * 1000).toISOString(), equity });
  }
  return points;
}

/**
 * Sums parsed unrealized P&L across every open position, propagating
 * unavailability rather than fabricating a number: if ANY value is null (a
 * position's unrealized_pl failed to parse — see parse-wire-number.ts), the
 * whole aggregate is null. A $0 contribution from the bad position would
 * silently understate a real parsing failure instead of surfacing it.
 */
export function sumUnrealizedPnl(values: readonly (number | null)[]): number | null {
  let sum = 0;
  for (const value of values) {
    if (value === null) return null;
    sum += value;
  }
  return sum;
}

/**
 * Realized P&L, derived rather than fetched: this app is limited to
 * GET /v2/account, /v2/positions, and /v2/account/portfolio/history (no
 * /v2/account/activities), so there's no direct "realized P&L" field.
 *
 * Baseline is `initialEquity` — this paper account's inception equity
 * (CAMPAIGN_INITIAL_EQUITY, read server-side and passed down; see
 * app/campaign/page.tsx), a fixed constant for the life of the campaign.
 * Deliberately NOT portfolio-history's `base_value`: that field is the
 * first non-zero value in whatever window the request happens to cover, not
 * the account's real opening balance — correct today only because
 * period=1M still reaches this ~2.5-day-old account's inception, and wrong
 * by design the moment the account outlives that window.
 *
 * `equity` and `unrealizedPnl` are already-parsed numbers, not raw wire
 * strings — parsing happens once, at the boundary (campaign-view.tsx via
 * parse-wire-number.ts and sumUnrealizedPnl above), not here; this function
 * is pure arithmetic over trusted numbers.
 *
 * total P&L (current equity vs. initial equity) minus the sum of every open
 * position's unrealized P&L leaves exactly the P&L from closed trades.
 *
 * Caveat, deliberately not handled: this assumes no cash deposits or
 * withdrawals after inception, since a deposit would show up as phantom
 * "realized" gain (it isn't trading P&L). None exist or are expected on
 * this paper account; fills-based accounting would be the correct general
 * fix but is rejected here as over-engineering for this POC.
 */
export function computeRealizedPnl(equity: number, initialEquity: number, unrealizedPnl: number): number {
  const totalPnl = equity - initialEquity;
  return totalPnl - unrealizedPnl;
}
