import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Redis } from "@upstash/redis";

import { diffNewFilings, type FilingRecord } from "./edgar.ts";
import { addSeenAccessions, readSeenAccessions } from "./edgar-redis.ts";

// Real Redis (no mocking) — same "test:"-namespaced, t.after()-cleaned
// convention as registry.test.ts. Each test uses its own fake CIK so
// concurrent runs never share a seen-set key.
const redis = Redis.fromEnv();
const testCik = () => `test:${randomUUID()}`;

function filing(accessionNumber: string): FilingRecord {
  return { accessionNumber, filingDate: "2026-07-13", form: "8-K", primaryDocument: "doc.htm", acceptanceDateTime: "2026-07-13T10:00:00Z" };
}

test("readSeenAccessions: a never-watched CIK reads as an empty set", async () => {
  assert.deepEqual(await readSeenAccessions(testCik()), new Set());
});

test("addSeenAccessions then readSeenAccessions round-trips through real Redis", async (t) => {
  const cik = testCik();
  t.after(() => redis.del(`catalog:edgar-seen:${cik}`));

  await addSeenAccessions(cik, ["0001", "0002"]);
  assert.deepEqual(await readSeenAccessions(cik), new Set(["0001", "0002"]));

  // A second, overlapping add (the coalesced-sweep-overlap case) must not
  // lose or duplicate anything — Redis SADD is naturally idempotent here.
  await addSeenAccessions(cik, ["0002", "0003"]);
  assert.deepEqual(await readSeenAccessions(cik), new Set(["0001", "0002", "0003"]));
});

test("addSeenAccessions with an empty list is a safe no-op, not a Redis wire error", async (t) => {
  const cik = testCik();
  t.after(() => redis.del(`catalog:edgar-seen:${cik}`));

  await assert.doesNotReject(() => addSeenAccessions(cik, []));
  assert.deepEqual(await readSeenAccessions(cik), new Set());
});

// The end-to-end shape a real coalesced sweep tick uses: read the persisted
// seen-set, diff it against a fresh (fake) filings fetch using edgar.ts's
// own pure diffNewFilings, then persist whatever was newly seen — proving
// the Redis-backed seen-set and the existing pure diff logic compose
// correctly, and that a second, later poll against the SAME filings sees
// nothing new (the whole point of persisting rather than re-seeding).
//
// Codex gate finding: this (like the round-trip test above) runs its two
// "ticks" sequentially, which proves the compose-correctly/no-repeat
// behavior under NO contention — it does NOT and CANNOT prove the module
// is safe against two REAL overlapping sweep workers racing the same CIK,
// because it isn't: this module's own comment (edgar-redis.ts) documents
// that plainly. Storage-level dedup (addSeenAccessions is idempotent) is
// what these tests verify; delivery-level dedup for a real EDGAR sweep
// will need the same tryTransitionToDelivering-based claim the
// price-crossing and order-reconciliation legs already use, once that
// sweep is built (Phase 3, not yet).
test("seen-set persists across two simulated sweep ticks: same filings poll twice, second tick finds nothing new", async (t) => {
  const cik = testCik();
  t.after(() => redis.del(`catalog:edgar-seen:${cik}`));

  const filings = [filing("0001"), filing("0002")];

  // Tick 1: nothing seen yet — both filings are "new."
  const seenBefore = await readSeenAccessions(cik);
  const fresh1 = diffNewFilings(seenBefore, filings);
  assert.equal(fresh1.length, 2);
  await addSeenAccessions(cik, fresh1.map((f) => f.accessionNumber));

  // Tick 2: same filings fetched again (SEC's endpoint always returns the
  // full recent list, not a delta) — must find zero new ones now.
  const seenAfter = await readSeenAccessions(cik);
  const fresh2 = diffNewFilings(seenAfter, filings);
  assert.equal(fresh2.length, 0, "a filing already persisted as seen must not fire again on the next sweep tick");
});

// A GENUINE concurrency test, unlike the sequential ones above: many
// simultaneous addSeenAccessions calls for the SAME cik, with overlapping
// and distinct accession numbers, fired via Promise.all rather than
// awaited one at a time — real concurrent Redis SADD calls, not simulated
// ones. Proves the STORAGE half (every accession ends up recorded exactly
// once, nothing lost to a lost update) genuinely holds under real
// concurrency. Does NOT prove (and per the module comment above, does not
// claim to prove) that a future delivery mechanism built on top would be
// duplicate-safe — that requires the CAS wake.ts's tryTransitionToDelivering
// provides, not anything SADD's own idempotency can offer.
test("addSeenAccessions: concurrent overlapping adds for the same CIK never lose an accession", async (t) => {
  const cik = testCik();
  t.after(() => redis.del(`catalog:edgar-seen:${cik}`));

  const batches = [
    ["0001", "0002"],
    ["0002", "0003"],
    ["0003", "0004"],
    ["0004", "0005"],
  ];
  await Promise.all(batches.map((batch) => addSeenAccessions(cik, batch)));

  assert.deepEqual(await readSeenAccessions(cik), new Set(["0001", "0002", "0003", "0004", "0005"]));
});
