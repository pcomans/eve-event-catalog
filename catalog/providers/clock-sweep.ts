import { getSubscription, getSubscriptions, listSubscriptions } from "../registry.ts";
import type { Subscription } from "../types.ts";
import { addClockDue, readDueClockSubscriptionIds, removeClockDue } from "./clock-redis.ts";

// Launch blocker fix (production finding, 2026-07-14): the durable side of
// clock.time.at wakes. catalog/providers/clock.ts's own in-process
// setTimeout is an in-process stand-in that dies with whatever ephemeral
// function armed it — fine for local dev (a long-lived dev server), fatal
// on Vercel (an armed wake could sit forever, the exact AGENTS.md rule 4
// violation this module exists to close). Same shape as
// catalog/providers/expiry-sweep.ts (its own template): read every due id
// from the durable index (clock-redis.ts's readDueClockSubscriptionIds),
// batch-read the rows, attempt a "fired" delivery for each.
//
// KNOWN ACCEPTED LIMIT: connector-mode delivery is only as fresh as the
// sweep's own cadence (30s, connector/workflows/clock-sweep.ts) — a wake
// can land up to ~30s late relative to its own `at`, versus setTimeout's
// sub-second precision locally. Fine for this catalog's semantics (a
// clock.time.at wake is "wake me around this time," not a hard real-time
// deadline) — not engineered tighter (AGENTS.md rule 1).
//
// Safe under a LOCAL timer and this DURABLE sweep racing the SAME
// subscription for the exact same reason every other sweep in this
// codebase is safe under overlap: `deliver` (deliverWakeFromConnector in
// production) transitions through registry.ts's tryTransitionToDelivering,
// an atomic CAS — only one of the two ever wins the armed->delivering
// transition, and the loser's call is a verified no-op (see
// connector/lib/deliver-wake.ts's own doc comment).

function log(line: string): void {
  console.log(`[clock-sweep] ${line}`);
}

function getAt(sub: Subscription): string {
  return (sub.params as { at: string }).at;
}

/**
 * The ONE validated read of a clock subscription's own due time — shared by
 * BOTH loops below (reconciliation AND delivery). p6j gate finding: before
 * this, reconciliation validated its own read but the delivery loop trusted
 * `getAt(sub)` unchecked; a malformed row already present in catalog:clock-due
 * (a stale member reconciliation itself skip-logs without removing, an
 * upgrade-state row from before the p6h/p6i guards existed, or direct index
 * corruption) bypassed reconciliation's guard entirely and reached
 * `deliver()` unvalidated. One validator, used by both loops, closes that
 * asymmetry structurally rather than needing the two call sites to be kept
 * in sync by hand.
 *
 * Safe against `params` itself missing/null (optional chaining), requires
 * `at` be a STRING before any Date coercion at all (a non-string — null,
 * number, object, array, missing — never reaches `new Date()`), and
 * requires the parsed result be finite. Returns `null` on ANY failure —
 * never throws, so neither caller needs its own try/catch around this call.
 *
 * DECLARED ACCEPTED LIMIT (p6j gate, finding 2 — explicitly NOT a bug,
 * confirmed by team-lead, not to be "fixed" by a future gate round): this
 * does not re-enforce catalog/catalog.json's own `futureDatetime` Ajv
 * keyword (catalog.ts) — it accepts anything the host `Date` parser accepts
 * as finite, which is a strict superset of the ISO-8601-with-an-explicit-
 * offset shape `time.at`'s schema actually requires (e.g. the bare string
 * `"0"`, or a date-only string, parses to a finite past instant that would
 * have been REJECTED at subscribe time). The schema authority is
 * catalog.ts's Ajv validation at subscribe() time — `futureDatetime`, not
 * this function — and every legitimate write path through clock.ts's arm()
 * only ever writes a row that already passed it. A host-parser-lenient
 * string can reach this function only via corruption beyond every validated
 * write path (an out-of-band Redis write, a future caller bypassing
 * subscribe()). If it does, the blast radius is bounded and survivable: at
 * most one wake fires at a host-parser-derived (possibly wrong) instant,
 * through the same idempotent CAS delivery every other clock wake already
 * uses — not a crash, not a retry loop, not silent data loss. Duplicating
 * the ISO-with-offset shape here would mean two schemas that can drift,
 * which is a worse failure mode than the bounded-wrong-wake this leaves on
 * the table.
 */
function clockDueMsOf(sub: Subscription): number | null {
  const at = (sub.params as { at?: unknown } | null | undefined)?.at;
  if (typeof at !== "string") return null;
  const scoreMs = new Date(at).getTime();
  return Number.isFinite(scoreMs) ? scoreMs : null;
}

/** Delivers one "fired" wake for one time.at subscription, with the SAME snapshot shape clock.ts's own in-process fire() builds (`{ scheduledFor: <at> }`) — connector/lib/deliver-wake.ts's deliverWakeFromConnector in production. */
export type DeliverClockWake = (sub: Subscription, snapshot: Record<string, unknown>) => Promise<void>;

/** Every subscription currently armed for clock's own `time.at` event — the reconciliation read side (below). Filters registry.ts's own listSubscriptions() (one SMEMBERS + one batched MGET across the WHOLE registry) rather than a provider-scoped index, because no such index exists yet — unlike EDGAR's own resource-scoped state, clock has nothing narrower to query. Injected (see ListArmedClockSubscriptions) so tests never have to pay for, or risk touching real rows via, a real full-registry scan. */
export type ListArmedClockSubscriptions = () => Promise<Subscription[]>;

async function listArmedClockSubscriptionsFromRegistry(): Promise<Subscription[]> {
  const all = await listSubscriptions();
  return all.filter((sub) => sub.provider === "clock" && sub.event === "time.at" && sub.status === "armed");
}

/**
 * p6g gate (two HIGH findings, one mechanism): reconciles the durable due
 * index (catalog:clock-due) against the registry's own ground truth —
 * every subscription CURRENTLY armed for clock's event gets an idempotent
 * ZADD (score = its own params.at, in ms). A no-op for a row already
 * correctly indexed; a self-heal for one that isn't.
 *
 * Closes BOTH findings with this one mechanism:
 *   - clock-sweep.ts (this module): the new connector-mode due index has no
 *     backfill for clock subscriptions that were already `status: "armed"`
 *     from BEFORE this deploy (clock.ts didn't write catalog:clock-due
 *     until today) — those rows are invisible to readDueClockSubscriptionIds
 *     and would never fire. Reconciling on every tick means the very first
 *     post-deploy tick backfills them; no separate one-off migration script.
 *   - clock.ts's arm(): a crash between the registry's own status="armed"
 *     write (armPendingForConversation) and the connector-mode addClockDue()
 *     call leaves a row armed-but-unindexed forever, with nothing else that
 *     will ever revisit it (duplicate turn.completed recovery only re-arms
 *     rows still "pending", and this one is already past that). Reconciling
 *     on every tick re-derives the index from the registry regardless of
 *     whether THIS row's own addClockDue() call ever completed, so the very
 *     next tick after the crash finds and re-adds it.
 *
 * Design choice (per-tick, not chain-start-only): cost is one extra
 * listSubscriptions() call — one SMEMBERS + one batched MGET, same shape as
 * the N+1 fix task #33 already did for the listing/expiry-sweep paths, not
 * a per-subscription GET loop — every ~30s. Chosen over a chain-start-only
 * backfill because it keeps self-healing for the FULL lifetime of a running
 * clock sweep chain (weeks, per the workflow's own supervisor model), not
 * just the moment right after a fresh deploy; a crash-window row that slips
 * through mid-chain still gets picked up within one tick instead of surviving
 * until the next restart.
 */
export async function reconcileClockDueIndex(
  listArmed: ListArmedClockSubscriptions = listArmedClockSubscriptionsFromRegistry,
): Promise<void> {
  const armed = await listArmed();
  for (const sub of armed) {
    // p6h/p6i/p6j gate: a malformed armed row (a legacy row, corrupt
    // write, anything that isn't a well-formed `{ at: "<parseable ISO
    // string>" }`) must never reach Date coercion in a way that either
    // throws or silently coerces to a valid-looking score — see
    // clockDueMsOf's own doc comment for the full history and the
    // declared accepted limit. Because reconciliation runs BEFORE the
    // due-read (awaited first in runClockSweepTick), letting either
    // failure mode escape would abort/corrupt the WHOLE tick — starving
    // every other valid due clock wake behind it, exactly the
    // global-poison-pill class this module's own per-row isolation
    // elsewhere (the due-row delivery loop below) already guards against.
    // Skip-and-log; keep reconciling the rest, same "one poison row never
    // starves the batch" philosophy as everywhere else in this module.
    const scoreMs = clockDueMsOf(sub);
    if (scoreMs === null) {
      log(`clock-reconcile-row-skipped sub=${sub.id} — params.at is missing, not a string, or not a valid datetime (params=${JSON.stringify(sub.params)}), refusing to index it`);
      continue;
    }
    await addClockDue(sub.id, scoreMs);
  }
}

/**
 * One full sweep tick: first reconciles the due index against reality
 * (reconcileClockDueIndex above), then reads every subscription id
 * currently due (`at` <= now) and attempts a "fired" delivery for each. One
 * poison row (a subscription deleted between the index read and this read,
 * or any other unexpected error) is logged and skipped, not a reason to
 * abort the rest of the tick — same philosophy as expiry-sweep.ts's own
 * runExpirySweepTick.
 *
 * Removing a row from the due index is NOT simply "deliver() didn't throw"
 * — deliver() returning cleanly doesn't by itself mean THIS call won the
 * delivery (a concurrent sweep tick, or the in-process timer during a
 * mixed-mode window, may have won instead), and `deliverTerminalWakeFromConnector`
 * has one narrow defensive branch where a CAS miss re-reads a status that's
 * neither terminal nor "delivering" (unexpected, but not impossible under
 * genuine concurrent writers). Re-reading the row's OWN current status
 * after the delivery attempt and only removing it once it's no longer
 * "armed" is what keeps a row that's still legitimately due from being
 * silently dropped from the sweep forever — the exact failure class this
 * whole module exists to close. One extra GET per DUE row per tick, not
 * per total-registry row — due rows are rare, this isn't the N+1 shape
 * task #33 addressed.
 *
 * p6g gate (LOW, clock-sweep.ts:93): that post-delivery re-read/removal now
 * runs in a `finally` block, not just on deliver()'s happy path — a
 * deliver() that transitions the row to "delivering" and THEN throws (a
 * persistent marker-read/terminal-write error, say) used to skip the
 * re-read/removal entirely, leaving a now-non-armed row permanently stuck
 * in the due index: every subsequent tick would re-read and re-attempt it
 * forever (unbounded Redis/log burn on one poison row), even though
 * recovery.ts's own stranded-delivery sweep already owns completing it. The
 * re-read only ever REMOVES (never re-adds) — a row that's still genuinely
 * armed, or whose status can't be confirmed (the re-read itself throws),
 * is deliberately left in the index rather than risk dropping one still
 * legitimately due.
 */
export async function runClockSweepTick(
  deliver: DeliverClockWake,
  nowMs: number = Date.now(),
  listArmed: ListArmedClockSubscriptions = listArmedClockSubscriptionsFromRegistry,
): Promise<void> {
  await reconcileClockDueIndex(listArmed);

  const dueIds = await readDueClockSubscriptionIds(nowMs);
  if (dueIds.length === 0) return;

  log(`sweep due=${dueIds.length}`);

  let subs: (Subscription | null)[];
  try {
    subs = await getSubscriptions(dueIds);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`clock-sweep-batch-read-failed count=${dueIds.length} error=${message}`);
    return;
  }

  for (let i = 0; i < dueIds.length; i++) {
    const id = dueIds[i];
    const sub = subs[i];
    if (!sub) {
      log(`clock-sweep-row-skipped sub=${id} — no longer exists`);
      // p6k gate (MED): this removeClockDue must never itself abort the
      // tick — a ZREM failure here is no different in kind from the
      // finally block's own re-read/removal below, which already treats a
      // cleanup error as "leave it for a later retry," not a reason to
      // reject the whole runClockSweepTick call and starve every other due
      // row behind this one.
      try {
        await removeClockDue(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`clock-sweep-row-skip-cleanup-failed sub=${id} error=${message} — leaving the due-index entry for a later retry`);
      }
      continue;
    }

    // p6j gate (HIGH): a malformed row can reach THIS loop even though
    // reconciliation above validates its own writes — a stale due-index
    // member reconciliation only ever skip-logs (never removes on its
    // own), an upgrade-state row from before the p6h/p6i guards existed,
    // or direct index corruption all bypass reconciliation entirely.
    // Validating again here, with the SAME clockDueMsOf validator
    // reconciliation uses, closes that asymmetry: an invalid row is never
    // delivered, is left "armed" (no status change — this is a corrupt
    // due-index entry, not a decision about the subscription itself), and
    // is removed from the index so it isn't silently re-logged and
    // re-attempted every ~30s tick forever.
    if (clockDueMsOf(sub) === null) {
      log(`clock-sweep-row-invalid sub=${id} — params.at is missing, not a string, or not a valid datetime (params=${JSON.stringify(sub.params)}); leaving it armed and removing the stale due-index entry rather than delivering a corrupt wake`);
      // p6k gate (MED): same isolation fix as the missing-row branch above
      // — a ZREM failure here must not abort the tick either. The row was
      // already correctly identified as corrupt and deliberately left
      // armed; a cleanup-command error turning THAT into a whole-tick
      // failure would be strictly worse than just leaving the stale member
      // for the next tick to retry.
      try {
        await removeClockDue(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`clock-sweep-row-invalid-cleanup-failed sub=${id} error=${message} — leaving the due-index entry for a later retry`);
      }
      continue;
    }

    try {
      await deliver(sub, { scheduledFor: getAt(sub) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`clock-sweep-row-failed sub=${id} error=${message}`);
    } finally {
      try {
        const after = await getSubscription(id);
        if (!after || after.status !== "armed") {
          await removeClockDue(id);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`clock-sweep-status-recheck-failed sub=${id} error=${message} — leaving the due index entry in place rather than risk dropping a row that may still be legitimately due`);
      }
    }
  }
}
