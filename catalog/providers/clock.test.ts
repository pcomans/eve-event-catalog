import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { getProvider, registerProvider, subscribe } from "../catalog.ts";
import { createSubscription, deleteSubscription, getSubscription, updateSubscription } from "../registry.ts";
import { cancelExpiry, scheduleExpiry } from "../wake.ts";
import {
  computeNextDelayMs,
  hasClockStateRecord,
  isTimerScheduled,
  MAX_TIMEOUT_MS,
  nextChunkDelayMs,
  setRetryDelayMsForTesting,
} from "./clock.ts";
// Side-effecting import: registers the real "clock" provider — see
// clock.ts's own registerProvider("clock", ...) call at module load.
import "./clock.ts";

// Mirrors wake.test.ts's stubFetchOk, but kept local: no test file in this
// repo currently exports it for reuse (see that file's own comment on why
// tests stub global.fetch rather than needing a live dev server).
function stubFetchOk() {
  const original = globalThis.fetch;
  let calls = 0;
  let lastBody: { payload?: { snapshot?: Record<string, unknown> } } | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (!href.includes("/catalog/wake")) return original(url as never, init);
    calls++;
    lastBody = init?.body ? JSON.parse(init.body as string) : undefined;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  return {
    callCount: () => calls,
    lastBody: () => lastBody,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function pollUntil(check: () => Promise<boolean>, maxAttempts = 20, intervalMs = 50): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

test("subscribe rejects clock.time.at with a missing 'at' param (Ajv 'required')", async () => {
  await assert.rejects(
    () =>
      subscribe({
        conversationId: `test:${randomUUID()}`,
        provider: "clock",
        event: "time.at",
        resource: "clock",
        params: {},
      }),
    /at/,
  );
});

test("subscribe rejects clock.time.at with a garbage (unparseable) 'at'", async () => {
  await assert.rejects(
    () =>
      subscribe({
        conversationId: `test:${randomUUID()}`,
        provider: "clock",
        event: "time.at",
        resource: "clock",
        params: { at: "not-a-real-datetime" },
      }),
    /not a valid ISO-8601 datetime/,
  );
});

test("subscribe rejects clock.time.at with a past 'at'", async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  await assert.rejects(
    () =>
      subscribe({
        conversationId: `test:${randomUUID()}`,
        provider: "clock",
        event: "time.at",
        resource: "clock",
        params: { at: past },
      }),
    /must be strictly in the future/,
  );
});

test("subscribe accepts clock.time.at with a valid future 'at'", async (t) => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const sub = await subscribe({
    conversationId: `test:${randomUUID()}`,
    provider: "clock",
    event: "time.at",
    resource: "market-open",
    params: { at: future },
  });
  t.after(() => deleteSubscription(sub.id));

  assert.equal(sub.status, "pending");
  assert.equal((sub.params as { at: string }).at, future);
});

test("clock provider: arm schedules a timer that fires deliverWake exactly once, reaching status 'fired'", async (t) => {
  const conversationId = `test:${randomUUID()}`;
  const at = new Date(Date.now() + 200).toISOString();
  const sub = await subscribe({
    conversationId,
    provider: "clock",
    event: "time.at",
    resource: "market-open",
    params: { at },
  });
  await updateSubscription(sub.id, { status: "armed", armedAt: new Date().toISOString() });
  t.after(() => deleteSubscription(sub.id));

  const fetchStub = stubFetchOk();
  t.after(fetchStub.restore);

  await getProvider("clock").arm({ ...sub, status: "armed", armedAt: new Date().toISOString() });

  const fired = await pollUntil(async () => {
    const current = await getSubscription(sub.id);
    return current?.status === "fired";
  });

  assert.ok(fired, "the clock timer should have fired deliverWake and reached status 'fired'");
  assert.equal(fetchStub.callCount(), 1, "exactly one wake POST — no duplicate fires");

  const snapshot = fetchStub.lastBody()?.payload?.snapshot;
  // Only scheduledFor — firedAt is dropped from the snapshot (the wake
  // envelope's own top-level firedAt is the authoritative timestamp; two
  // same-named timestamps in one wake message is confusion waiting to
  // happen).
  assert.deepEqual(snapshot, { scheduledFor: at });
});

test("clock provider: disarm cancels the scheduled timer — no wake ever sent", async (t) => {
  const conversationId = `test:${randomUUID()}`;
  const at = new Date(Date.now() + 150).toISOString();
  const sub = await subscribe({
    conversationId,
    provider: "clock",
    event: "time.at",
    resource: "market-open",
    params: { at },
  });
  const armed = { ...sub, status: "armed" as const, armedAt: new Date().toISOString() };
  await updateSubscription(sub.id, { status: "armed", armedAt: armed.armedAt });
  t.after(() => deleteSubscription(sub.id));

  const fetchStub = stubFetchOk();
  t.after(fetchStub.restore);

  await getProvider("clock").arm(armed);
  await getProvider("clock").disarm(armed);

  // Wait well past the original fire time — the disarmed timer must never fire.
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(fetchStub.callCount(), 0, "disarm must cancel the timer before it fires");
  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "armed", "still armed — disarm cancels the timer, it doesn't touch subscription status itself");
});

test("clock and expiry timers coexist on the same conversation without interfering with each other", async (t) => {
  const conversationId = `test:${randomUUID()}`;

  // A clock subscription firing on its own schedule...
  const clockAt = new Date(Date.now() + 150).toISOString();
  const clockSub = await subscribe({
    conversationId,
    provider: "clock",
    event: "time.at",
    resource: "market-open",
    params: { at: clockAt },
  });
  const clockArmed = { ...clockSub, status: "armed" as const, armedAt: new Date().toISOString() };
  await updateSubscription(clockSub.id, { status: "armed", armedAt: clockArmed.armedAt });
  t.after(() => deleteSubscription(clockSub.id));

  // ...alongside an unrelated, expiring subscription on the SAME conversation
  // (wake.ts's own scheduleExpiry/cancelExpiry timer machinery — a separate
  // Map, keyed independently, from clock.ts's own clockTimers). Created
  // directly via registry.ts (not catalog.ts's subscribe()), same as
  // wake.test.ts's own synthetic-provider tests: this is exercising
  // wake.ts's expiry timer, not catalog.json's declarative validation, so
  // no real catalog.json entry is needed for it.
  const expiryProviderName = `test-expiry-coexist-${randomUUID()}`;
  registerProvider(expiryProviderName, { supportedEvents: ["fire"], arm: async () => {}, disarm: async () => {} });
  const expiresAt = new Date(Date.now() + 300).toISOString();
  const expirySub = await createSubscription({
    conversationId,
    provider: expiryProviderName,
    event: "fire",
    resource: "NVDA",
    params: {},
    expiresAt,
  });
  await updateSubscription(expirySub.id, { status: "armed", armedAt: new Date().toISOString() });
  t.after(() => {
    cancelExpiry(expirySub.id);
    return deleteSubscription(expirySub.id);
  });

  const fetchStub = stubFetchOk();
  t.after(fetchStub.restore);

  await getProvider("clock").arm(clockArmed);
  scheduleExpiry({ ...expirySub, status: "armed", expiresAt });

  const bothDone = await pollUntil(async () => {
    const [clockNow, expiryNow] = await Promise.all([getSubscription(clockSub.id), getSubscription(expirySub.id)]);
    return clockNow?.status === "fired" && expiryNow?.status === "expired";
  });

  assert.ok(bothDone, "both timers should resolve independently without either canceling or overwriting the other");
  assert.equal(fetchStub.callCount(), 2, "one wake POST per subscription, no cross-talk");
});

// Codex clock-gate, fix 1: Node clamps a setTimeout delay above 2^31-1 ms
// (~24.855 days) to 1ms instead of waiting — an `at` a month out would fire
// almost immediately. Chunk math is pure and tested directly rather than
// waiting real days; the arm()-level test below only checks that a
// far-future subscription does NOT fire immediately and that a (chunked)
// timer really is scheduled.
test("nextChunkDelayMs caps a remaining delay at MAX_TIMEOUT_MS (Node's setTimeout overflow ceiling)", () => {
  const fortyDaysMs = 40 * 24 * 60 * 60 * 1000;
  assert.equal(nextChunkDelayMs(fortyDaysMs), MAX_TIMEOUT_MS);
});

test("nextChunkDelayMs passes through a delay that already fits in one setTimeout", () => {
  assert.equal(nextChunkDelayMs(1000), 1000);
  assert.equal(nextChunkDelayMs(0), 0);
});

// Codex clock-gate re-verify, fix 1 (drift): chunking must schedule off the
// ABSOLUTE target instant recomputed against the ACTUAL current time on
// every chunk, not a nominal remaining-minus-delay decrement carried
// forward — otherwise a chunk that fires late (event-loop congestion, a GC
// pause) pushes every later chunk later still, accumulating drift instead
// of correcting for it. computeNextDelayMs is the pure function scheduleTimer
// calls each time it (re-)arms, so the compensation is testable directly by
// simulating a late nowMs, without mocking global Date.now or waiting real
// time.
test("computeNextDelayMs compensates for a late-firing chunk instead of accumulating drift", () => {
  const start = Date.now();
  const targetMs = start + MAX_TIMEOUT_MS + 10_000;

  const firstDelay = computeNextDelayMs(targetMs, start);
  assert.equal(firstDelay, MAX_TIMEOUT_MS, "the first chunk should use the full ceiling");

  // Simulate this first chunk firing 5 seconds LATE rather than exactly on
  // its nominal schedule.
  const driftMs = 5000;
  const actualFireTime = start + firstDelay + driftMs;
  const compensatedNextDelay = computeNextDelayMs(targetMs, actualFireTime);

  // A naive (remaining - nominalChunk) decrement would still expect
  // 10_000ms remaining, oblivious to the drift. Absolute-deadline
  // scheduling must shrink the next delay by exactly the drift instead.
  assert.equal(compensatedNextDelay, 10_000 - driftMs, "the next chunk must shrink by exactly the drift, not repeat the nominal remaining delay");
});

test("computeNextDelayMs fires immediately (delay 0) once the target instant has already passed", () => {
  const targetMs = Date.now() + 1000;
  assert.equal(computeNextDelayMs(targetMs, targetMs + 500), 0);
});

test("clock provider: arming a subscription more than 25 days out does not fire immediately, and schedules a (chunked) timer", async (t) => {
  const conversationId = `test:${randomUUID()}`;
  const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const sub = await subscribe({
    conversationId,
    provider: "clock",
    event: "time.at",
    resource: "market-open",
    params: { at: farFuture },
  });
  const armed = { ...sub, status: "armed" as const, armedAt: new Date().toISOString() };
  await updateSubscription(sub.id, { status: "armed", armedAt: armed.armedAt });
  t.after(async () => {
    await getProvider("clock").disarm(armed); // clears the pending ~25-day chunk timer so the test process can exit
    await deleteSubscription(sub.id);
  });

  const fetchStub = stubFetchOk();
  t.after(fetchStub.restore);

  await getProvider("clock").arm(armed);

  assert.ok(isTimerScheduled(sub.id), "a (chunked) timer should be scheduled immediately after arm()");

  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(fetchStub.callCount(), 0, "a delay this long must NOT be clamped into firing almost immediately");
  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "armed");
});

// Codex clock-gate, fix 2 + 3: `at` must carry an explicit UTC offset (a
// bare "2026-07-14T09:30:00" silently parses as *server local time*, a trap
// for a distributed system with no fixed timezone), and must be a REAL
// calendar date/time — JS silently normalizes an out-of-range value (e.g.
// day 30 in February) instead of rejecting it.
test("subscribe rejects clock.time.at with an offset-less 'at' (no Z, no +HH:MM)", async () => {
  const future = new Date(Date.now() + 60_000);
  const offsetLess = future.toISOString().replace("Z", ""); // e.g. "2026-07-14T09:30:00.000"
  await assert.rejects(
    () =>
      subscribe({
        conversationId: `test:${randomUUID()}`,
        provider: "clock",
        event: "time.at",
        resource: "clock",
        params: { at: offsetLess },
      }),
    /must include an explicit UTC offset/,
  );
});

test("subscribe rejects clock.time.at with a named-month/non-ISO garbage 'at'", async () => {
  await assert.rejects(
    () =>
      subscribe({
        conversationId: `test:${randomUUID()}`,
        provider: "clock",
        event: "time.at",
        resource: "clock",
        params: { at: "July 13, 2026" },
      }),
    /not a valid ISO-8601 datetime/,
  );
});

test("subscribe rejects clock.time.at with an impossible calendar date (Feb 30)", async () => {
  await assert.rejects(
    () =>
      subscribe({
        conversationId: `test:${randomUUID()}`,
        provider: "clock",
        event: "time.at",
        resource: "clock",
        params: { at: "2026-02-30T09:30:00Z" },
      }),
    /not a real calendar date\/time/,
  );
});

// Codex clock-gate re-verify, fix 2 (NaN offset): an unconstrained
// `[+-]\d{2}:\d{2}` offset accepts nonsense like "+99:99" — new Date()
// turns that into a non-finite (NaN) instant, and NaN <= Date.now() is
// always false, so the "must be in the future" check would never trip and
// silently accept it. The offset is now range-constrained (00-14 hours,
// covering every real-world UTC offset up to +14:00) AND there's a direct
// Number.isFinite catch-all as a second line of defense.
test("subscribe rejects clock.time.at with a nonsense offset (+99:99)", async () => {
  const future = new Date(Date.now() + 60_000);
  const withNonsenseOffset = future.toISOString().replace("Z", "+99:99");
  await assert.rejects(
    () =>
      subscribe({
        conversationId: `test:${randomUUID()}`,
        provider: "clock",
        event: "time.at",
        resource: "clock",
        params: { at: withNonsenseOffset },
      }),
    /not a valid ISO-8601 datetime/,
  );
});

test("subscribe rejects clock.time.at with an offset just past the real-world range (+15:00)", async () => {
  const future = new Date(Date.now() + 60_000);
  const withOutOfRangeOffset = future.toISOString().replace("Z", "+15:00");
  await assert.rejects(
    () =>
      subscribe({
        conversationId: `test:${randomUUID()}`,
        provider: "clock",
        event: "time.at",
        resource: "clock",
        params: { at: withOutOfRangeOffset },
      }),
    /not a valid ISO-8601 datetime/,
  );
});

test("subscribe accepts clock.time.at at the edge of the real-world offset range (+14:00)", async (t) => {
  // +14:00 is the most-positive real-world UTC offset (Kiribati/Line
  // Islands) — the boundary the offset regex must accept, not just reject
  // just past. The wall-clock digits shown in a +14:00 string are 14 HOURS
  // AHEAD of the UTC instant they represent — add 14h (via real Date
  // arithmetic, so day/month/year rollover is handled correctly) before
  // formatting, rather than naively swapping "Z" for "+14:00" on an
  // otherwise-UTC-formatted string, which would represent an instant 14
  // hours in the PAST instead.
  const targetInstant = new Date(Date.now() + 60_000);
  const wallClockForOffset = new Date(targetInstant.getTime() + 14 * 60 * 60 * 1000);
  const at = wallClockForOffset.toISOString().replace("Z", "+14:00");
  const sub = await subscribe({
    conversationId: `test:${randomUUID()}`,
    provider: "clock",
    event: "time.at",
    resource: "clock",
    params: { at },
  });
  t.after(() => deleteSubscription(sub.id));
  assert.equal(sub.status, "pending");
});

test("subscribe accepts clock.time.at with a Z offset and with a numeric +HH:MM offset", async (t) => {
  const zFuture = new Date(Date.now() + 60_000).toISOString();
  const zSub = await subscribe({
    conversationId: `test:${randomUUID()}`,
    provider: "clock",
    event: "time.at",
    resource: "clock",
    params: { at: zFuture },
  });
  t.after(() => deleteSubscription(zSub.id));
  assert.equal(zSub.status, "pending");

  // A future instant expressed with a numeric offset instead of Z.
  const offsetFuture = new Date(Date.now() + 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const withOffset =
    `${offsetFuture.getUTCFullYear()}-${pad(offsetFuture.getUTCMonth() + 1)}-${pad(offsetFuture.getUTCDate())}` +
    `T${pad(offsetFuture.getUTCHours() + 2)}:${pad(offsetFuture.getUTCMinutes())}:${pad(offsetFuture.getUTCSeconds())}+02:00`;
  const offsetSub = await subscribe({
    conversationId: `test:${randomUUID()}`,
    provider: "clock",
    event: "time.at",
    resource: "clock",
    params: { at: withOffset },
  });
  t.after(() => deleteSubscription(offsetSub.id));
  assert.equal(offsetSub.status, "pending");
});

// Codex clock-gate, fix 4: a one-shot callback that deletes its Map entry
// and then does fallible work can leave a subscription "armed" forever if
// that work throws or defers before the armed -> delivering transition
// completes — sweepStrandedDeliveries only ever scans "delivering", so
// nothing else will ever revisit it. Both tests below inject a sustained
// Redis-level failure (see wake.test.ts's own comment on why a single-shot
// throw isn't enough against @upstash/redis's automatic retries), shrink
// the retry delay so the test doesn't wait 15 real seconds, then confirm
// the subscription is NOT stuck: a later retry delivers it exactly once.
test("clock provider: getSubscription throwing inside fire() never leaves an unhandled rejection — a retry delivers", async (t) => {
  setRetryDelayMsForTesting(100);
  t.after(() => setRetryDelayMsForTesting(15_000));

  const conversationId = `test:${randomUUID()}`;
  const at = new Date(Date.now() + 100).toISOString();
  const sub = await subscribe({
    conversationId,
    provider: "clock",
    event: "time.at",
    resource: "market-open",
    params: { at },
  });
  const armed = { ...sub, status: "armed" as const, armedAt: new Date().toISOString() };
  await updateSubscription(sub.id, { status: "armed", armedAt: armed.armedAt });
  t.after(() => deleteSubscription(sub.id));
  // Defensive: if an assertion below fails, an unbounded retry timer must
  // not keep firing (and keep this process alive) forever afterward.
  t.after(() => getProvider("clock").disarm(armed));

  const originalFetch = globalThis.fetch;
  let simulateFailure = true;
  let wakeCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const bodyText = typeof init?.body === "string" ? init.body : "";
    if (href.includes("/catalog/wake")) {
      wakeCalls++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (simulateFailure && bodyText.includes(`catalog:sub:${sub.id}`)) {
      throw new Error("simulated transient Redis error inside fire()'s own getSubscription");
    }
    return originalFetch(url as never, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await getProvider("clock").arm(armed); // schedules the timer; the process-level unhandled-rejection listener would catch a leak

  // Give the initial (failing) attempt time to run and log, then let the
  // simulated outage resolve before the retry timer fires.
  await new Promise((resolve) => setTimeout(resolve, 150));
  simulateFailure = false;

  const fired = await pollUntil(async () => {
    const current = await getSubscription(sub.id);
    return current?.status === "fired";
  });

  assert.ok(fired, "a retry after the transient failure resolves should still deliver the wake");
  assert.equal(wakeCalls, 1, "exactly one real wake POST — the failed attempt never reached the POST at all");
});

// A second angle on the same fix: retries must be UNBOUNDED (matching the
// module comment's own claim) — a subscription that fails twice in a row
// must still get a third attempt, not give up after one retry. Deliberately
// reuses the exact fault-injection shape as the test above (clock.ts's own
// pre-check getSubscription throwing, sustained) rather than a retryable
// WAKE POST status: a 500 from /catalog/wake happens AFTER
// tryTransitionToDelivering already succeeded, leaving the subscription
// "delivering" rather than "armed" — a case sweepStrandedDeliveries (not
// clock.ts's own retry) owns, so it wouldn't exercise this fix at all.
test("clock provider: retries are unbounded — two consecutive failures in a row are both tolerated before a later attempt delivers", async (t) => {
  setRetryDelayMsForTesting(100);
  t.after(() => setRetryDelayMsForTesting(15_000));

  const conversationId = `test:${randomUUID()}`;
  const at = new Date(Date.now() + 100).toISOString();
  const sub = await subscribe({
    conversationId,
    provider: "clock",
    event: "time.at",
    resource: "market-open",
    params: { at },
  });
  const armed = { ...sub, status: "armed" as const, armedAt: new Date().toISOString() };
  await updateSubscription(sub.id, { status: "armed", armedAt: armed.armedAt });
  t.after(() => deleteSubscription(sub.id));
  t.after(() => getProvider("clock").disarm(armed));

  const originalFetch = globalThis.fetch;
  let simulateFailure = true;
  let wakeCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const bodyText = typeof init?.body === "string" ? init.body : "";
    if (href.includes("/catalog/wake")) {
      wakeCalls++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (simulateFailure && bodyText.includes(`catalog:sub:${sub.id}`)) {
      throw new Error("simulated transient Redis error, sustained across two retry cycles");
    }
    return originalFetch(url as never, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await getProvider("clock").arm(armed);

  // The initial attempt (~100ms) and a first retry (another ~100ms) both
  // land inside this window and must both fail — resolving the simulated
  // outage only after two consecutive failures.
  await new Promise((resolve) => setTimeout(resolve, 250));
  simulateFailure = false;

  const fired = await pollUntil(async () => {
    const current = await getSubscription(sub.id);
    return current?.status === "fired";
  });

  assert.ok(fired, "a third attempt, after two consecutive retryable failures, should still deliver the wake");
  assert.equal(wakeCalls, 1, "exactly one real wake POST — both failed attempts never reached the POST at all");
});

// Codex clock-gate re-verify, fix 3: fire() used to delete its own (already
// spent) timer entry before its own awaits — a disarm() arriving WHILE that
// attempt was still in flight found no timer to cancel, and the catch
// block's unconditional retry-install ran anyway, installing a NEW timer
// for a subscription the agent had just explicitly cancelled. The fix keeps
// a persistent per-subscription `cancelled` flag (separate from the
// transient timer handle) that spans exactly that in-flight gap; fire()
// checks it before ever calling scheduleRetry.
//
// A sustained (never-resolved) Redis-level failure gives a genuine,
// multi-second in-flight window (@upstash/redis's own retry-with-backoff
// takes several real seconds to exhaust before an exception finally
// propagates — confirmed empirically in this session) — long enough for
// this test to land a disarm() call WHILE the attempt is still running,
// before it eventually throws and reaches fire()'s own catch block.
test("clock provider: disarm() arriving WHILE a fire() attempt is in-flight prevents a retry from ever being installed", async (t) => {
  const conversationId = `test:${randomUUID()}`;
  const at = new Date(Date.now() + 50).toISOString();
  const sub = await subscribe({
    conversationId,
    provider: "clock",
    event: "time.at",
    resource: "market-open",
    params: { at },
  });
  const armed = { ...sub, status: "armed" as const, armedAt: new Date().toISOString() };
  await updateSubscription(sub.id, { status: "armed", armedAt: armed.armedAt });
  t.after(() => deleteSubscription(sub.id));
  t.after(() => getProvider("clock").disarm(armed));

  const originalFetch = globalThis.fetch;
  let attemptStarted = false;
  let simulateFailure = true;
  let wakeCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const bodyText = typeof init?.body === "string" ? init.body : "";
    if (href.includes("/catalog/wake")) {
      wakeCalls++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (bodyText.includes(`catalog:sub:${sub.id}`)) {
      attemptStarted = true;
      // Sustained while simulateFailure is true — this attempt must
      // genuinely still be in flight, not already finished, when disarm()
      // arrives below. Flipped off afterward so the test's OWN assertion
      // reads (which touch this same key) aren't themselves intercepted.
      if (simulateFailure) throw new Error("simulated sustained Redis error");
    }
    return originalFetch(url as never, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await getProvider("clock").arm(armed);

  await pollUntil(async () => attemptStarted, 20, 25);
  assert.ok(attemptStarted, "the in-flight attempt should have started before disarm() arrives");

  await getProvider("clock").disarm(armed); // arrives mid-flight — well before the client's retry budget exhausts

  // Let the in-flight attempt fully exhaust its retry budget and finally
  // throw, reaching fire()'s own catch block.
  await new Promise((resolve) => setTimeout(resolve, 5500));
  simulateFailure = false; // the simulated outage resolves — only AFTER the in-flight attempt's own fate is already sealed

  assert.equal(isTimerScheduled(sub.id), false, "no retry timer should exist after a mid-flight disarm — even though the attempt eventually threw");
  assert.equal(wakeCalls, 0, "the in-flight attempt never reached the wake POST at all");
  assert.equal(
    hasClockStateRecord(sub.id),
    false,
    "the clockState record itself must be gone too — a leak here would accumulate one entry per cancelled subscription over a weeks-long campaign",
  );

  // Wait further still (well past where an incorrectly-installed retry —
  // even at the default 15s delay — would have fired) to prove the
  // disarmed subscription genuinely never wakes.
  const stored = await getSubscription(sub.id);
  assert.notEqual(stored?.status, "fired", "a subscription disarmed mid-flight must never wake later");
  assert.equal(wakeCalls, 0, "still zero wake attempts");
});

// Codex clock-gate final verify: two clockState record LEAKS, not
// correctness regressions — but a subscription-per-record leak over a
// campaign running unattended for weeks is a real problem in its own
// right. (1) disarm() set `cancelled` but never deleted the record when
// nothing was in flight. (2) fire()'s own early-return paths (cancelled,
// missing, no-longer-armed) exited without deleting. The fix adds an
// `inFlight` flag (fire() is the only setter) so disarm() can tell "safe to
// delete now" from "fire() still owns this, it'll clean up" without
// resurrecting the in-flight race the test above guards against. Invariant
// under test throughout: after any (disarm, fire) interleaving completes
// with no retry pending, the record is gone — hasClockStateRecord is false.
test("clock provider: a plain disarm with no in-flight fire removes the clockState record immediately", async (t) => {
  const conversationId = `test:${randomUUID()}`;
  const at = new Date(Date.now() + 10_000).toISOString(); // comfortably far off — no risk of firing before disarm() runs
  const sub = await subscribe({
    conversationId,
    provider: "clock",
    event: "time.at",
    resource: "market-open",
    params: { at },
  });
  const armed = { ...sub, status: "armed" as const, armedAt: new Date().toISOString() };
  await updateSubscription(sub.id, { status: "armed", armedAt: armed.armedAt });
  t.after(() => deleteSubscription(sub.id));

  await getProvider("clock").arm(armed);
  assert.ok(hasClockStateRecord(sub.id), "arm() should have created a record");

  await getProvider("clock").disarm(armed);

  assert.equal(hasClockStateRecord(sub.id), false, "disarm() with nothing in flight must remove the record immediately, not just clear the timer");
});

test("clock provider: a normal, fully-completed fire removes the clockState record", async (t) => {
  const conversationId = `test:${randomUUID()}`;
  const at = new Date(Date.now() + 100).toISOString();
  const sub = await subscribe({
    conversationId,
    provider: "clock",
    event: "time.at",
    resource: "market-open",
    params: { at },
  });
  const armed = { ...sub, status: "armed" as const, armedAt: new Date().toISOString() };
  await updateSubscription(sub.id, { status: "armed", armedAt: armed.armedAt });
  t.after(() => deleteSubscription(sub.id));
  t.after(() => getProvider("clock").disarm(armed));

  const fetchStub = stubFetchOk();
  t.after(fetchStub.restore);

  await getProvider("clock").arm(armed);

  // Poll the in-process record directly, not the registry's status field:
  // that's a SEPARATE async Redis read racing clock.ts's own internal
  // bookkeeping on unrelated network timing — it can observe "fired"
  // before (or after) clockState.delete() actually runs, which isn't the
  // condition this test is about. Generous attempt budget: a full
  // deliverWake completion is several sequential Redis round-trips (the
  // transition, the lease, the marker check, the wake POST, the terminal
  // write), comfortably longer than the helper's 1-second default.
  const cleanedUp = await pollUntil(async () => !hasClockStateRecord(sub.id), 60);

  assert.ok(cleanedUp, "the clockState record should have been removed within the poll window");
  assert.equal(hasClockStateRecord(sub.id), false, "a fully-completed fire must leave no clockState record behind");
  const stored = await getSubscription(sub.id);
  assert.equal(stored?.status, "fired");
});

test("clock provider: fire()'s early-return path (subscription no longer 'armed' by the time the timer runs) removes the clockState record", async (t) => {
  const conversationId = `test:${randomUUID()}`;
  // Deliberately more headroom than the other timer tests in this file: the
  // updateSubscription() call below (a real Redis round trip) must reliably
  // land BEFORE the timer fires, or fire() reads the subscription while it's
  // still "armed" and races past the early-return path entirely (completing
  // normally instead) — happened in practice at 100ms.
  const at = new Date(Date.now() + 2000).toISOString();
  const sub = await subscribe({
    conversationId,
    provider: "clock",
    event: "time.at",
    resource: "market-open",
    params: { at },
  });
  const armed = { ...sub, status: "armed" as const, armedAt: new Date().toISOString() };
  await updateSubscription(sub.id, { status: "armed", armedAt: armed.armedAt });
  t.after(() => deleteSubscription(sub.id));
  t.after(() => getProvider("clock").disarm(armed));

  const fetchStub = stubFetchOk();
  t.after(fetchStub.restore);

  await getProvider("clock").arm(armed);
  assert.ok(hasClockStateRecord(sub.id));

  // Simulate some OTHER mechanism resolving this subscription before the
  // timer fires — bypassing clock.ts's own disarm() entirely (e.g. a
  // completely separate expiry/cancellation path). fire()'s own early
  // "sub.status !== 'armed'" check must still clean up the record, not
  // just return early and leak it.
  await updateSubscription(sub.id, { status: "fired", firedAt: new Date().toISOString() });

  const cleanedUp = await pollUntil(async () => !hasClockStateRecord(sub.id), 60);
  assert.ok(cleanedUp, "the clockState record should have been removed within the poll window");

  assert.equal(hasClockStateRecord(sub.id), false, "the early-return path must remove the record, not just exit silently");
  assert.equal(fetchStub.callCount(), 0, "no wake POST should have been attempted — the subscription was already resolved before the timer even ran");
});
