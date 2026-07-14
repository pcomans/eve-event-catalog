import { Redis } from "@upstash/redis";

import { fencedSet } from "./fence-redis.ts";
import { isCursorEqual, isCursorNewerThan, type ReplayCursor } from "./gap-replay.ts";

// Real Redis backing for correctness prerequisite 1's cursor half: gap-replay.ts's
// pure advanceCursor()/cursorFromTrade() decide WHAT the next cursor should
// be; this module is the only thing that persists it, one key per symbol so
// a reconnect always resumes from exactly where that symbol's stream last
// left off, independent of any other symbol's progress.
//
// Alongside the cursor itself, this also persists the price seen at that
// cursor (`lastPrice`) — gap-replay's replayThroughCrossingPredicate needs a
// starting "previous" price to compare the first replayed trade against, and
// that price has to survive a reconnect the same way the cursor does (a
// fresh REST getLatestTrade() call after a reconnect would have the exact
// same "re-seed from latest" bug the cursor itself exists to avoid).
const redis = Redis.fromEnv();

export interface PersistedCursor {
  cursor: ReplayCursor;
  lastPrice: number;
}

function cursorKey(symbol: string): string {
  return `catalog:cursor:${symbol}`;
}

/** Reads the persisted cursor+price for `symbol`, or null if this symbol has never been streamed (first-connect gap). */
export async function readCursor(symbol: string): Promise<PersistedCursor | null> {
  return redis.get<PersistedCursor>(cursorKey(symbol));
}

// An unconditional, unfenced writeCursor() USED to live here. Codex gate
// finding (2026-07-13): "an unconditional SET with neither a fencing token
// nor an atomic cursor comparison — a delayed session can overwrite a newer
// persisted cursor." Removed entirely rather than kept as a footgun
// alongside the fenced version below — every real write goes through
// writeCursorFenced now (connector/lib/alpaca-session.ts), and there is no
// other legitimate caller for an unfenced cursor write.

export type WriteCursorResult = "written" | "fenced-out" | "regressed" | "unchanged";

/**
 * Fenced write: persists the cursor+price for `symbol` only if `writeToken`
 * is still the current fencing token for `streamId` AT THE MOMENT OF THE
 * WRITE — one atomic Redis round trip (fence-redis.ts's fencedSet), not a
 * check followed by a separate write (Codex gate finding: that gap lets a
 * zombie session's write land after a newer session has already taken
 * over).
 *
 * p6c gate finding (task #33's cursor-write throttle): fencing alone isn't
 * enough — it only rejects a DIFFERENT (superseded) session's write; it says
 * nothing about whether `value.cursor` is actually newer than what's
 * currently persisted for THIS SAME still-current token. Without this
 * check, a same-session write ordered AFTER a newer one (e.g. the
 * connector's own final step-end flush racing behind a gap-replay's direct
 * persist) could regress the cursor and force the next reconnect to
 * re-replay an already-completed gap. Reads the current cursor first and
 * compares with gap-replay.ts's isCursorNewerThan (the SAME "is this newer"
 * question advanceCursor answers — not a second, separately-invented
 * notion) before attempting the fenced write; skips it entirely if the
 * candidate wouldn't advance the cursor. An exactly-equal candidate (the
 * ordinary shape once a replay's own direct persist and a later flush of
 * the SAME value line up — p6d gate finding) is reported as the quiet
 * "unchanged" no-op, not the loud "regressed" one, which stays reserved for
 * a genuinely older candidate.
 *
 * p6d gate finding: this read-then-write is NOT sufficient on its own —
 * Codex proved genuine concurrent writers for the SAME symbol DO exist (a
 * delayed live-trade write racing the final flush; an in-flight
 * gap-replay racing a reconnect-triggered flush), so the seedingSymbols-
 * based "mutually exclusive in time" reasoning this comment used to make
 * does not hold under shutdown or overlapping reconnects. The actual
 * correctness guarantee is now the CALLER's job: every real write goes
 * through connector/lib/serial-queue.ts's per-symbol serialization
 * (alpaca-session.ts's writeCursorSerialized), so two writes for the same
 * symbol can never be in flight here at once — this function's own guard
 * is a second, redundant line of defense, not the primary one.
 */
export async function writeCursorFenced(
  streamId: string,
  writeToken: number,
  symbol: string,
  value: PersistedCursor,
): Promise<WriteCursorResult> {
  const current = await readCursor(symbol);
  if (current) {
    if (isCursorEqual(value.cursor, current.cursor)) return "unchanged";
    if (!isCursorNewerThan(value.cursor, current.cursor)) return "regressed";
  }

  const wrote = await fencedSet(streamId, writeToken, cursorKey(symbol), value);
  return wrote ? "written" : "fenced-out";
}
