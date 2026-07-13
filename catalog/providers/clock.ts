import type { Subscription } from "../types.ts";
import { registerProvider, type Provider } from "../catalog.ts";
import { getSubscription } from "../registry.ts";
import { deliverWake } from "../wake.ts";

function log(line: string) {
  console.log(`[clock] ${line}`);
}

function getAt(sub: Subscription): string {
  return (sub.params as { at: string }).at;
}

// In-process only — same documented boundary as wake.ts's own expiry
// timers (scheduleExpiry/cancelExpiry): lost on a server restart. A durable
// variant rides Phase 3's migration of the expiry mechanism to a persisted
// driver; not built here (AGENTS.md rule 1 — no engineering ahead of what
// this task needs).
//
// One record per armed subscription, kept alive for the subscription's
// ENTIRE lifecycle (not just while a timer happens to be pending) — a
// bare `Map<string, Timer>` isn't enough: fire() deletes its own (already-
// spent) timer entry before its own awaits, so a disarm() arriving WHILE a
// fire() attempt is in flight would find nothing to cancel and have no way
// to tell that attempt "never mind" — the record's own `cancelled` flag
// spans exactly that gap. `cancelled` is also the source of truth over the
// registry's own `status` field for "should this still retry?": disarm()
// itself never touches `status` (that's the caller's job, done separately,
// possibly not yet visible by the time an in-flight attempt re-reads it).
//
// `inFlight` is the ownership handoff between disarm() and fire() that lets
// the record actually get cleaned up (a real leak otherwise, over a
// campaign running unattended for weeks): fire() is the ONLY setter, true
// from entry (before any await) until it exits. disarm() may run WHILE
// fire() owns the record (inFlight) or while nothing is running at all
// (!inFlight) — only the latter is safe for disarm() to delete outright;
// the former hands cleanup off to fire() itself (its own cancelled-check
// exit paths below all delete). Every fire() exit deletes the record
// EXCEPT scheduling a retry (a new attempt is about to own it) or a
// chunk-continuation (which never sets inFlight at all — see scheduleTimer).
interface ClockState {
  timer: ReturnType<typeof setTimeout> | null;
  cancelled: boolean;
  inFlight: boolean;
}

const clockState = new Map<string, ClockState>();

function stateFor(subscriptionId: string): ClockState {
  let state = clockState.get(subscriptionId);
  if (!state) {
    state = { timer: null, cancelled: false, inFlight: false };
    clockState.set(subscriptionId, state);
  }
  return state;
}

// Node clamps a setTimeout delay above 2^31-1 ms (~24.855 days) to 1ms,
// firing almost immediately instead of waiting — a real risk here since
// `at` is agent-chosen and can easily be weeks out. MAX_TIMEOUT_MS is that
// ceiling minus a safety margin; a longer wait is broken into successive
// chunks. Each chunk recomputes its delay from the ABSOLUTE target instant
// and the ACTUAL current time (not a nominal decrement carried across
// chunks) — a chunk that fires late (event-loop congestion, GC pause, a
// slow tick) must shrink the next chunk's delay to compensate, not just
// subtract the nominal amount and let the lateness accumulate across every
// remaining chunk.
export const MAX_TIMEOUT_MS = 2 ** 31 - 1 - 1000;

/** Pure chunk-math helper, exported so the overflow behavior is unit-testable without waiting real days. */
export function nextChunkDelayMs(remainingMs: number): number {
  return Math.min(Math.max(remainingMs, 0), MAX_TIMEOUT_MS);
}

/**
 * Pure helper: the delay to schedule next, given the absolute target
 * instant and the actual current instant — exported so the
 * drift-compensation behavior is directly unit-testable (simulate a late
 * chunk by passing a `nowMs` further ahead than the nominal schedule
 * would predict, without waiting real time or mocking global Date.now).
 */
export function computeNextDelayMs(targetMs: number, nowMs: number): number {
  return nextChunkDelayMs(targetMs - nowMs);
}

function scheduleTimer(subscriptionId: string, targetMs: number): void {
  const delay = computeNextDelayMs(targetMs, Date.now());
  const timer = setTimeout(() => {
    if (targetMs - Date.now() <= 0) {
      void fire(subscriptionId);
    } else {
      scheduleTimer(subscriptionId, targetMs);
    }
  }, delay);
  stateFor(subscriptionId).timer = timer;
}

// A retry timer for when fire() couldn't complete the armed -> delivering
// transition at all (an exception, or deliverWake's own 'deferred' outcome
// with the subscription still "armed"): sweepStrandedDeliveries only ever
// scans "delivering", so a subscription stuck "armed" here has nothing else
// that will ever revisit it — see KNOWN_ISSUES.md / wake.ts's own documented
// gap for this same class of window. Unbounded (matches the sweep's own
// philosophy: keep trying until it either completes or terminalizes),
// logging once per attempt so a stuck subscription is loud, not silent.
let RETRY_DELAY_MS = 15_000;

/** Test-hygiene helper: shrinks the retry delay so tests don't wait real seconds. Not used by product code. */
export function setRetryDelayMsForTesting(ms: number): void {
  RETRY_DELAY_MS = ms;
}

async function fire(subscriptionId: string): Promise<void> {
  // The timer that invoked this call has already fired and is spent —
  // nothing left to cancel for THIS attempt — but the record itself (and
  // its `cancelled` flag) lives on across every await below, so a disarm()
  // arriving mid-flight still has something to mark. inFlight claims
  // ownership of the record's cleanup for the duration of this call — set
  // before any await, the only setter, and the sole thing that tells
  // disarm() "don't delete this out from under me, I'll clean up myself."
  const state = stateFor(subscriptionId);
  state.timer = null;
  state.inFlight = true;

  if (state.cancelled) {
    // disarm() ran before this attempt (e.g. a retry) even started, and
    // deferred cleanup to us since inFlight was about to become true —
    // finish the handoff.
    clockState.delete(subscriptionId);
    return;
  }

  try {
    const sub = await getSubscription(subscriptionId);
    // Already disarmed, delivering, or terminal by the time the timer ran:
    // nothing to do — the same race wake.ts's own expiry timer guards
    // against, and (for "delivering") sweepStrandedDeliveries now owns it.
    if (!sub || sub.status !== "armed" || state.cancelled) {
      clockState.delete(subscriptionId);
      return;
    }

    const scheduledFor = getAt(sub);
    const outcome = await deliverWake(sub, { reason: "fired", snapshot: { scheduledFor } });
    if (outcome === "completed") {
      clockState.delete(subscriptionId);
      return;
    }

    // Disarmed WHILE this attempt was in flight: the registry's own
    // `status` field is not a reliable signal here (disarm() itself never
    // touches it — that's a separate caller's job, and may not be visible
    // yet) — only this in-memory flag is. Never install a retry for a
    // subscription the agent explicitly cancelled.
    if (state.cancelled) {
      clockState.delete(subscriptionId);
      return;
    }

    const after = await getSubscription(subscriptionId);
    if (after?.status === "armed" && !state.cancelled) {
      log(
        `fire-retry-scheduled subscriptionId=${subscriptionId} outcome=${outcome} — the armed->delivering ` +
          `transition never completed, so the recovery sweep can't find this; retrying in ${RETRY_DELAY_MS}ms`,
      );
      state.inFlight = false; // a new attempt (the retry) is about to own the record instead
      scheduleRetry(subscriptionId);
    } else {
      clockState.delete(subscriptionId);
    }
  } catch (err) {
    if (state.cancelled) {
      clockState.delete(subscriptionId);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log(`fire-failed subscriptionId=${subscriptionId} error=${message} — retrying in ${RETRY_DELAY_MS}ms`);
    state.inFlight = false;
    scheduleRetry(subscriptionId);
  }
}

function scheduleRetry(subscriptionId: string): void {
  const timer = setTimeout(() => void fire(subscriptionId), RETRY_DELAY_MS);
  stateFor(subscriptionId).timer = timer;
}

async function arm(sub: Subscription): Promise<void> {
  const targetMs = new Date(getAt(sub)).getTime();
  clockState.set(sub.id, { timer: null, cancelled: false, inFlight: false }); // fresh record — a stale flag from a prior lifecycle must not leak in
  scheduleTimer(sub.id, targetMs);
}

async function disarm(sub: Subscription): Promise<void> {
  const state = clockState.get(sub.id);
  if (!state) return; // never armed, or already fully cleaned up — nothing to do
  if (state.timer) clearTimeout(state.timer);
  // Spans in-flight work too (state.timer may already be null if a fire()
  // attempt is mid-flight right now) — checked by fire() before installing
  // any retry, so a cancellation that arrives too late to find a literal
  // timer to clear still prevents that attempt from ever scheduling one.
  state.cancelled = true;
  // Only safe to delete the record ourselves when NOTHING is in flight —
  // otherwise fire() itself still needs it (to observe `cancelled` at each
  // checkpoint) and owns cleaning it up once it exits. Deleting it here
  // regardless would reintroduce the exact race this record exists to
  // close: fire() would find nothing and have no way left to learn it was
  // cancelled.
  if (!state.inFlight) {
    clockState.delete(sub.id);
  }
}

/** Test-hygiene helper: true if a timer (initial, chunked, or retry) is currently scheduled for `subscriptionId`. Not used by product code. */
export function isTimerScheduled(subscriptionId: string): boolean {
  return !!clockState.get(subscriptionId)?.timer;
}

/**
 * Test-hygiene helper: true if ANY clockState record still exists for
 * `subscriptionId`, whether or not a timer is currently pending — the
 * record-leak invariant this exists to check is "no record survives past
 * every (disarm, fire) interleaving finishing with no retry pending," not
 * just "no timer is scheduled" (isTimerScheduled alone can't see a leaked,
 * timer-less record). Not used by product code.
 */
export function hasClockStateRecord(subscriptionId: string): boolean {
  return clockState.has(subscriptionId);
}

// `at` being a real, future datetime is enforced by catalog.json's
// "futureDatetime" Ajv keyword (catalog.ts), not here — see that keyword's
// own comment for why: it must run self-contained inside Ajv, with no
// dependency on this module's registerProvider() call below having run in
// the same instance subscribe() executes in (eve's runtime evaluates
// catalog.ts more than once across its own bundling/sandboxing contexts).

export const clockProvider: Provider = {
  supportedEvents: ["time.at"],
  arm,
  disarm,
};

registerProvider("clock", clockProvider);
