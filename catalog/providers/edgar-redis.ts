import { Redis } from "@upstash/redis";

// Phase 3's first move (docs/plan-vercel-production.md: "seen-sets already
// Redis-shaped — move them from memory"): edgar.ts's in-memory
// `CikWatch.seen: Set<string>` only survives as long as one long-lived
// process holds it. A Workflow sweep (sleep(30s) recursion, replacing the
// setInterval loop) has no such guarantee between wakeups — each tick may
// run in a different execution context — so the seen-set has to live in
// Redis instead. A Redis SET is the natural fit: it's already exactly
// "which accession numbers have we seen for this CIK," and SADD is
// idempotent, so two overlapping coalesced sweeps adding the same
// accession twice is harmless — for THIS module's own storage.
//
// Codex gate finding (2026-07-13): that idempotency does NOT make this
// module safe as a delivery-dedup mechanism on its own. Two overlapping
// sweep workers can both call readSeenAccessions, both see an accession
// absent, both decide "this is new, deliver it," and only THEN both call
// addSeenAccessions — which correctly dedupes the STORAGE (the set ends up
// with the accession exactly once) but does nothing to stop BOTH workers
// from having already delivered a duplicate wake before that write ever
// happened. Team-lead's binding sign-off requirement: this module (and
// catalog/providers/edgar-sweep.ts, which DOES wire it into a real
// delivery path) must NOT treat "not in the seen-set" as the delivery gate
// — the actual gate is the SAME atomic claim the price-crossing and
// order-reconciliation legs use (registry.ts's tryTransitionToDelivering,
// via connector/lib/deliver-wake.ts's deliverWakeFromConnector), because
// filing.new subscriptions are one-shot: only one of two concurrent
// delivery attempts for the SAME subscription ever wins that CAS. This
// seen-set stays exactly what its name says: a diffing aid for "what's new
// since last poll," not a delivery lock. See edgar-sweep.test.ts's own
// overlap test for the end-to-end proof.
const redis = Redis.fromEnv();

function seenKey(cik: string): string {
  return `catalog:edgar-seen:${cik}`;
}

/** Every accession number already seen (delivered or seeded) for `cik` — empty if this CIK has never been watched. `catalog/providers/edgar-sweep.ts` treats an empty result as "never seeded" and seeds a baseline from it; that's safe there because its own sweep always persists every fetched filing's accession number on every tick (not just the seed baseline), so a genuinely-zero-filings CIK's seen-set stops reading empty the moment SEC records its first filing. */
export async function readSeenAccessions(cik: string): Promise<Set<string>> {
  const members = await redis.smembers(seenKey(cik));
  return new Set(members);
}

/** Adds newly-seen accession numbers for `cik` to the persisted seen-set. A no-op for an empty list — SADD with zero members is a wire-protocol error, not just a harmless call. */
export async function addSeenAccessions(cik: string, accessionNumbers: Iterable<string>): Promise<void> {
  const [first, ...rest] = accessionNumbers;
  if (first === undefined) return;
  await redis.sadd(seenKey(cik), first, ...rest);
}
