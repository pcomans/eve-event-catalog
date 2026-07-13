import assert from "node:assert/strict";
import { test } from "node:test";

import { isWriteAllowed, nextToken } from "./fenced-lease.ts";

test("nextToken mints a strictly increasing sequence, starting from whatever the last-issued token was", () => {
  let token = 0; // no lease ever acquired yet
  token = nextToken(token);
  assert.equal(token, 1);
  token = nextToken(token);
  assert.equal(token, 2);
  token = nextToken(token);
  assert.equal(token, 3);
});

test("isWriteAllowed: a write carrying the CURRENT token is allowed", () => {
  assert.equal(isWriteAllowed(2, 2), true);
});

test("isWriteAllowed: a write carrying an OLDER token than current is rejected", () => {
  assert.equal(isWriteAllowed(2, 1), false);
});

// Correctness prerequisite 2's own named test: "a 'zombie' holder resuming
// after lease expiry cannot deliver or corrupt state." Simulates the full
// sequence: A acquires (token 1), A's lease expires unnoticed, B acquires
// (token 2, now current), A resumes and tries to write with its own
// (stale) token — must be rejected; B's own writes, with the current
// token, must still succeed.
test("isWriteAllowed: a zombie holder resuming after lease expiry cannot write, even though its own token was once valid", () => {
  let currentToken = 0;

  const holderAToken = nextToken(currentToken);
  currentToken = holderAToken;
  assert.equal(isWriteAllowed(currentToken, holderAToken), true, "A's write is valid while A is still the current holder");

  // A's lease expires without A knowing (e.g. a delayed reconnect, a
  // stalled retry) — B acquires a fresh lease, becoming the new holder.
  const holderBToken = nextToken(currentToken);
  currentToken = holderBToken;

  // A resumes (the "zombie") and attempts to write with ITS OWN token,
  // unaware it was ever superseded.
  assert.equal(isWriteAllowed(currentToken, holderAToken), false, "a stale (zombie) token must never be honored, even though it was once the current one");

  // B's own writes, carrying the NEW current token, are unaffected.
  assert.equal(isWriteAllowed(currentToken, holderBToken), true, "the current holder's own writes must still succeed");
});

test("isWriteAllowed: a token from a THIRD, even-later holder is also rejected against an OLDER 'current' (shouldn't happen in a correct caller, but must still be a strict equality, not >=)", () => {
  // currentToken lagging behind a token that was somehow minted further
  // ahead — defensive: isWriteAllowed must not treat "greater" as valid
  // either, since nextToken() is the only sanctioned way to advance
  // currentToken. A future-looking token with no matching current state
  // is just as invalid as a stale one.
  assert.equal(isWriteAllowed(2, 3), false);
});

test("isWriteAllowed: repeated writes from the SAME still-current holder all succeed (fencing doesn't force single-use tokens)", () => {
  const currentToken = nextToken(0);
  assert.equal(isWriteAllowed(currentToken, currentToken), true);
  assert.equal(isWriteAllowed(currentToken, currentToken), true, "the same token is valid for every write until a NEWER one is issued");
});
