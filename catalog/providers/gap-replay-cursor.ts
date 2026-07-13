import { Redis } from "@upstash/redis";

import { fencedSet } from "./fence-redis.ts";
import type { ReplayCursor } from "./gap-replay.ts";

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

/**
 * Fenced write: persists the cursor+price for `symbol` only if `writeToken`
 * is still the current fencing token for `streamId` AT THE MOMENT OF THE
 * WRITE — one atomic Redis round trip (fence-redis.ts's fencedSet), not a
 * check followed by a separate write (Codex gate finding: that gap lets a
 * zombie session's write land after a newer session has already taken
 * over). Returns false if the write was skipped as stale.
 */
export async function writeCursorFenced(
  streamId: string,
  writeToken: number,
  symbol: string,
  value: PersistedCursor,
): Promise<boolean> {
  return fencedSet(streamId, writeToken, cursorKey(symbol), value);
}
