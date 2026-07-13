// Correctness prerequisite 3 (docs/plan-vercel-production.md, docs/architecture.md
// "The future stream adapter" #3 "Dynamic membership"): a running socket
// session has no instance affinity — a subscription armed (or disarmed)
// mid-session can't mutate the session's own in-memory state directly. The
// session instead re-reads the desired subscription set from Redis on a
// short cadence and adjusts its own stream subscriptions to match.
//
// Pure by design: no Redis import here. The real system plugs in a
// ReadDesiredMembership function (a Redis read of currently-armed
// subscriptions' resources); this module only knows about plain string
// sets, so it's directly unit-testable without it. (A Redis-backed
// integration test was considered — reads of shared Redis are safe in
// principle — but this worktree has no .env.local, and getting one would
// mean touching it, which is out of bounds for tonight; the pure seam
// tests below already cover every required scenario.)

export interface MembershipDelta {
  /** Symbols to add to the live stream subscription. */
  toSubscribe: string[];
  /** Symbols to drop from the live stream subscription. */
  toUnsubscribe: string[];
}

/**
 * Pure diff: what must change to bring the currently-streamed symbol set in
 * line with the desired one. An empty `desired` set naturally produces
 * "drop everything" — there's no special case needed, it falls out of the
 * same diff logic as any other membership change.
 */
export function computeMembershipDelta(currentlyStreamed: Iterable<string>, desired: Iterable<string>): MembershipDelta {
  const current = new Set(currentlyStreamed);
  const want = new Set(desired);
  const toSubscribe = [...want].filter((symbol) => !current.has(symbol));
  const toUnsubscribe = [...current].filter((symbol) => !want.has(symbol));
  return { toSubscribe, toUnsubscribe };
}

/** ~15s cadence per the prerequisite's own wording ("a short cadence (~15s)"). */
export const MEMBERSHIP_CHECK_CADENCE_MS = 15_000;

/** Pure cadence gate: has enough time passed since the last membership check to do another one? */
export function shouldRecheckMembership(lastCheckedMs: number, nowMs: number): boolean {
  return nowMs - lastCheckedMs >= MEMBERSHIP_CHECK_CADENCE_MS;
}

/** The seam a real Redis read (of currently-armed subscriptions' resources) plugs into — tests inject a stub returning a plain array. */
export type ReadDesiredMembership = () => Promise<string[]>;

export interface MembershipCheckResult {
  delta: MembershipDelta;
  /** The desired set just read — becomes "currentlyStreamed" for the NEXT check, once the session has actually applied `delta`. */
  desired: string[];
}

/**
 * One membership-check tick: read the desired set fresh, diff it against
 * whatever's currently streamed, and hand back both the delta to apply and
 * the new desired set (so the caller can carry it forward as next tick's
 * "currentlyStreamed" once it's actually applied the subscribe/unsubscribe
 * calls).
 */
export async function performMembershipCheck(
  readDesiredMembership: ReadDesiredMembership,
  currentlyStreamed: Iterable<string>,
): Promise<MembershipCheckResult> {
  const desired = await readDesiredMembership();
  const delta = computeMembershipDelta(currentlyStreamed, desired);
  return { delta, desired };
}
