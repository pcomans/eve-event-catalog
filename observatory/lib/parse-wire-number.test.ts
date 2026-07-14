import { test } from "node:test";
import assert from "node:assert/strict";

import { parseWireNumber } from "./parse-wire-number.ts";

test("parseWireNumber accepts a plain integer string", () => {
  assert.equal(parseWireNumber("100000"), 100000);
});

test("parseWireNumber accepts a negative decimal string", () => {
  assert.equal(parseWireNumber("-32.46"), -32.46);
});

test("parseWireNumber rejects trailing garbage (unlike parseFloat)", () => {
  assert.equal(parseWireNumber("100oops"), null);
});

test("parseWireNumber rejects an empty string", () => {
  assert.equal(parseWireNumber(""), null);
});

test("parseWireNumber rejects a whitespace-only string", () => {
  assert.equal(parseWireNumber("   "), null);
});

test("parseWireNumber rejects Infinity", () => {
  assert.equal(parseWireNumber("Infinity"), null);
});

test("parseWireNumber rejects -Infinity", () => {
  assert.equal(parseWireNumber("-Infinity"), null);
});

test("parseWireNumber rejects NaN", () => {
  assert.equal(parseWireNumber("NaN"), null);
});

test("parseWireNumber rejects wholly non-numeric text", () => {
  assert.equal(parseWireNumber("bogus"), null);
});

test("parseWireNumber tolerates surrounding whitespace on a real number", () => {
  assert.equal(parseWireNumber("  42.5  "), 42.5);
});
