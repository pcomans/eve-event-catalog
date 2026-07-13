import { listSubscriptions } from "../registry.ts";
import type { Subscription } from "../types.ts";

// Phase 3's recovery-sweep migration (docs/plan-vercel-production.md): the
// durable driver for correctness prerequisite 4's own recovery leg. wake.ts's
// startRecoverySweep/sweepStrandedDeliveries (a setInterval in the eve
// process) is the ORIGINAL, in-process stand-in — the Phase 1 Codex gate's
// own words: "a frozen Fluid instance never ticks." This module is the
// SAME core idea (find subscriptions stuck in "delivering" and resume them
// from their own persisted deliverReason/deliverSnapshot) driven from the
// connector's durable loop instead — wake.ts's own sweep is left completely
// untouched, staying the local-dev path (one code path per host).
//
// DELIBERATE SIMPLIFICATION vs. wake.ts's own sweep (flagged to team-lead,
// not silently decided): wake.ts's sweepStrandedDeliveries additionally
// checks a delivery LEASE (a separate Redis key, private to wake.ts) before
// resuming a row, as a fast-path skip for "someone is actively sending this
// right now." This module does NOT reimplement or share that lease check —
// it resumes every "delivering" row it finds, every tick. That's safe, not
// just convenient: the actual correctness guarantee for one-shot delivery
// is registry.ts's own tryTransitionToDelivering CAS (this same module's
// `deliver` always goes through it, via connector/lib/deliver-wake.ts's
// deliverStrandedWakeFromConnector) plus the wake-delivery marker's
// alreadyInFlight/alreadyDelivered dedup — both already independent of any
// lease. Skipping the lease check only means this sweep can occasionally
// retry a subscription that's ALREADY being actively resumed by wake.ts's
// own eve-side sweep at the same moment; that retry is a verified no-op
// (same "fencing/leasing is a fast path, not the guarantee" precedent as
// the alpaca legs' own fenced writes), just slightly more redundant work
// than full parity would be.

function log(line: string): void {
  console.log(`[recovery-sweep] ${line}`);
}

/** Resumes one stranded subscription — connector/lib/deliver-wake.ts's deliverStrandedWakeFromConnector in production. */
export type DeliverStranded = (sub: Subscription) => Promise<void>;

/**
 * One full sweep tick: finds every subscription currently stuck in
 * "delivering" with a persisted deliverReason, and resumes each. One
 * poison row (an unexpected error resuming one subscription) is logged and
 * skipped, not a reason to abort the round — same "one poison row must not
 * starve the rest" philosophy as wake.ts's own sweepStrandedDeliveries.
 */
export async function runRecoverySweepTick(deliver: DeliverStranded): Promise<void> {
  const all = await listSubscriptions();
  const stranded = all.filter((sub) => sub.status === "delivering" && sub.deliverReason);
  if (stranded.length === 0) return;

  log(`sweep stranded=${stranded.length}`);

  for (const sub of stranded) {
    try {
      await deliver(sub);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`recovery-sweep-row-failed sub=${sub.id} error=${message}`);
    }
  }
}
