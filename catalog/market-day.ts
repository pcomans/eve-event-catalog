/**
 * Whether `date` falls on a US market weekday (Monday-Friday), evaluated in
 * UTC. POC-level: deliberately doesn't account for market holidays
 * (Thanksgiving, Christmas, ...) — a known, accepted gap (AGENTS.md rule 1:
 * no over-engineering), not a correctness bug. Callers that only ever
 * evaluate this near US market open (13:30-14:30 UTC, 9:30 ET, DST-dependent
 * — see agent/schedules/market-open.ts) don't hit the midnight-boundary case
 * where a UTC weekday could disagree with the US/Eastern one.
 */
export function isMarketWeekday(date: Date): boolean {
  const day = date.getUTCDay(); // 0 = Sunday, ..., 6 = Saturday
  return day >= 1 && day <= 5;
}
