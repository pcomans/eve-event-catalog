import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { createSubscription, deleteSubscription, getSubscription, tryTransitionToDelivering, updateSubscription } from "../registry.ts";
import type { Subscription } from "../types.ts";
import { addClockDue, readDueClockSubscriptionIds, removeClockDue } from "./clock-redis.ts";
import { reconcileClockDueIndex, runClockSweepTick, type DeliverClockWake, type ListArmedClockSubscriptions } from "./clock-sweep.ts";

function testConversationId(): string {
  return `test:${randomUUID()}`;
}

async function armedClockSub(conversationId: string, at: string): Promise<Subscription> {
  return armedClockSubWithParams(conversationId, { at });
}

/** Same as armedClockSub, but takes raw `params` (including `null`/`undefined` — a real Subscription's `params` is never actually optional, but a legacy/corrupt row could still have one, and the type here is deliberately widened to let a test construct exactly that) so a test can build a row a normal arm() could never produce through the catalog's own Ajv validation — reconcileClockDueIndex must still survive one, since it reads straight off the registry, not through subscribe()'s own gate. */
async function armedClockSubWithParams(conversationId: string, params: Record<string, unknown> | null | undefined): Promise<Subscription> {
  const sub = await createSubscription({
    conversationId,
    provider: "clock",
    event: "time.at",
    resource: "clock",
    // Cast past NewSubscriptionInput's own non-nullable `params` type —
    // deliberately, this helper's whole purpose is constructing a row a
    // real caller could never produce through that type.
    params: params as Record<string, unknown>,
    expiresAt: null,
  });
  return updateSubscription(sub.id, { status: "armed", armedAt: new Date().toISOString() });
}

/**
 * p6g gate (HIGH, clock-sweep.test.ts:44): readDueClockSubscriptionIds
 * reads the SHARED production catalog:clock-due sorted set — a real due
 * clock row (e.g. a live campaign wake) could legitimately be present when
 * these tests run. The production `deliver` contract (realCasDeliver below)
 * performs a REAL CAS transition with no HTTP hop; unscoped, it would fire
 * that real row without ever sending /catalog/wake. This wrapper hard-
 * rejects (throws, never CASes) any id outside the test's own declared
 * fixture set — the ONLY thing that makes it safe for a sweep tick to see
 * ids it doesn't own. runClockSweepTick's own per-row try/finally (see
 * clock-sweep.ts) already treats a throwing deliver() as a skip-and-log,
 * not an abort — so a rejected foreign id never breaks the rest of the
 * tick, and (critically) the throw happens BEFORE any registry write.
 */
function scopedCasDeliver(
  fixtureIds: ReadonlySet<string>,
  onDeliver: (sub: Subscription, snapshot: Record<string, unknown>) => void,
): DeliverClockWake {
  return async (sub, snapshot) => {
    if (!fixtureIds.has(sub.id)) {
      throw new Error(`test isolation violation: sweep attempted to deliver non-fixture subscription ${sub.id} — refusing to touch it`);
    }
    const transitioned = await tryTransitionToDelivering(sub.id, "fired", snapshot);
    if (!transitioned) return;
    await updateSubscription(sub.id, { status: "fired", firedAt: new Date().toISOString(), deliverReason: null, deliverSnapshot: null });
    onDeliver(sub, snapshot);
  };
}

/** No production rows are ever reconciled by these tests: reconciliation is exercised by its own dedicated test below with an explicit fixture-scoped listArmed. Every other test passes this no-op so runClockSweepTick's reconciliation step never performs a real listSubscriptions() scan against the shared registry. */
const noArmedRows: ListArmedClockSubscriptions = async () => [];

test("runClockSweepTick delivers exactly one 'fired' wake for a due subscription, with the scheduledFor snapshot, and drops it from the due index", async (t) => {
  const conversationId = testConversationId();
  const at = new Date(Date.now() - 1000).toISOString(); // in the past — due right now
  const sub = await armedClockSub(conversationId, at);
  t.after(() => Promise.all([deleteSubscription(sub.id), removeClockDue(sub.id)]));
  await addClockDue(sub.id, new Date(at).getTime());

  const delivered: { sub: Subscription; snapshot: Record<string, unknown> }[] = [];
  await runClockSweepTick(scopedCasDeliver(new Set([sub.id]), (s, snapshot) => delivered.push({ sub: s, snapshot })), Date.now(), noArmedRows);

  assert.equal(delivered.length, 1, "the fixture subscription must be delivered exactly once, and no foreign id must ever reach onDeliver");
  assert.deepEqual(delivered[0].snapshot, { scheduledFor: at }, "the snapshot must match clock.ts's own in-process fire() shape exactly");

  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "fired");

  const stillDue = await readDueClockSubscriptionIds(Date.now() + 1);
  assert.ok(!stillDue.includes(sub.id), "a delivered row must be dropped from the due index — it's no longer 'armed'");
});

test("runClockSweepTick never delivers a subscription whose at is still in the future", async (t) => {
  const conversationId = testConversationId();
  const at = new Date(Date.now() + 60_000).toISOString();
  const sub = await armedClockSub(conversationId, at);
  t.after(() => Promise.all([deleteSubscription(sub.id), removeClockDue(sub.id)]));
  await addClockDue(sub.id, new Date(at).getTime());

  const delivered: Subscription[] = [];
  await runClockSweepTick(scopedCasDeliver(new Set([sub.id]), (s) => delivered.push(s)), Date.now(), noArmedRows);

  assert.equal(delivered.length, 0);
  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "armed");

  const stillDue = await readDueClockSubscriptionIds(Date.now() + 61_000);
  assert.ok(stillDue.includes(sub.id), "a not-yet-due row must remain in the index for a later tick to find");
});

test("runClockSweepTick isolates a poison row: one subscription's delivery throwing does not starve the rest of the tick", async (t) => {
  const conversationId = testConversationId();
  const at = new Date(Date.now() - 1000).toISOString();
  const healthy = await armedClockSub(conversationId, at);
  t.after(() => Promise.all([deleteSubscription(healthy.id), removeClockDue(healthy.id)]));
  await addClockDue(healthy.id, new Date(at).getTime());
  const poison = await armedClockSub(conversationId, at);
  t.after(() => Promise.all([deleteSubscription(poison.id), removeClockDue(poison.id)]));
  await addClockDue(poison.id, new Date(at).getTime());

  const delivered: Subscription[] = [];
  const deliver: DeliverClockWake = async (sub) => {
    if (sub.id === poison.id) throw new Error("simulated poison-row failure");
    if (sub.id !== healthy.id) throw new Error(`test isolation violation: unexpected id ${sub.id}`);
    delivered.push(sub);
  };

  await runClockSweepTick(deliver, Date.now(), noArmedRows);

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, healthy.id, "the healthy subscription must still be delivered despite the poison row");

  // p6g LOW fix (clock-sweep.ts:93): the poison row's throw must not skip
  // the post-delivery status re-check — it's still "armed" (delivery never
  // completed), so it must be RETAINED in the due index for recovery/the
  // next tick, not silently dropped.
  const stillDue = await readDueClockSubscriptionIds(Date.now() + 1);
  assert.ok(stillDue.includes(poison.id), "a poison row that never transitioned off 'armed' must remain in the due index, not be dropped");
});

// p6g gate (LOW, clock-sweep.ts:93) — the SPECIFIC failure the finding
// describes: deliver() genuinely WINS the CAS (the row is no longer
// "armed" — it's "delivering") and then throws afterward (e.g. a
// persistent terminal-write error). The old code's re-read/removal lived
// only on the non-throwing path, so this row would have stayed in the due
// index FOREVER — every subsequent tick re-reading and re-attempting the
// same already-non-armed poison row indefinitely. The `finally` fix must
// still remove it, because it's no longer "armed" even though delivery
// itself never cleanly completed.
test("a deliver() that wins the CAS and then throws still gets its index entry removed once the row is confirmed non-armed", async (t) => {
  const conversationId = testConversationId();
  const at = new Date(Date.now() - 1000).toISOString();
  const sub = await armedClockSub(conversationId, at);
  t.after(() => Promise.all([deleteSubscription(sub.id), removeClockDue(sub.id)]));
  await addClockDue(sub.id, new Date(at).getTime());

  // p6h gate (HIGH, clock-sweep.test.ts:142): this custom deliver callback
  // used to CAS-transition WHATEVER due id runClockSweepTick handed it,
  // without checking it against this test's own fixture first — the exact
  // same real-row-mutation hazard scopedCasDeliver exists to close, just
  // reintroduced via a second, unscoped deliver implementation. The
  // hard-reject must be the FIRST statement, before any registry write.
  const deliver: DeliverClockWake = async (s, snapshot) => {
    if (s.id !== sub.id) {
      throw new Error(`test isolation violation: sweep attempted to deliver non-fixture subscription ${s.id} — refusing to touch it`);
    }
    const transitioned = await tryTransitionToDelivering(s.id, "fired", snapshot);
    assert.ok(transitioned, "test setup: this call must win the CAS for the assertion below to be meaningful");
    throw new Error("simulated persistent terminal-write failure after the CAS already won");
  };

  await runClockSweepTick(deliver, Date.now(), noArmedRows);

  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "delivering", "sanity: the row must be stuck 'delivering', not 'armed', for this to be the scenario the fix targets");

  const stillDue = await readDueClockSubscriptionIds(Date.now() + 1);
  assert.ok(!stillDue.includes(sub.id), "a row that's no longer 'armed' must be removed from the due index even though deliver() itself threw");
});

// Task #33-style batching hygiene (this module's own getSubscriptions call):
// a due id whose record was deleted between the index read and this read
// must be logged and skipped, never thrown, and must never starve a
// healthy due subscription delivered in the SAME batched read. Also proves
// the orphaned index entry itself gets cleaned up, not left behind forever.
test("runClockSweepTick skips a due id whose record no longer exists, drops it from the index, and does not starve the rest of the batch", async (t) => {
  const conversationId = testConversationId();
  const at = new Date(Date.now() - 1000).toISOString();
  const healthy = await armedClockSub(conversationId, at);
  t.after(() => Promise.all([deleteSubscription(healthy.id), removeClockDue(healthy.id)]));
  await addClockDue(healthy.id, new Date(at).getTime());

  const orphanedId = `test:${randomUUID()}`; // registered as due, but no subscription record ever exists for it
  t.after(() => removeClockDue(orphanedId));
  await addClockDue(orphanedId, new Date(at).getTime());

  const delivered: Subscription[] = [];
  await runClockSweepTick(scopedCasDeliver(new Set([healthy.id]), (s) => delivered.push(s)), Date.now(), noArmedRows);

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, healthy.id, "the healthy due subscription must still be delivered despite the orphaned neighbor");

  const stillDue = await readDueClockSubscriptionIds(Date.now() + 1);
  assert.ok(!stillDue.includes(orphanedId), "the orphaned index entry itself must be cleaned up, not left behind forever");
});

// THE REQUIRED OVERLAP TEST (mirroring expiry-sweep.test.ts's own binding
// case): two genuinely concurrent sweep ticks racing the SAME due
// subscription must produce exactly one delivery, via the real
// tryTransitionToDelivering CAS — not the sweep's own read of the due
// index (which is a diffing aid, not a delivery lock).
test("two concurrent sweep ticks racing the same due subscription deliver exactly once", async (t) => {
  const conversationId = testConversationId();
  const at = new Date(Date.now() - 1000).toISOString();
  const sub = await armedClockSub(conversationId, at);
  t.after(() => Promise.all([deleteSubscription(sub.id), removeClockDue(sub.id)]));
  await addClockDue(sub.id, new Date(at).getTime());

  const delivered: Subscription[] = [];
  const deliver = scopedCasDeliver(new Set([sub.id]), (s) => delivered.push(s));

  await Promise.all([
    runClockSweepTick(deliver, Date.now(), noArmedRows),
    runClockSweepTick(deliver, Date.now(), noArmedRows),
  ]);

  assert.equal(delivered.length, 1, "exactly one of the two concurrent ticks must win — never zero, never doubled");
  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "fired");
});

// p6g gate (two HIGH findings, one mechanism — see reconcileClockDueIndex's
// own doc comment in clock-sweep.ts): an armed clock subscription that
// exists in the registry but is MISSING from catalog:clock-due (a pre-deploy
// row, or clock.ts's arm() crashing between its status write and its own
// addClockDue() call) must be backfilled into the index — and, if already
// due, delivered — within the SAME tick that discovers it. The `listArmed`
// stub here returns ONLY this test's own fixture, never a real
// listSubscriptions() scan, so this exercises reconciliation without ever
// touching the shared registry's real rows.
test("runClockSweepTick backfills a due-index entry for an armed clock subscription missing from the index, and delivers it in the same tick if due", async (t) => {
  const conversationId = testConversationId();
  const at = new Date(Date.now() - 1000).toISOString(); // already due
  const sub = await armedClockSub(conversationId, at);
  t.after(() => Promise.all([deleteSubscription(sub.id), removeClockDue(sub.id)]));
  // Deliberately NOT calling addClockDue — simulates a pre-deploy armed row,
  // or arm()'s own crash window between the status write and addClockDue().

  const preTick = await readDueClockSubscriptionIds(Date.now() + 1);
  assert.ok(!preTick.includes(sub.id), "sanity: the fixture must start genuinely absent from the due index");

  const listArmed: ListArmedClockSubscriptions = async () => [sub];
  const delivered: Subscription[] = [];
  await runClockSweepTick(scopedCasDeliver(new Set([sub.id]), (s) => delivered.push(s)), Date.now(), listArmed);

  assert.equal(delivered.length, 1, "a reconciled-in, already-due row must be delivered in the SAME tick that backfills it");
  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "fired");
});

test("reconcileClockDueIndex: a not-yet-due armed clock subscription missing from the index is backfilled without being delivered", async (t) => {
  const conversationId = testConversationId();
  const at = new Date(Date.now() + 60_000).toISOString(); // armed, but not due yet
  const sub = await armedClockSub(conversationId, at);
  t.after(() => Promise.all([deleteSubscription(sub.id), removeClockDue(sub.id)]));

  const preTick = await readDueClockSubscriptionIds(Date.now() + 61_000);
  assert.ok(!preTick.includes(sub.id), "sanity: the fixture must start genuinely absent from the due index");

  await reconcileClockDueIndex(async () => [sub]);

  const postTick = await readDueClockSubscriptionIds(Date.now() + 61_000);
  assert.ok(postTick.includes(sub.id), "reconciliation must backfill the index entry even though the row isn't due yet");
  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "armed", "reconciliation must never itself deliver or otherwise change the row's status");
});

// p6h gate (HIGH, clock-sweep.ts:87): reconcileClockDueIndex used to call
// `new Date(getAt(sub)).getTime()` unchecked — a malformed params.at (a
// legacy row, a corrupt write, anything not a parseable datetime) makes
// this NaN, @upstash/redis serializes a NaN ZADD score as JSON `null`,
// Redis rejects it, and because reconciliation is awaited BEFORE the
// due-read in runClockSweepTick, an UNCAUGHT throw here would have aborted
// the ENTIRE tick — one malformed row starving every OTHER valid due clock
// wake behind it forever, every ~30s. The fix validates the computed score
// per row and skip-and-logs a malformed one rather than throwing, so a
// poison row can never take the whole tick down with it.
// p6i gate (2 HIGHs, same guard, two edges): the p6h fix's own
// `Number.isFinite(new Date(getAt(sub)).getTime())` check has two holes —
// (1) getAt's unchecked `(sub.params as { at: string }).at` cast throws a
// TypeError before isFinite ever runs when `params` is missing `at`
// entirely (or params itself is absent), aborting the whole tick just like
// the p6h finding; (2) `at: null` sails PAST isFinite because
// `new Date(null).getTime()` is epoch-0 — a finite number — so a corrupt
// row gets silently indexed as already due and DELIVERED instead of
// skipped. Both edges alongside the original garbage-string case in one
// test: three malformed fixtures (params missing `at` entirely, `at:
// null`, `at` a garbage string), one healthy+due fixture — all three
// malformed rows must be skipped/untouched and the healthy row must still
// reconcile and deliver.
test("reconcileClockDueIndex skips every malformed params.at shape without throwing or misindexing, and still reconciles + delivers the healthy row in the same tick", async (t) => {
  const conversationId = testConversationId();
  const at = new Date(Date.now() - 1000).toISOString(); // due right now
  const healthy = await armedClockSub(conversationId, at);
  t.after(() => Promise.all([deleteSubscription(healthy.id), removeClockDue(healthy.id)]));
  // Deliberately NOT calling addClockDue for any fixture — all start
  // absent from the index, so this also proves reconciliation itself
  // (not just the delivery loop after it) survives every malformed neighbor.

  const missingParams = await armedClockSubWithParams(conversationId, null); // params itself missing entirely (legacy/corrupt row) — getAt's own unchecked cast would dereference `.at` on this and throw a TypeError before any Date coercion at all
  t.after(() => Promise.all([deleteSubscription(missingParams.id), removeClockDue(missingParams.id)]));

  const nullAt = await armedClockSubWithParams(conversationId, { at: null }); // `new Date(null).getTime()` is epoch-0 — finite, but not a real due time
  t.after(() => Promise.all([deleteSubscription(nullAt.id), removeClockDue(nullAt.id)]));

  const garbageStringAt = await armedClockSub(conversationId, "not-a-real-datetime");
  t.after(() => Promise.all([deleteSubscription(garbageStringAt.id), removeClockDue(garbageStringAt.id)]));

  const malformedIds = [missingParams.id, nullAt.id, garbageStringAt.id];
  const preTick = await readDueClockSubscriptionIds(Date.now() + 1);
  assert.ok(
    !preTick.includes(healthy.id) && malformedIds.every((id) => !preTick.includes(id)),
    "sanity: every fixture must start genuinely absent from the due index",
  );

  const listArmed: ListArmedClockSubscriptions = async () => [healthy, missingParams, nullAt, garbageStringAt];
  const delivered: Subscription[] = [];
  await assert.doesNotReject(
    () => runClockSweepTick(scopedCasDeliver(new Set([healthy.id]), (s) => delivered.push(s)), Date.now(), listArmed),
    "no malformed params.at shape may ever abort the whole tick",
  );

  assert.equal(delivered.length, 1, "the healthy row must still be reconciled AND delivered despite three malformed neighbors");
  const healthyStored = await getSubscription(healthy.id);
  assert.equal(healthyStored?.status, "fired");

  for (const id of malformedIds) {
    const stored = await getSubscription(id);
    assert.equal(stored?.status, "armed", `malformed row ${id} must be left untouched — skipped, not delivered or errored-out`);
  }
  const stillDue = await readDueClockSubscriptionIds(Date.now() + 1);
  assert.ok(
    malformedIds.every((id) => !stillDue.includes(id)),
    "no malformed row may ever be added to the due index — there's no valid score to index any of them under",
  );
});

// p6j gate (HIGH, the bypass path): reconciliation's own guard only stops
// IT from indexing a malformed row — it does not remove a malformed row
// that's ALREADY present in catalog:clock-due through some other path (a
// stale member left behind from before these guards existed, or direct
// index corruption). This test constructs exactly that bypass: a malformed
// armed row is seeded DIRECTLY into the due index via addClockDue, never
// through reconcileClockDueIndex (which is handed a listArmed stub that
// deliberately excludes it, so this cannot be passing "by accident" via
// reconciliation's own guard). The delivery loop must still catch it: never
// call deliver() for it, never change its status off "armed", and remove
// the stale index entry so it isn't relogged and retried every tick forever
// — while the healthy row in the SAME tick still delivers normally.
test("runClockSweepTick: a malformed row already present in the due index (bypassing reconciliation) is skipped, de-indexed, and left armed — never delivered", async (t) => {
  const conversationId = testConversationId();
  const healthy = await armedClockSub(conversationId, new Date(Date.now() - 1000).toISOString());
  t.after(() => Promise.all([deleteSubscription(healthy.id), removeClockDue(healthy.id)]));
  await addClockDue(healthy.id, Date.now() - 1000);

  const malformed = await armedClockSubWithParams(conversationId, { at: null });
  t.after(() => Promise.all([deleteSubscription(malformed.id), removeClockDue(malformed.id)]));
  // The bypass itself: seeded straight into the due index, never through
  // reconcileClockDueIndex.
  await addClockDue(malformed.id, Date.now() - 1000);

  // Deliberately excludes `malformed` — proves the fix below isn't secretly
  // relying on reconciliation catching it.
  const listArmed: ListArmedClockSubscriptions = async () => [healthy];

  const delivered: Subscription[] = [];
  await runClockSweepTick(scopedCasDeliver(new Set([healthy.id]), (s) => delivered.push(s)), Date.now(), listArmed);

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, healthy.id, "the healthy row must still deliver in the same tick despite the bypassed malformed neighbor");

  const malformedStored = await getSubscription(malformed.id);
  assert.equal(malformedStored?.status, "armed", "a malformed row that bypassed reconciliation must still never be delivered — left armed, not delivering/fired");

  const stillDue = await readDueClockSubscriptionIds(Date.now() + 1);
  assert.ok(
    !stillDue.includes(malformed.id),
    "the stale due-index entry for a malformed row must be removed by the delivery loop itself, not relogged and retried every tick forever",
  );
});
