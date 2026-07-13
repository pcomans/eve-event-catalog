// The supervisor half of the chain-guard pattern (KNOWN_ISSUES.md #15): a
// connector run-forever workflow updates its own heartbeat once per bounded
// step; this pure function decides, given that heartbeat and the current
// time, whether the chain should be considered dead — either because it
// never started (bootstrap: no heartbeat yet) or because it's gone stale
// for longer than the caller's own tolerance.
//
// Pure by design: no Redis, no clock reads. The real system (catalog/
// providers/chain-guard.ts) plugs in the actual heartbeat read and
// Date.now(); this module only knows about plain numbers.

/**
 * True if the chain should be considered dead: no heartbeat has EVER been
 * recorded (bootstrap — nothing is running yet, or the heartbeat key has
 * expired long enough that Redis dropped it), or the most recent heartbeat
 * is older than `staleAfterMs`.
 */
export function isChainDead(heartbeatMs: number | null, nowMs: number, staleAfterMs: number): boolean {
  if (heartbeatMs === null) return true;
  return nowMs - heartbeatMs > staleAfterMs;
}
