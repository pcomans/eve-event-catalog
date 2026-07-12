import assert from "node:assert/strict";
import { test } from "node:test";

import {
  diffNewFilings,
  filingUrl,
  matchesFormFilter,
  padCik,
  parseFilings,
  seedAccessionSet,
  type FilingRecord,
} from "./edgar.ts";

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
  };
  assert.deepEqual(parseFilings(recent), [
    { accessionNumber: "0001-26-000002", filingDate: "2026-06-17", form: "8-K", primaryDocument: "a.htm" },
    { accessionNumber: "0001-26-000001", filingDate: "2026-05-29", form: "10-Q", primaryDocument: "b.htm" },
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

function filing(accessionNumber: string, form = "8-K"): FilingRecord {
  return { accessionNumber, filingDate: "2026-07-11", form, primaryDocument: "doc.htm" };
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

test("seedAccessionSet seeds every filing's accession number by default", () => {
  const filings = [filing("acc-3"), filing("acc-2"), filing("acc-1")];
  assert.deepEqual(seedAccessionSet(filings, false), new Set(["acc-3", "acc-2", "acc-1"]));
});

test("seedAccessionSet omits the most recent (first) filing when skipLatest is true — the documented forced-fire trick", () => {
  const filings = [filing("acc-3"), filing("acc-2"), filing("acc-1")];
  assert.deepEqual(seedAccessionSet(filings, true), new Set(["acc-2", "acc-1"]));
});

test("seedAccessionSet with skipLatest on a single-filing list seeds an empty set", () => {
  assert.deepEqual(seedAccessionSet([filing("acc-1")], true), new Set());
});

test("filingUrl builds the SEC Archives URL, stripping dashes from the accession number and leading zeros from the CIK", () => {
  assert.equal(
    filingUrl("0000320193", "0001140361-26-025622", "xslF345X06/form4.xml"),
    "https://www.sec.gov/Archives/edgar/data/320193/000114036126025622/xslF345X06/form4.xml",
  );
});
