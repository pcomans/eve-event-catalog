import { crosses, type CrossingDirection } from "./crossing.ts";

// Correctness prerequisite 1 (docs/plan-vercel-production.md, docs/architecture.md
// "The future stream adapter"): a distributed connector reconnects — a chained
// Workflow step boundary, a dropped socket, a redeploy — and loses whatever
// live ticks arrived during the gap. Re-seeding from the latest REST trade
// after a reconnect breaks edge-trigger semantics: if the price crossed the
// threshold AND recovered entirely within the gap (prev 151 -> gap 149 then
// back to 151 -> naive re-seed at 151), the crossing is silently lost and the
// agent never wakes. The fix: a persisted per-symbol cursor, a historical
// fetch covering the gap, a merge with whatever live trades were already
// buffered, deduped by trade id, and every trade run through the crossing
// predicate in order — never just re-seeding from the last value.
//
// Pure by design: no Redis, no Alpaca SDK import here. The real system
// plugs in a FetchHistoricalTrades function (the Alpaca REST seam) and reads
// the persisted cursor from Redis; this module only knows about plain
// arrays and objects, so it's directly unit-testable without either.

/**
 * One trade, in the shape needed for gap replay — mirrors Alpaca's raw wire
 * fields (`i`/`x`/`t`, per the plan's own "dedupe key i+x+t" — the same
 * fields RawTrade/StockTrade carry before @alpacahq/alpaca-trade-api's own
 * normalization), not the SDK's camelCased `Trade`/`StreamTrade` shape, so
 * this module has no SDK type dependency at all.
 */
export interface ReplayTrade {
  id: number;
  exchange: string;
  timestamp: string;
  price: number;
}

/** The persisted position: enough to ask "give me everything since here" on the next reconnect. */
export interface ReplayCursor {
  tradeId: number;
  exchange: string;
  timestamp: string;
}

function dedupeKey(trade: ReplayTrade): string {
  return `${trade.id}:${trade.exchange}:${trade.timestamp}`;
}

/**
 * Total order over trades: by timestamp first (sortable ISO-8601-like
 * strings — alpaca-client.ts prefers the SDK's full-precision
 * `timestampRaw` when the source preserves it, falling back to
 * millisecond precision otherwise), then exchange, then id as
 * deterministic tiebreakers for same-timestamp trades. True simultaneity
 * order for two trades sharing an exact timestamp is unknowable from
 * outside anyway — what matters for correctness is that the SAME trade
 * set always sorts the same way regardless of which source (historical
 * fetch or live buffer) produced each entry.
 */
function compareReplayTrades(a: ReplayTrade, b: ReplayTrade): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  if (a.exchange !== b.exchange) return a.exchange < b.exchange ? -1 : 1;
  return a.id - b.id;
}

/**
 * Merges the historical (gap-covering) fetch with whatever live trades were
 * already buffered while that fetch was in flight, deduping by trade
 * id+exchange+timestamp, then sorting into one true chronological order.
 *
 * Codex gate finding (2026-07-13): the two sources can legitimately
 * INTERLEAVE in time, not just overlap at a suffix — the live buffer starts
 * collecting from the moment the stream subscribes, which is BEFORE the
 * historical fetch's own "as of now" boundary resolves, so a buffered trade
 * can be chronologically earlier than some historical trades near the
 * boundary. Simple concatenation (historical-then-buffered) handed
 * replayThroughCrossingPredicate an out-of-order sequence in that case,
 * corrupting its running `previous` value trade-by-trade. Sorting the
 * deduped result fixes this regardless of which source produced which
 * trade.
 */
export function mergeGapTrades(historical: ReplayTrade[], buffered: ReplayTrade[]): ReplayTrade[] {
  const seen = new Set<string>();
  const merged: ReplayTrade[] = [];
  for (const trade of [...historical, ...buffered]) {
    const key = dedupeKey(trade);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(trade);
  }
  merged.sort(compareReplayTrades);
  return merged;
}

/**
 * Excludes any trade at-or-before `cursor`'s own position (same total
 * order as mergeGapTrades' sort). Codex gate finding: Alpaca's historical-
 * trades REST `start` parameter is INCLUSIVE, so a fetch scoped from the
 * cursor's own timestamp can return the cursor's own trade again (or other
 * trades sharing its exact timestamp) — replaying those against the
 * already-advanced-through `lastPrice` can manufacture a false crossing.
 * This filter makes correctness independent of whatever the upstream
 * source's inclusive/exclusive boundary semantics actually are; call it
 * AFTER mergeGapTrades, before replayThroughCrossingPredicate.
 */
export function filterTradesAfterCursor(cursor: ReplayCursor | null, trades: ReplayTrade[]): ReplayTrade[] {
  if (!cursor) return trades;
  const cursorTrade: ReplayTrade = { id: cursor.tradeId, exchange: cursor.exchange, timestamp: cursor.timestamp, price: 0 };
  return trades.filter((trade) => compareReplayTrades(trade, cursorTrade) > 0);
}

export interface CrossingReplayResult {
  /** True if ANY trade in the sequence crossed the threshold — even if a later trade in the same sequence recovered past it. */
  fired: boolean;
  /** The first trade that actually crossed, or null if none did. */
  firstCrossingTrade: ReplayTrade | null;
  /** The running "previous price" after the last trade — the new seed for whatever watches live from here. */
  finalPrevious: number;
}

/**
 * Runs every trade through the SAME edge-triggered crosses() predicate the
 * live handler uses, in order, carrying `previous` forward trade-by-trade —
 * this is what actually catches a crossing that happened and recovered
 * entirely inside the gap, which a naive "re-seed from the latest price"
 * approach can never see.
 */
export function replayThroughCrossingPredicate(
  direction: CrossingDirection,
  threshold: number,
  previous: number,
  trades: ReplayTrade[],
): CrossingReplayResult {
  let prev = previous;
  let fired = false;
  let firstCrossingTrade: ReplayTrade | null = null;
  for (const trade of trades) {
    if (!fired && crosses(direction, prev, trade.price, threshold)) {
      fired = true;
      firstCrossingTrade = trade;
    }
    prev = trade.price;
  }
  return { fired, firstCrossingTrade, finalPrevious: prev };
}

export function cursorFromTrade(trade: ReplayTrade): ReplayCursor {
  return { tradeId: trade.id, exchange: trade.exchange, timestamp: trade.timestamp };
}

/**
 * Task #33 (Redis command-burn reduction): pure throttle decision for the
 * connector's per-symbol cursor writes (connector/lib/alpaca-session.ts's
 * handleLiveTrade) — a persisted cursor is only ever READ on reconnect/
 * session-start (seedFromCursorReplay), so writing it on every single live
 * trade tick is unnecessary; at most once per `throttleMs` per symbol is
 * enough. `undefined` for `lastPersistedAtMs` means "never persisted this
 * session" — always due. `>=`, not `>`: a candidate arriving EXACTLY at the
 * throttle boundary counts as due (matches gap-replay-cursor.ts and the
 * read-cache's own boundary convention elsewhere in this codebase).
 */
export function shouldPersistCursorNow(lastPersistedAtMs: number | undefined, nowMs: number, throttleMs: number): boolean {
  return lastPersistedAtMs === undefined || nowMs - lastPersistedAtMs >= throttleMs;
}

/**
 * Whether `candidate` is strictly chronologically newer than `current` —
 * the same total order mergeGapTrades/advanceCursor use, pulled out as its
 * own question so a caller holding two bare ReplayCursor values (not a
 * trade sequence to fold through advanceCursor) can still ask it. `current
 * === null` means nothing persisted yet — any real candidate counts as
 * newer. One comparator for the whole codebase: advanceCursor (below) is
 * defined in terms of this, and gap-replay-cursor.ts's writeCursorFenced
 * (task #33's p6c fix — a same-token write must not regress the persisted
 * cursor, not just a different session's stale write) is the other caller.
 */
export function isCursorNewerThan(candidate: ReplayCursor, current: ReplayCursor | null): boolean {
  if (!current) return true;
  const candidateAsTrade: ReplayTrade = { id: candidate.tradeId, exchange: candidate.exchange, timestamp: candidate.timestamp, price: 0 };
  const currentAsTrade: ReplayTrade = { id: current.tradeId, exchange: current.exchange, timestamp: current.timestamp, price: 0 };
  return compareReplayTrades(candidateAsTrade, currentAsTrade) > 0;
}

/**
 * Whether two cursors mark the EXACT same position — same total order
 * isCursorNewerThan uses. p6d gate fix (task #33): a replay's persist and
 * the session's final flush landing the identical cursor+price back to
 * back (the ordinary, expected shape once the replay path keeps
 * pendingCursorBySymbol in sync — see alpaca-session.ts's
 * seedFromCursorReplay) is not a regression and must not log as one;
 * gap-replay-cursor.ts's writeCursorFenced uses this to report a distinct,
 * quiet "unchanged" result instead of the loud "regressed" one, which stays
 * reserved for a genuinely OLDER candidate.
 */
export function isCursorEqual(a: ReplayCursor, b: ReplayCursor): boolean {
  const aAsTrade: ReplayTrade = { id: a.tradeId, exchange: a.exchange, timestamp: a.timestamp, price: 0 };
  const bAsTrade: ReplayTrade = { id: b.tradeId, exchange: b.exchange, timestamp: b.timestamp, price: 0 };
  return compareReplayTrades(aAsTrade, bAsTrade) === 0;
}

/**
 * Advances the cursor to the last (chronologically latest, given an
 * already-sorted `trades` — mergeGapTrades' own output) trade in the
 * sequence; leaves it unchanged if the sequence is empty (nothing to
 * advance past) OR if the candidate would not actually move the cursor
 * forward. Codex gate finding: the original version trusted the last
 * array element unconditionally — given a caller that (incorrectly, or via
 * a future bug) hands it an unsorted or stale-tailed sequence, this could
 * regress the cursor backwards. Never regresses: a candidate at or before
 * the current position is rejected in favor of keeping `current`.
 */
export function advanceCursor(current: ReplayCursor | null, trades: ReplayTrade[]): ReplayCursor | null {
  if (trades.length === 0) return current;
  const candidate = cursorFromTrade(trades[trades.length - 1]);
  return isCursorNewerThan(candidate, current) ? candidate : current;
}

/** The seam a real Alpaca REST call plugs into (getStockTrades, scoped to the gap since `cursor`) — tests inject a stub returning plain arrays instead. */
export type FetchHistoricalTrades = (symbol: string, cursor: ReplayCursor | null) => Promise<ReplayTrade[]>;

export interface GapReplayResult extends CrossingReplayResult {
  mergedTrades: ReplayTrade[];
  nextCursor: ReplayCursor | null;
}

/**
 * The full reconnect-time replay: fetch the historical gap, merge+dedupe
 * with whatever live-buffered trades already arrived, drop anything at or
 * before the persisted cursor (filterTradesAfterCursor — the inclusive-REST-
 * start guard), run every remaining trade through the crossing predicate in
 * order, and advance the cursor to the last trade actually processed.
 * Called once per (re)connect, before the session goes live off its own
 * incoming stream.
 */
/**
 * Pads a millisecond-precision ISO-8601 string (`toISOString()`'s own
 * output — always exactly 3 fractional digits, e.g. "...T10:00:00.123Z")
 * out to nanosecond width (9 fractional digits) so it compares correctly
 * against a genuine `timestampRaw` string of the same width.
 *
 * Codex gate finding (p2v review, 2026-07-13): mixed-width timestamp
 * strings do NOT sort correctly under compareReplayTrades' lexicographic
 * comparison — a LATER nanosecond-precision trade within the same
 * millisecond can sort BEFORE an unpadded millisecond-precision one,
 * because the character "9" (from "...123999999Z") is lexicographically
 * SMALLER than "Z" (from the shorter "...123Z"), even though 0.123999999s
 * is numerically later than 0.123s. Every ReplayTrade timestamp must be
 * normalized to the SAME width at the point it's first created — see this
 * module's own ingestion boundaries: alpaca-client.ts's getHistoricalTrades
 * and alpaca-session.ts's toReplayTrade, both of which now prefer the SDK's
 * own `timestampRaw` when present and pad through this function otherwise.
 * A no-op if `iso` doesn't match the expected millisecond shape (defensive;
 * `toISOString()` always produces it).
 */
export function padTimestampToNanoseconds(iso: string): string {
  return iso.replace(/\.(\d+)Z$/, (_match, fractional: string) => `.${fractional.padEnd(9, "0")}Z`);
}

/**
 * Splits a symbol's watches into those safe to include in a shared,
 * cursor-anchored historical replay (their own `armedAt` is at-or-before
 * the persisted cursor's position, so nothing older than their own arm
 * time is ever examined) versus those that must be seeded fresh instead —
 * from a plain current-price snapshot, with NO historical replay at all.
 *
 * Codex gate finding (p2v review, 2026-07-13, findings 6 & 11): the
 * original connector either (a) fell back to an arbitrary fixed lookback
 * window when no cursor existed, replaying trades from before the
 * subscription ever existed against today's CURRENT price as if they were
 * live ticks — manufacturing false wakes — or (b) let a brand-new
 * subscription joining an ALREADY-watched symbol simply adopt a live
 * sibling's current `previous` value, silently skipping every trade
 * between ITS OWN armedAt and the moment the connector happened to notice
 * it. Both are the same root bug: a watch was exposed to (or credited
 * with) a decision window that started before it existed. The fix is this
 * bound, checked per watch: a watch may only ride the shared historical
 * replay if the persisted cursor already covers (is at or after) its own
 * armedAt; every other watch — no cursor at all, or one older than this
 * specific watch's own arm time — gets a fresh, narrow seed instead (see
 * alpaca-session.ts's seedSymbolFromScratch).
 *
 * `cursorTimestamp` is `null` when the symbol has never been watched at
 * all (finding 11's exact "no persisted cursor" case) — every watch then
 * needs a fresh seed, unconditionally. Pure: no Redis, no clock reads (a
 * missing `armedAt` — shouldn't happen for an armed subscription — is
 * treated as "just now," the conservative choice that routes it to fresh
 * seeding rather than risking it being treated as older than it is).
 */
export function partitionByCursorReadiness<T extends { sub: { armedAt: string | null } }>(
  watches: T[],
  cursorTimestamp: string | null,
): { readyForCursorReplay: T[]; needFreshSeed: T[] } {
  if (cursorTimestamp === null) return { readyForCursorReplay: [], needFreshSeed: [...watches] };

  const readyForCursorReplay: T[] = [];
  const needFreshSeed: T[] = [];
  for (const watch of watches) {
    const armedAt = watch.sub.armedAt ?? new Date().toISOString();
    if (armedAt <= cursorTimestamp) readyForCursorReplay.push(watch);
    else needFreshSeed.push(watch);
  }
  return { readyForCursorReplay, needFreshSeed };
}

export async function performGapReplay(
  fetchHistoricalTrades: FetchHistoricalTrades,
  symbol: string,
  cursor: ReplayCursor | null,
  buffered: ReplayTrade[],
  direction: CrossingDirection,
  threshold: number,
  previous: number,
): Promise<GapReplayResult> {
  const historical = await fetchHistoricalTrades(symbol, cursor);
  const merged = mergeGapTrades(historical, buffered);
  const mergedTrades = filterTradesAfterCursor(cursor, merged);
  const replay = replayThroughCrossingPredicate(direction, threshold, previous, mergedTrades);
  const nextCursor = advanceCursor(cursor, mergedTrades);
  return { ...replay, mergedTrades, nextCursor };
}
