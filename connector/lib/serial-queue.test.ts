import assert from "node:assert/strict";
import { test } from "node:test";

import { createSerialQueue } from "./serial-queue.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// p6d gate fix (task #33's cursor-write throttle): same-symbol cursor
// writes were not serialized — a slower write started earlier could still
// land AFTER a faster one started later, letting the read-compare-write
// regression guard get raced. createSerialQueue is the fix: every task
// queued under the same key runs strictly after the previous one for that
// key has fully settled, no matter how long either takes.
test("createSerialQueue: two tasks under the SAME key run strictly in enqueue order, even if the first is slower", async () => {
  const queue = createSerialQueue();
  const order: string[] = [];
  const first = deferred<void>();

  const p1 = queue.run("NVDA", async () => {
    await first.promise; // deliberately slow — resolves only when the test says so, below
    order.push("first");
  });
  const p2 = queue.run("NVDA", async () => {
    order.push("second"); // enqueued second, but nothing blocks it once its turn comes
  });

  // At this point `second`'s task function hasn't run yet — it's chained
  // behind `first`, which is still awaiting `first.promise`.
  assert.deepEqual(order, []);

  first.resolve();
  await Promise.all([p1, p2]);

  assert.deepEqual(order, ["first", "second"], "second must never run before first, despite first being the slower task");
});

test("createSerialQueue: DIFFERENT keys run independently, not serialized against each other", async () => {
  const queue = createSerialQueue();
  const order: string[] = [];
  const nvdaBlock = deferred<void>();

  const pNvda = queue.run("NVDA", async () => {
    await nvdaBlock.promise;
    order.push("NVDA");
  });
  const pTsla = queue.run("TSLA", async () => {
    order.push("TSLA"); // a different key — must not wait behind NVDA's still-pending task
  });

  await pTsla;
  assert.deepEqual(order, ["TSLA"], "a task under a different key must not be blocked by NVDA's in-flight task");

  nvdaBlock.resolve();
  await pNvda;
  assert.deepEqual(order, ["TSLA", "NVDA"]);
});

test("createSerialQueue: a rejected task does not break the chain — the next task for the same key still runs", async () => {
  const queue = createSerialQueue();
  const order: string[] = [];

  const p1 = queue.run("NVDA", async () => {
    order.push("first");
    throw new Error("simulated failure");
  });
  const p2 = queue.run("NVDA", async () => {
    order.push("second");
  });

  await assert.rejects(p1, /simulated failure/);
  await p2;

  assert.deepEqual(order, ["first", "second"]);
});

test("createSerialQueue: the return value of run() resolves to that specific task's own result, not a neighbor's", async () => {
  const queue = createSerialQueue();

  const p1 = queue.run("NVDA", async () => "result-1");
  const p2 = queue.run("NVDA", async () => "result-2");

  assert.equal(await p1, "result-1");
  assert.equal(await p2, "result-2");
});

// p6d gate fix, round 2: connector/lib/alpaca-session.ts's onReconnected
// handler now queues every replayAfterStockReconnect call under ONE fixed
// key (REPLAY_QUEUE_KEY) rather than calling it directly — a flapping
// connection firing the reconnect event twice in quick succession used to
// start two overlapping replay tasks, racing ctx.seedingSymbols' add/delete
// pairs and the shared PriceWatch.previous across tasks (see that
// function's own comment for the full reasoning). This doesn't exercise
// alpaca-session.ts itself (no test file for it — too integration-heavy
// against the real Alpaca SDK, same reason connector/README already flags
// as a coverage gap) — it pins the exact usage SHAPE production code relies
// on: two triggers under the SAME fixed key, simulating two onReconnected
// firings, must never run concurrently.
test("createSerialQueue: two overlapping 'replay' triggers under the SAME fixed key execute sequentially, not concurrently", async () => {
  const queue = createSerialQueue();
  const REPLAY_QUEUE_KEY = "stock-reconnect-replay"; // mirrors alpaca-session.ts's own constant
  const order: string[] = [];
  const firstReplayStillRunning = deferred<void>();

  // Simulates the first onReconnected firing.
  const firstTrigger = queue.run(REPLAY_QUEUE_KEY, async () => {
    order.push("replay-1-start");
    await firstReplayStillRunning.promise; // held open, like a real replay awaiting a REST fetch
    order.push("replay-1-end");
  });

  // Simulates a SECOND onReconnected firing before the first replay finished
  // (a flapping connection) — must not start until the first is done.
  const secondTrigger = queue.run(REPLAY_QUEUE_KEY, async () => {
    order.push("replay-2-start");
  });

  // Lets the first task's queued `.then` callback actually run (it's always
  // scheduled on a microtask, never synchronously, even against an
  // already-resolved chain) so it reaches its own `await` and suspends
  // there — without this, `order` would still be empty at the point of the
  // check below, not because the guarantee failed but because neither task
  // has been given a turn to run at all yet.
  await Promise.resolve();
  assert.deepEqual(order, ["replay-1-start"], "the second trigger must not have started while the first is still in flight");

  firstReplayStillRunning.resolve();
  await Promise.all([firstTrigger, secondTrigger]);

  assert.deepEqual(order, ["replay-1-start", "replay-1-end", "replay-2-start"], "replay 2 must only start after replay 1 fully finished");
});
