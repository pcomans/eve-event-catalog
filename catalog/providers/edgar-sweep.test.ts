import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Redis } from "@upstash/redis";

import { createSubscription, deleteSubscription, getSubscription, tryTransitionToDelivering, updateSubscription } from "../registry.ts";
import type { Subscription } from "../types.ts";
import { runEdgarSweepTick, type DeliverEdgarWake, type ResolveCik } from "./edgar-sweep.ts";
import type { FetchFilings, FilingRecord } from "./edgar-client.ts";

// Real Redis (no mocking) for everything correctness actually lives in —
// the seen-set (edgar-redis.ts) and the registry's CAS
// (tryTransitionToDelivering) — same "test:"-namespaced, t.after()-cleaned
// convention as every other provider test in this project. Only the true
// external boundaries (the SEC fetch and ticker->CIK resolution) are faked.
const redis = Redis.fromEnv();

function testConversationId(): string {
  return `test:${randomUUID()}`;
}

function testTicker(): string {
  return `TEST${randomUUID().slice(0, 6).toUpperCase()}`;
}

function testCik(): string {
  return `test-${randomUUID()}`;
}

function filing(accessionNumber: string, acceptanceDateTime: string, form = "8-K"): FilingRecord {
  return { accessionNumber, filingDate: acceptanceDateTime.slice(0, 10), form, primaryDocument: "doc.htm", acceptanceDateTime };
}

async function armedFilingSub(conversationId: string, ticker: string, armedAt: string, formTypes?: string[]): Promise<Subscription> {
  const sub = await createSubscription({
    conversationId,
    provider: "edgar",
    event: "filing.new",
    resource: ticker,
    params: formTypes ? { formTypes } : {},
    expiresAt: null,
  });
  return updateSubscription(sub.id, { status: "armed", armedAt });
}

/** A resolveCik fake fixing one ticker to one CIK — no real SEC ticker-lookup call. */
function fixedResolveCik(mapping: Record<string, string>): ResolveCik {
  return async (ticker) => {
    const cik = mapping[ticker];
    if (!cik) throw new Error(`no fixed CIK for ticker ${ticker}`);
    return cik;
  };
}

/** A fetchFilings fake returning a fixed filings list for one CIK, and recording how many times it was called. */
function fixedFetchFilings(cik: string, company: string, filings: FilingRecord[]): { fetch: FetchFilings; callCount: () => number } {
  let calls = 0;
  const fetch: FetchFilings = async (requestedCik) => {
    assert.equal(requestedCik, cik, "fetchFilings must only ever be called for the CIK it was set up for");
    calls++;
    return { company, filings };
  };
  return { fetch, callCount: () => calls };
}

/**
 * The production `deliver` contract (deliverWakeFromConnector) without the
 * HTTP hop: transitions through the SAME real, atomic
 * tryTransitionToDelivering CAS registry.ts's own delivery pipeline uses,
 * then (on winning) marks the subscription terminal — exactly the two
 * things that matter for proving delivery-dedupe safety, without needing a
 * running eve server to POST to. `onDeliver` records every call that
 * actually WON the CAS (not every call attempted).
 */
function realCasDeliver(onDeliver: (sub: Subscription) => void): DeliverEdgarWake {
  return async (sub, snapshot) => {
    const transitioned = await tryTransitionToDelivering(sub.id, "fired", snapshot);
    if (!transitioned) return; // lost the CAS — exactly what a losing concurrent caller must do: nothing further
    await updateSubscription(sub.id, { status: "fired", firedAt: new Date().toISOString(), deliverReason: null, deliverSnapshot: null });
    onDeliver(sub);
  };
}

test("runEdgarSweepTick: a never-before-seen CIK seeds from the earliest subscriber's armedAt and does not fire on a filing accepted before it", async (t) => {
  const conversationId = testConversationId();
  const ticker = testTicker();
  const cik = testCik();
  t.after(() => redis.del(`catalog:edgar-seen:${cik}`));

  const sub = await armedFilingSub(conversationId, ticker, "2026-07-13T12:00:00.000Z");
  t.after(() => deleteSubscription(sub.id));

  // Accepted BEFORE armedAt — must be seeded into the baseline, never fired.
  const { fetch } = fixedFetchFilings(cik, "Test Co", [filing("acc-old", "2026-07-13T09:00:00.000Z")]);
  const delivered: Subscription[] = [];

  await runEdgarSweepTick({
    fetchFilings: fetch,
    resolveCik: fixedResolveCik({ [ticker]: cik }),
    deliver: realCasDeliver((s) => delivered.push(s)),
  });

  assert.equal(delivered.length, 0, "a filing accepted before armedAt must not fire on the very first sweep");
});

test("runEdgarSweepTick: fires immediately (same tick) on a filing accepted after armedAt, even for a brand-new CIK", async (t) => {
  const conversationId = testConversationId();
  const ticker = testTicker();
  const cik = testCik();
  t.after(() => redis.del(`catalog:edgar-seen:${cik}`));

  const sub = await armedFilingSub(conversationId, ticker, "2026-07-13T12:00:00.000Z");
  t.after(() => deleteSubscription(sub.id));

  const { fetch } = fixedFetchFilings(cik, "Test Co", [
    filing("acc-old", "2026-07-13T09:00:00.000Z"), // before armedAt: baseline, must not fire
    filing("acc-new", "2026-07-13T13:00:00.000Z"), // after armedAt: must fire, on THIS tick
  ]);
  const delivered: Subscription[] = [];

  await runEdgarSweepTick({
    fetchFilings: fetch,
    resolveCik: fixedResolveCik({ [ticker]: cik }),
    deliver: realCasDeliver((s) => delivered.push(s)),
  });

  assert.equal(delivered.length, 1, "the post-armedAt filing must fire without waiting for a second sweep tick");
  assert.equal(delivered[0].id, sub.id);

  const updated = await getSubscription(sub.id);
  assert.equal(updated?.status, "fired");
});

test("runEdgarSweepTick: two subscriptions on the same ticker (same CIK) coalesce into exactly one fetchFilings call", async (t) => {
  const conversationId = testConversationId();
  const ticker = testTicker();
  const cik = testCik();
  t.after(() => redis.del(`catalog:edgar-seen:${cik}`));

  const subA = await armedFilingSub(conversationId, ticker, "2026-07-13T08:00:00.000Z");
  t.after(() => deleteSubscription(subA.id));
  const subB = await armedFilingSub(conversationId, ticker, "2026-07-13T08:00:00.000Z");
  t.after(() => deleteSubscription(subB.id));

  const { fetch, callCount } = fixedFetchFilings(cik, "Test Co", [filing("acc-1", "2026-07-13T09:00:00.000Z")]);
  const delivered: Subscription[] = [];

  await runEdgarSweepTick({
    fetchFilings: fetch,
    resolveCik: fixedResolveCik({ [ticker]: cik }),
    deliver: realCasDeliver((s) => delivered.push(s)),
  });

  assert.equal(callCount(), 1, "one CIK, two subscribers — must coalesce into a single SEC fetch (AGENTS.md rule 3)");
  assert.equal(delivered.length, 2, "both subscribers watching the same CIK must each get their own wake");
});

test("runEdgarSweepTick: a subscription's formTypes filter excludes non-matching forms, independent of a sibling subscription on the same CIK", async (t) => {
  const conversationId = testConversationId();
  const ticker = testTicker();
  const cik = testCik();
  t.after(() => redis.del(`catalog:edgar-seen:${cik}`));

  const wants8K = await armedFilingSub(conversationId, ticker, "2026-07-13T08:00:00.000Z", ["8-K"]);
  t.after(() => deleteSubscription(wants8K.id));
  const wantsAny = await armedFilingSub(conversationId, ticker, "2026-07-13T08:00:00.000Z");
  t.after(() => deleteSubscription(wantsAny.id));

  const { fetch } = fixedFetchFilings(cik, "Test Co", [filing("acc-1", "2026-07-13T09:00:00.000Z", "10-Q")]);
  const delivered: Subscription[] = [];

  await runEdgarSweepTick({
    fetchFilings: fetch,
    resolveCik: fixedResolveCik({ [ticker]: cik }),
    deliver: realCasDeliver((s) => delivered.push(s)),
  });

  assert.equal(delivered.length, 1, "only the subscriber with no form filter (or a matching one) should fire on a 10-Q");
  assert.equal(delivered[0].id, wantsAny.id);
});

// p3 GATE FINDING 3 (Codex, 2026-07-13): a subscription armed AFTER a
// filing was already accepted by SEC must never be woken for it — the
// filing is pre-subscription information as far as that subscriber is
// concerned, even though it's legitimately "fresh" relative to an
// earlier-armed sibling on the same CIK (whose armedAt drove the seed
// baseline). This is the exact "idle gap" scenario Codex's finding
// describes: the seed cutoff is the CIK group's EARLIEST armedAt, not
// each subscriber's own, so without a per-subscriber filter every sibling
// gets credited with filings that predate its own subscription.
test("runEdgarSweepTick: a subscriber armed AFTER a filing's acceptance is never woken for that pre-subscription filing", async (t) => {
  const conversationId = testConversationId();
  const ticker = testTicker();
  const cik = testCik();
  t.after(() => redis.del(`catalog:edgar-seen:${cik}`));

  // subEarly's armedAt predates the filing; subLate's armedAt is AFTER the
  // filing's own acceptance, but still before this sweep runs. Because
  // subEarly is on the same CIK, the seed cutoff (earliestArmedAt) is
  // subEarly's armedAt — so the filing is "fresh" (correctly, for
  // subEarly) but must NOT fire for subLate.
  const subEarly = await armedFilingSub(conversationId, ticker, "2026-07-13T08:00:00.000Z");
  t.after(() => deleteSubscription(subEarly.id));
  const subLate = await armedFilingSub(conversationId, ticker, "2026-07-13T10:00:00.000Z");
  t.after(() => deleteSubscription(subLate.id));

  const { fetch } = fixedFetchFilings(cik, "Test Co", [filing("acc-between", "2026-07-13T09:00:00.000Z")]);
  const delivered: Subscription[] = [];

  await runEdgarSweepTick({
    fetchFilings: fetch,
    resolveCik: fixedResolveCik({ [ticker]: cik }),
    deliver: realCasDeliver((s) => delivered.push(s)),
  });

  assert.equal(delivered.length, 1, "only the subscriber armed BEFORE the filing's acceptance should ever fire for it");
  assert.equal(delivered[0].id, subEarly.id);
});

// p3 GATE FINDING 2 (Codex, 2026-07-13, "the round's real bug"): the seen-set
// must only be advanced AFTER delivery has been attempted for every fresh
// filing this tick, never before. The original ordering (ZADD before the
// delivery loop) meant a delivery failure — a transient Redis/CAS error, or
// a genuine process crash mid-tick — left the filing marked seen forever
// while the affected subscription stayed armed: the filing was lost with no
// way to ever recover it, since the NEXT tick's own diff would never see it
// as fresh again.
test("runEdgarSweepTick: a delivery failure does not lose the filing — the seen-set is only advanced after delivery is attempted", async (t) => {
  const conversationId = testConversationId();
  const ticker = testTicker();
  const cik = testCik();
  t.after(() => redis.del(`catalog:edgar-seen:${cik}`));

  const sub = await armedFilingSub(conversationId, ticker, "2026-07-13T08:00:00.000Z");
  t.after(() => deleteSubscription(sub.id));

  const { fetch } = fixedFetchFilings(cik, "Test Co", [filing("acc-crash", "2026-07-13T09:00:00.000Z")]);
  const resolveCik = fixedResolveCik({ [ticker]: cik });

  // Tick 1: the delivery attempt itself fails outright (simulating a
  // transient error, or a crash mid-delivery). runEdgarSweepTick's own
  // per-CIK try/catch logs and swallows this so the tick "completes," but
  // the filing must NOT have been marked seen by this failed attempt.
  await runEdgarSweepTick({
    fetchFilings: fetch,
    resolveCik,
    deliver: async () => {
      throw new Error("simulated delivery failure");
    },
  });

  const stillArmed = await getSubscription(sub.id);
  assert.equal(stillArmed?.status, "armed", "sanity check: the failed delivery attempt must not have transitioned the subscription");

  // Tick 2: the SAME filing must still be treated as fresh — proving tick
  // 1's failure never advanced the seen-set — so a working deliver now
  // succeeds and the subscription is not permanently missed.
  const delivered: Subscription[] = [];
  await runEdgarSweepTick({
    fetchFilings: fetch,
    resolveCik,
    deliver: realCasDeliver((s) => delivered.push(s)),
  });

  assert.equal(delivered.length, 1, "the filing must be redelivered on the next tick — a prior failed attempt must never mark it seen");
  const nowFired = await getSubscription(sub.id);
  assert.equal(nowFired?.status, "fired");
});

// Complementary to the test above: a crash AFTER a delivery has already
// WON its CAS (the durable decision is recorded) but BEFORE the seen-set
// write — Codex's literal scenario. The filing is reprocessed on the next
// tick (seen-set was never advanced), but the real delivery count must
// stay at exactly one: tryTransitionToDelivering's CAS makes the
// reprocessing attempt a verified no-op, not a second wake.
test("runEdgarSweepTick: a crash between a successful delivery and marking the filing seen redelivers the tick, but the CAS keeps the real delivery count at exactly one", async (t) => {
  const conversationId = testConversationId();
  const ticker = testTicker();
  const cik = testCik();
  t.after(() => redis.del(`catalog:edgar-seen:${cik}`));

  const sub = await armedFilingSub(conversationId, ticker, "2026-07-13T08:00:00.000Z");
  t.after(() => deleteSubscription(sub.id));

  const { fetch } = fixedFetchFilings(cik, "Test Co", [filing("acc-crash-after-success", "2026-07-13T09:00:00.000Z")]);
  const resolveCik = fixedResolveCik({ [ticker]: cik });
  const delivered: Subscription[] = [];

  const crashAfterDeliver: DeliverEdgarWake = async (s, snapshot) => {
    await realCasDeliver((won) => delivered.push(won))(s, snapshot);
    throw new Error("simulated crash right after the real delivery succeeded, before the seen-set write");
  };

  await runEdgarSweepTick({ fetchFilings: fetch, resolveCik, deliver: crashAfterDeliver });

  assert.equal(delivered.length, 1, "the real delivery must have gone through despite the simulated crash immediately after it");
  const afterCrash = await getSubscription(sub.id);
  assert.equal(afterCrash?.status, "fired", "the subscription must already be terminal, even though the tick itself 'crashed' afterward");

  await runEdgarSweepTick({ fetchFilings: fetch, resolveCik, deliver: realCasDeliver((s) => delivered.push(s)) });

  assert.equal(delivered.length, 1, "the next tick's reprocessing of the same not-yet-seen filing must be a verified no-op, not a second delivery");
});

// THE BINDING TEST (HANDOFF-PHASE3.md, the team-lead sign-off condition on
// edgar-redis.ts's seen-set): two overlapping sweep ticks racing the SAME
// newly-discovered CIK must still produce exactly one wake per
// subscription. Both ticks read the seen-set concurrently (both see it
// empty), both compute the same "fresh" filing, and both call `deliver` —
// proving the real tryTransitionToDelivering CAS (not the seen-set) is what
// makes this safe, exactly as edgar-sweep.ts's sweepOneCik doc comment
// requires.
test("two concurrent sweep ticks for the same newly-discovered CIK produce exactly ONE wake per subscription", async (t) => {
  const conversationId = testConversationId();
  const tickerA = testTicker();
  const tickerB = testTicker();
  const cik = testCik();
  t.after(() => redis.del(`catalog:edgar-seen:${cik}`));

  const subA = await armedFilingSub(conversationId, tickerA, "2026-07-13T08:00:00.000Z");
  t.after(() => deleteSubscription(subA.id));
  const subB = await armedFilingSub(conversationId, tickerB, "2026-07-13T08:00:00.000Z");
  t.after(() => deleteSubscription(subB.id));

  const { fetch } = fixedFetchFilings(cik, "Test Co", [filing("acc-race", "2026-07-13T09:00:00.000Z")]);
  const resolveCik = fixedResolveCik({ [tickerA]: cik, [tickerB]: cik });
  const delivered: Subscription[] = [];
  const deliver = realCasDeliver((s) => delivered.push(s));

  // Genuinely concurrent: both ticks start before either finishes.
  await Promise.all([
    runEdgarSweepTick({ fetchFilings: fetch, resolveCik, deliver }),
    runEdgarSweepTick({ fetchFilings: fetch, resolveCik, deliver }),
  ]);

  assert.equal(delivered.length, 2, "exactly one winning delivery per subscription — never zero, never doubled");
  const deliveredIds = delivered.map((s) => s.id).sort();
  assert.deepEqual(deliveredIds, [subA.id, subB.id].sort());
});
