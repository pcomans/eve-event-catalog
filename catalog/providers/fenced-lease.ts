// Correctness prerequisite 2 (docs/plan-vercel-production.md, docs/architecture.md
// "The future stream adapter" #2 "Fenced ownership"): the Alpaca account
// allows exactly one market-data connection. A chained Workflow session
// (each ~12 minutes on the Fluid GA ceiling) hands ownership from one step
// to the next — but a step can be delayed (a slow reconnect, a stalled
// retry) and resume AFTER its successor has already taken over. Without a
// fence, that delayed "zombie" session can still write state or attempt a
// delivery, corrupting whatever the current session already did.
//
// The fix: a monotonically increasing fencing token, minted on every lease
// acquisition (a Redis INCR in production — nextToken here is its pure
// equivalent), carried by every subsequent state/delivery write. A write is
// honored ONLY if its token is still the CURRENT one; anything older is a
// zombie and must be rejected — closing the "delayed writer clobbers its
// own replacement" race. Pure by design tonight (design + logic only, per
// this round's scope): no Redis here. The real INCR/lease-record wiring
// lands once the shared-Redis constraint lifts; these are the decision
// functions that wiring will call.

/** Mints the next fencing token — the pure equivalent of a Redis INCR. Strictly increasing, never reused. */
export function nextToken(lastIssuedToken: number): number {
  return lastIssuedToken + 1;
}

/**
 * A write is valid ONLY if `writeToken` is still the CURRENT token (the
 * most recently issued one) — anything older belongs to a superseded
 * ("zombie") holder. There is no such thing as a valid FUTURE token in a
 * correct caller (nextToken is the only way to advance `currentToken`), so
 * this is a strict equality check, not a "greater-or-equal" one.
 */
export function isWriteAllowed(currentToken: number, writeToken: number): boolean {
  return writeToken === currentToken;
}
