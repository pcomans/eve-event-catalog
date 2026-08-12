import assert from "node:assert/strict";
import { test } from "node:test";

import { startPollLoop, type PollLoopHost } from "./poll-loop.ts";

// Stand-in for the browser bits startPollLoop is given (poll-loop.ts's
// browserPollHost): timers that only fire when this test says so, and a
// visibility flag this test controls. Nothing here touches real time, so the
// suite is deterministic and instant.
function fakeBrowser() {
  let hidden = false;
  let nextId = 1;
  let lastDelay: number | undefined;
  const timers = new Map<number, () => void>();
  const listeners = new Set<() => void>();

  const host: PollLoopHost = {
    isHidden: () => hidden,
    schedule: (fn, ms) => {
      const id = nextId++;
      lastDelay = ms;
      timers.set(id, fn);
      return () => {
        timers.delete(id);
      };
    },
    onVisibilityChange: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };

  return {
    host,
    pendingTimers: () => timers.size,
    lastDelay: () => lastDelay,
    fireTimer: () => {
      const [id, fn] = [...timers.entries()][0];
      timers.delete(id);
      fn();
    },
    setHidden: (next: boolean) => {
      hidden = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

// Lets every already-queued microtask (the awaits inside a poll) drain before
// the assertions look at the loop's state.
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("startPollLoop: polls immediately, then reschedules itself at the interval", async () => {
  const browser = fakeBrowser();
  let runs = 0;
  const stop = startPollLoop(async () => {
    runs++;
  }, 2000, browser.host);

  await settle();
  assert.equal(runs, 1);
  assert.equal(browser.pendingTimers(), 1);
  assert.equal(browser.lastDelay(), 2000);

  browser.fireTimer();
  await settle();
  assert.equal(runs, 2);

  stop();
});

test("startPollLoop: a hidden tab neither polls nor holds a timer", async () => {
  const browser = fakeBrowser();
  browser.setHidden(true);
  let runs = 0;
  const stop = startPollLoop(async () => {
    runs++;
  }, 2000, browser.host);

  await settle();
  assert.equal(runs, 0, "a backgrounded tab must not hit the network");
  assert.equal(browser.pendingTimers(), 0, "a backgrounded tab must not keep waking up either");

  stop();
});

test("startPollLoop: becoming visible polls straight away, not an interval later", async () => {
  const browser = fakeBrowser();
  browser.setHidden(true);
  let runs = 0;
  const stop = startPollLoop(async () => {
    runs++;
  }, 60_000, browser.host);
  await settle();
  assert.equal(runs, 0);

  browser.setHidden(false);
  await settle();

  // No timer was fired: the poll happened because the tab came back, so the
  // user sees fresh data now rather than up to a whole interval later.
  assert.equal(runs, 1);
  assert.equal(browser.pendingTimers(), 1);

  stop();
});

test("startPollLoop: going hidden cancels the poll that was already scheduled", async () => {
  const browser = fakeBrowser();
  let runs = 0;
  const stop = startPollLoop(async () => {
    runs++;
  }, 2000, browser.host);
  await settle();
  assert.equal(browser.pendingTimers(), 1);

  browser.setHidden(true);
  await settle();
  assert.equal(browser.pendingTimers(), 0);
  assert.equal(runs, 1);

  stop();
});

test("startPollLoop: a visibility flip during an in-flight poll doesn't stack a second chain", async () => {
  const browser = fakeBrowser();
  let runs = 0;
  let release = () => {};
  const stop = startPollLoop(async () => {
    runs++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  }, 2000, browser.host);

  await settle();
  assert.equal(runs, 1);
  assert.equal(browser.pendingTimers(), 0, "nothing is scheduled while a poll is in flight");

  browser.setHidden(true);
  browser.setHidden(false);
  await settle();
  assert.equal(runs, 1, "the in-flight poll must not be duplicated");

  release();
  await settle();
  assert.equal(runs, 1);
  assert.equal(browser.pendingTimers(), 1, "exactly one chain is still scheduled");

  stop();
});

test("startPollLoop: an interval function is consulted after every run", async () => {
  const browser = fakeBrowser();
  const delays = [1_000, 5_000, 20_000];
  let runs = 0;
  const stop = startPollLoop(async () => {
    runs++;
  }, () => delays[runs - 1] ?? 0, browser.host);

  await settle();
  assert.equal(browser.lastDelay(), 1_000);
  browser.fireTimer();
  await settle();
  assert.equal(browser.lastDelay(), 5_000, "a backing-off caller decides each gap, not the loop");
  browser.fireTimer();
  await settle();
  assert.equal(browser.lastDelay(), 20_000);

  stop();
});

test("startPollLoop: a null interval retires the loop for good", async () => {
  const browser = fakeBrowser();
  let runs = 0;
  const stop = startPollLoop(async () => {
    runs++;
  }, () => null, browser.host);

  await settle();
  assert.equal(runs, 1);
  assert.equal(browser.pendingTimers(), 0, "nothing more is scheduled once the caller says stop");

  // Retirement has to survive a tab flip: the whole point is that a finished
  // session stops costing function invocations, including after a visit back.
  browser.setHidden(true);
  browser.setHidden(false);
  await settle();
  assert.equal(runs, 1);
  assert.equal(browser.pendingTimers(), 0);

  stop();
});

test("startPollLoop: a null interval retires even if the tab went hidden mid-run", async () => {
  const browser = fakeBrowser();
  let runs = 0;
  let release = () => {};
  const stop = startPollLoop(async () => {
    runs++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  }, () => null, browser.host);

  await settle();
  assert.equal(runs, 1);
  browser.setHidden(true);
  release();
  await settle();

  browser.setHidden(false);
  await settle();
  assert.equal(runs, 1, "the loop retired while hidden and must stay retired");
  assert.equal(browser.pendingTimers(), 0);

  stop();
});

test("startPollLoop: stop() cancels the timer and stops listening for visibility", async () => {
  const browser = fakeBrowser();
  let runs = 0;
  const stop = startPollLoop(async () => {
    runs++;
  }, 2000, browser.host);
  await settle();
  assert.equal(runs, 1);

  stop();
  assert.equal(browser.pendingTimers(), 0);

  browser.setHidden(true);
  browser.setHidden(false);
  await settle();
  assert.equal(runs, 1, "a stopped loop must stay stopped");
});
