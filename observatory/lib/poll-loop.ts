/**
 * The self-chaining loop behind usePolling (use-polling.ts) and the session
 * stream's reconnects (use-session-transcript.ts), with the browser plumbing
 * injected so node:test can drive it (poll-loop.test.ts).
 *
 * Two properties, both load-bearing:
 *
 * - **One request at a time.** The next poll is scheduled only once the
 *   previous one settles, so a hung/slow proxy or eve upstream can never
 *   stack concurrent requests or let a late response overwrite newer data.
 * - **A hidden tab costs nothing.** Every /api/* poll is two function
 *   invocations (browser → observatory proxy → eve), so an open-but-
 *   backgrounded observatory tab bills for pixels nobody is looking at.
 *   While hidden the loop parks completely — no fetch, and no timer waking
 *   up to re-check — and the visibilitychange listener polls again the
 *   moment the tab comes back, so a returning user sees fresh data
 *   immediately instead of up to a whole interval later.
 *
 * useEventFeed (use-event-feed.ts) still runs its own hand-rolled copy of
 * this loop with the weaker skip-the-fetch-but-keep-waking policy. Folding
 * it onto this module is the obvious follow-up; it was left alone here
 * deliberately, since it is the working production path and a React hook
 * can't be driven from node:test to prove the move safe.
 */

/**
 * How long to wait after a run before the next one.
 *
 * A number is the fixed interval usePolling wants. A function is consulted
 * after every run, so a caller can vary the gap (exponential backoff) or
 * return `null` to retire the loop for good — used by
 * use-session-transcript.ts, whose "run" is one connection to a durable
 * event stream: once that stream reports the session is over there is
 * nothing left to reconnect for, and reconnecting anyway is exactly the
 * production request storm this exists to prevent.
 */
export type PollInterval = number | (() => number | null);

/** The browser bits the loop needs, injected so tests can fake them. */
export interface PollLoopHost {
  isHidden: () => boolean;
  /** Runs `fn` after `ms`; returns a cancel function. */
  schedule: (fn: () => void, ms: number) => () => void;
  /** Subscribes to tab visibility flips; returns an unsubscribe function. */
  onVisibilityChange: (fn: () => void) => () => void;
}

// `document` is touched only inside these functions, never at module scope:
// the hooks are "use client" but still prerender to HTML on the server, where
// `document` doesn't exist. useEffect — the only place startPollLoop is
// called from — is the browser-only part.
export const browserPollHost: PollLoopHost = {
  isHidden: () => document.hidden,
  schedule: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
  onVisibilityChange: (fn) => {
    document.addEventListener("visibilitychange", fn);
    return () => document.removeEventListener("visibilitychange", fn);
  },
};

/**
 * Polls `run` every `interval` for as long as the tab is visible. Returns
 * a stop function — call it from the effect's cleanup.
 *
 * `run` owns its own error handling: it must resolve, never reject (the hook
 * catches into an `error` state). A rejection wouldn't stop the loop, but it
 * would surface as an unhandled rejection.
 *
 * An `interval` function is called once after each run and must be a plain
 * getter over the caller's own state — the loop asks it for a delay, it
 * doesn't expect it to advance anything.
 */
export function startPollLoop(
  run: () => Promise<void>,
  interval: PollInterval,
  host: PollLoopHost = browserPollHost,
): () => void {
  let stopped = false;
  let inFlight = false;
  let cancelTimer: (() => void) | undefined;

  function clearPending() {
    cancelTimer?.();
    cancelTimer = undefined;
  }

  // Terminal, and deliberately identical to the caller's stop(): a retired
  // loop stops listening for visibility too, so coming back to the tab
  // cannot restart it.
  function retire() {
    stopped = true;
    clearPending();
    unsubscribe();
  }

  async function tick() {
    cancelTimer = undefined;
    if (stopped || inFlight || host.isHidden()) return;
    inFlight = true;
    try {
      await run();
    } finally {
      inFlight = false;
      // Resolved even while hidden: a hidden tab schedules nothing anyway,
      // but a `null` answer has to retire the loop rather than leave it
      // parked and ready to restart on the next visibility flip.
      const delayMs = typeof interval === "number" ? interval : interval();
      if (delayMs === null) retire();
      else if (!stopped && !host.isHidden()) cancelTimer = host.schedule(tick, delayMs);
    }
  }

  // One path handles both directions of the flip: drop whatever was
  // scheduled, then tick — which polls straight away if the tab is now
  // visible and idle, and parks if it isn't.
  const unsubscribe = host.onVisibilityChange(() => {
    clearPending();
    void tick();
  });

  void tick();

  return retire;
}
