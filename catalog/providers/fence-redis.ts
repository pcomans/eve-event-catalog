import { Redis } from "@upstash/redis";

import { isWriteAllowed } from "./fenced-lease.ts";

// Real Redis backing for correctness prerequisite 2 (fenced leases) — the
// pure decision logic lives in fenced-lease.ts (nextToken/isWriteAllowed);
// this module is the ONLY thing that touches Redis, using a plain INCR as
// the token mint (monotonically increasing, atomic, exactly what the plan
// calls for). Every session step that wants to own a stream's writes must
// acquireFenceToken() at session start and check isFencedWriteAllowed()
// before any delivery/state write — a token from a superseded ("zombie")
// session fails that check even if the session itself doesn't know yet
// that it's been superseded.
const redis = Redis.fromEnv();

function fenceKey(streamId: string): string {
  return `catalog:fence:${streamId}`;
}

/** Mints a fresh fencing token for `streamId` via a real Redis INCR — this becomes the new CURRENT token, superseding whatever held it before. */
export async function acquireFenceToken(streamId: string): Promise<number> {
  return redis.incr(fenceKey(streamId));
}

/** Reads the CURRENT fencing token for `streamId` without minting a new one — 0 if the stream has never been fenced. */
export async function getCurrentFenceToken(streamId: string): Promise<number> {
  const value = await redis.get<number>(fenceKey(streamId));
  return value ?? 0;
}

/** Real-Redis-backed write check: reads the CURRENT token fresh and delegates the actual decision to the pure isWriteAllowed(). */
export async function isFencedWriteAllowed(streamId: string, writeToken: number): Promise<boolean> {
  const current = await getCurrentFenceToken(streamId);
  return isWriteAllowed(current, writeToken);
}

// Codex gate finding (2026-07-13, connector/lib/alpaca-session.ts): a plain
// isFencedWriteAllowed() check followed by a SEPARATE write call is a
// check-then-act race — a newer session can acquire a fresh token in the
// gap between the check and the write, and the stale write still lands.
// For state this module itself is responsible for persisting (the gap-
// replay cursor), the check and the write need to be one atomic Redis round
// trip. Same "opaque string CAS" shape as registry.ts's own CAS_SCRIPT: no
// data is decoded inside Lua, ARGV are opaque strings, the script's only
// job is "is this still the current token? if so, write."
//
// This is NOT a substitute for wake-delivery correctness — the actual wake
// POST is an HTTP call, which no Redis script can make atomic with a token
// check. That path's real safety net is tryTransitionToDelivering's own CAS
// in registry.ts (a completely separate, already-atomic mechanism); the
// fence check before a delivery attempt is a fast-path "probably stale,
// don't bother" skip, not the correctness guarantee.
const FENCED_SET_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("SET", KEYS[2], ARGV[2])
  return 1
else
  return 0
end
`;

/**
 * Atomically writes `value` to `key` only if `writeToken` is still the
 * CURRENT token for `streamId` at the moment of the write — not a moment
 * earlier. Returns false (writes nothing) if a newer token has since been
 * issued. `value` is JSON-stringified the same way @upstash/redis's own
 * automatic serialization would, so a plain `redis.get<T>(key)` (e.g.
 * gap-replay-cursor.ts's readCursor) reads it back correctly.
 */
export async function fencedSet(streamId: string, writeToken: number, key: string, value: unknown): Promise<boolean> {
  const result = await redis.eval<[string, string], number>(
    FENCED_SET_SCRIPT,
    [fenceKey(streamId), key],
    [String(writeToken), JSON.stringify(value)],
  );
  return result === 1;
}
