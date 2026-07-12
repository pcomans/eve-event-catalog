import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createEdgarWatcher,
  createSkipLatestSeedConsumer,
  diffNewFilings,
  filingUrl,
  matchesFormFilter,
  padCik,
  parseFilings,
  seedAccessionSet,
  type FetchFilings,
  type FilingRecord,
} from "./edgar.ts";
import type { Subscription } from "../types.ts";

test("padCik zero-pads a numeric CIK to 10 digits", () => {
  assert.equal(padCik(320193), "0000320193");
});

test("padCik zero-pads a string CIK to 10 digits", () => {
  assert.equal(padCik("320193"), "0000320193");
});

test("padCik leaves an already-10-digit CIK unchanged", () => {
  assert.equal(padCik("0000320193"), "0000320193");
});

test("parseFilings zips the submissions API's parallel arrays into records, preserving order", () => {
  const recent = {
    accessionNumber: ["0001-26-000002", "0001-26-000001"],
    filingDate: ["2026-06-17", "2026-05-29"],
    form: ["8-K", "10-Q"],
    primaryDocument: ["a.htm", "b.htm"],
    acceptanceDateTime: ["2026-06-17T22:40:43.000Z", "2026-05-29T22:30:27.000Z"],
  };
  assert.deepEqual(parseFilings(recent), [
    {
      accessionNumber: "0001-26-000002",
      filingDate: "2026-06-17",
      form: "8-K",
      primaryDocument: "a.htm",
      acceptanceDateTime: "2026-06-17T22:40:43.000Z",
    },
    {
      accessionNumber: "0001-26-000001",
      filingDate: "2026-05-29",
      form: "10-Q",
      primaryDocument: "b.htm",
      acceptanceDateTime: "2026-05-29T22:30:27.000Z",
    },
  ]);
});

test("matchesFormFilter matches any form when no filter is given", () => {
  assert.equal(matchesFormFilter("8-K", undefined), true);
  assert.equal(matchesFormFilter("8-K", []), true);
});

test("matchesFormFilter matches only listed forms when a filter is given", () => {
  assert.equal(matchesFormFilter("8-K", ["8-K", "10-Q"]), true);
  assert.equal(matchesFormFilter("4", ["8-K", "10-Q"]), false);
});

function filing(accessionNumber: string, acceptanceDateTime = "2026-07-11T00:00:00.000Z", form = "8-K"): FilingRecord {
  return { accessionNumber, filingDate: acceptanceDateTime.slice(0, 10), form, primaryDocument: "doc.htm", acceptanceDateTime };
}

test("diffNewFilings returns only filings absent from the seen-set", () => {
  const seen = new Set(["acc-1", "acc-2"]);
  const filings = [filing("acc-3"), filing("acc-1"), filing("acc-4")];
  assert.deepEqual(diffNewFilings(seen, filings), [filing("acc-3"), filing("acc-4")]);
});

test("diffNewFilings returns nothing when every filing is already seen", () => {
  const seen = new Set(["acc-1", "acc-2"]);
  assert.deepEqual(diffNewFilings(seen, [filing("acc-1"), filing("acc-2")]), []);
});

const ARMED_AT = "2026-07-12T05:00:00.000Z";

test("seedAccessionSet seeds every filing accepted at-or-before armedAt", () => {
  const filings = [
    filing("acc-3", "2026-07-12T04:50:00.000Z"),
    filing("acc-2", "2026-07-12T04:30:00.000Z"),
    filing("acc-1", "2026-07-12T04:00:00.000Z"),
  ];
  assert.deepEqual(seedAccessionSet(filings, ARMED_AT, false), new Set(["acc-3", "acc-2", "acc-1"]));
});

test("seedAccessionSet excludes a filing accepted AFTER armedAt — the seed-window fix: a filing that lands between " +
  "arm and the first poll must not be swallowed into the baseline", () => {
  const filings = [
    filing("acc-new", "2026-07-12T05:01:00.000Z"), // accepted after armedAt
    filing("acc-old", "2026-07-12T04:00:00.000Z"), // accepted before armedAt
  ];
  assert.deepEqual(seedAccessionSet(filings, ARMED_AT, false), new Set(["acc-old"]));
});

test("a filing accepted after armedAt is diffed as new on the very first poll, not swallowed into the baseline", () => {
  const filings = [filing("acc-new", "2026-07-12T05:01:00.000Z"), filing("acc-old", "2026-07-12T04:00:00.000Z")];
  const seeded = seedAccessionSet(filings, ARMED_AT, false);
  assert.deepEqual(diffNewFilings(seeded, filings), [filing("acc-new", "2026-07-12T05:01:00.000Z")]);
});

test("seedAccessionSet omits the most recent eligible (<=armedAt) filing when skipLatest is true — the documented forced-fire trick", () => {
  const filings = [
    filing("acc-new", "2026-07-12T05:01:00.000Z"), // excluded anyway (after armedAt)
    filing("acc-mid", "2026-07-12T04:30:00.000Z"),
    filing("acc-old", "2026-07-12T04:00:00.000Z"),
  ];
  assert.deepEqual(seedAccessionSet(filings, ARMED_AT, true), new Set(["acc-old"]));
});

test("seedAccessionSet with skipLatest on a single eligible filing seeds an empty set", () => {
  assert.deepEqual(seedAccessionSet([filing("acc-1", "2026-07-12T04:00:00.000Z")], ARMED_AT, true), new Set());
});

test("filingUrl builds the SEC Archives URL, stripping dashes from the accession number and leading zeros from the CIK", () => {
  assert.equal(
    filingUrl("0000320193", "0001140361-26-025622", "xslF345X06/form4.xml"),
    "https://www.sec.gov/Archives/edgar/data/320193/000114036126025622/xslF345X06/form4.xml",
  );
});

test("createSkipLatestSeedConsumer yields the initial value once, then always false — one debug forced-fire per process", () => {
  const consume = createSkipLatestSeedConsumer(true);
  assert.equal(consume(), true);
  assert.equal(consume(), false);
  assert.equal(consume(), false);
});

test("createSkipLatestSeedConsumer initialized false never yields true", () => {
  const consume = createSkipLatestSeedConsumer(false);
  assert.equal(consume(), false);
  assert.equal(consume(), false);
});

// --- createEdgarWatcher: the coalesced arm/disarm/poll orchestration,
// exercised against an injected fake fetcher (no real network) so races can
// be driven deterministically. ---

function fakeFetcher(company: string, filings: FilingRecord[]): FetchFilings {
  return async () => ({ company, filings });
}

function makeSub(id: string, resource: string, armedAt = ARMED_AT): Subscription {
  return {
    id,
    conversationId: `test:${id}`,
    provider: "edgar",
    event: "filing.new",
    resource,
    params: {},
    expiresAt: null,
    status: "armed",
    createdAt: armedAt,
    armedAt,
    firedAt: null,
    lastError: null,
  };
}

test("createEdgarWatcher coalesces two arms for the same CIK onto one watch, not two", async () => {
  const watcher = createEdgarWatcher(fakeFetcher("Apple Inc.", []), 1_000_000, () => false);
  const subA = makeSub("sub-a", "AAPL");
  const subB = makeSub("sub-b", "AAPL");

  await watcher.arm(subA, "0000320193", "AAPL");
  await watcher.arm(subB, "0000320193", "AAPL");

  assert.deepEqual(watcher.getWatch("0000320193"), { cik: "0000320193", ticker: "AAPL", subscriberCount: 2, seenCount: 0 });

  watcher.disarm(subA);
  assert.equal(watcher.getWatch("0000320193")?.subscriberCount, 1, "watch survives while a subscriber remains");
  watcher.disarm(subB);
  assert.equal(watcher.getWatch("0000320193"), undefined, "watch tears down once its last subscriber leaves");
});

test("an arm that resumes after the watch it was waiting on gets torn down lands on a fresh, live watch — not an orphaned dead one", async () => {
  const watcher = createEdgarWatcher(fakeFetcher("Apple Inc.", []), 1_000_000, () => false);
  const subA = makeSub("sub-a", "AAPL");
  const subB = makeSub("sub-b", "AAPL");

  await watcher.arm(subA, "0000320193", "AAPL");
  assert.deepEqual(watcher.getWatch("0000320193"), { cik: "0000320193", ticker: "AAPL", subscriberCount: 1, seenCount: 0 });

  // subB's arm() resolves getOrCreateWatch's cached (already-resolved)
  // creation promise, which still yields to the microtask queue at
  // `await promise` before subB is added to watch.subscriptions — giving
  // subA's fully-synchronous disarm() a window to tear the watch down
  // underneath it before subB's await resumes.
  const armB = watcher.arm(subB, "0000320193", "AAPL");
  watcher.disarm(subA);

  await armB;

  const info = watcher.getWatch("0000320193");
  assert.ok(info, "subB must land on a live watch, not one that was already torn down");
  assert.equal(info?.subscriberCount, 1, "only subB should be watching — subA's disarm already fired");

  watcher.disarm(subB);
  assert.equal(watcher.getWatch("0000320193"), undefined);
});

test("createEdgarWatcher seeds a freshly-created watch using the arming subscription's armedAt — a filing accepted after it is excluded from the baseline", async () => {
  const filings = [filing("acc-new", "2026-07-12T05:01:00.000Z"), filing("acc-old", "2026-07-12T04:00:00.000Z")];
  const watcher = createEdgarWatcher(fakeFetcher("Apple Inc.", filings), 1_000_000, () => false);
  const sub = makeSub("sub-a", "AAPL", ARMED_AT);

  await watcher.arm(sub, "0000320193", "AAPL");

  assert.equal(watcher.getWatch("0000320193")?.seenCount, 1, "only acc-old (accepted before armedAt) should be seeded");

  // Every watch creates a real setInterval — disarm to clear it, or the
  // leaked timer keeps the test process alive long after the suite finishes.
  watcher.disarm(sub);
});
