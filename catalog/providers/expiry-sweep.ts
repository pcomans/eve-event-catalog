import { getSubscriptions, readDueExpirySubscriptionIds } from "../registry.ts";
import type { Subscription } from "../types.ts";

// Phase 3's expiry migration (docs/plan-vercel-production.md): the durable
// side of subscription expiry. wake.ts's own scheduleExpiry/expire (an
// in-process setTimeout) is an in-process stand-in that doesn't survive a
// serverless instance recycling — kept as-is for local dev (one code path
// per host, same convention as the alpaca legs' WATCHER_HOST switch), but a
// serverless/deployed eve instance needs a durable driver that doesn't
// depend on any one process staying alive. This module is that driver's
// core: read every subscription id currently due (registry.ts's own
// sorted-set index, dual-written at arm time), and attempt to deliver an
// "expired" wake for each.
//
// Safe under a LOCAL timer and this DURABLE sweep racing the SAME
// subscription (the team-lead-specified "both-fire" case) for the exact
// same reason every other sweep in this codebase is safe under overlap:
// `deliver` (deliverExpiredWakeFromConnector in production) transitions
// through registry.ts's tryTransitionToDelivering, an atomic CAS — only one
// of the two ever wins the armed->delivering transition, and the loser's
// call is a verified no-op (see connector/lib/deliver-wake.ts's own
// deliverExpiredWakeFromConnector doc comment, and its own binding
// "both-fire race" test).

function log(line: string): void {
  console.log(`[expiry-sweep] ${line}`);
}

/** Delivers one "expired" wake for one subscription — connector/lib/deliver-wake.ts's deliverExpiredWakeFromConnector in production. */
export type DeliverExpiredWake = (sub: Subscription) => Promise<void>;

/**
 * One full sweep tick: reads every subscription id currently due (armed,
 * with expiresAt <= now) and attempts an "expired" delivery for each. One
 * poison row (a subscription deleted between the index read and this read,
 * or any other unexpected error) is logged and skipped, not a reason to
 * abort the rest of the tick — same "one poison row must not starve the
 * round" philosophy as wake.ts's own sweepStrandedDeliveries.
 *
 * Task #33 (Redis command-burn reduction): the per-id read below used to be
 * one GET per due id; getSubscriptions batches the whole due list into one
 * MGET. That batch read is its own try/catch, separate from the per-row
 * loop's — a Redis error on the BATCH read has no per-row data to isolate
 * (unlike a single row's delivery throwing), so it's logged and this tick
 * simply delivers nothing rather than crashing the workflow step; the next
 * tick re-reads the same still-due ids from the expiry index and retries.
 */
export async function runExpirySweepTick(deliver: DeliverExpiredWake, nowMs: number = Date.now()): Promise<void> {
  const dueIds = await readDueExpirySubscriptionIds(nowMs);
  if (dueIds.length === 0) return;

  log(`sweep due=${dueIds.length}`);

  let subs: (Subscription | null)[];
  try {
    subs = await getSubscriptions(dueIds);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`expiry-sweep-batch-read-failed count=${dueIds.length} error=${message}`);
    return;
  }

  for (let i = 0; i < dueIds.length; i++) {
    const id = dueIds[i];
    const sub = subs[i];
    try {
      if (!sub) {
        log(`expiry-sweep-row-skipped sub=${id} — no longer exists`);
        continue;
      }
      await deliver(sub);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`expiry-sweep-row-failed sub=${id} error=${message}`);
    }
  }
}
