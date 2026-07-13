import type { Subscription } from "../types.ts";
import { registerProvider, type Provider } from "../catalog.ts";
import { deliverWake } from "../wake.ts";
import { logCatalog } from "../log.ts";
import {
  diffNewFilings,
  fetchFilingsFromSec,
  filingUrl,
  matchesFormFilter,
  padCik,
  parseFilings,
  resolveCik,
  seedAccessionSet,
  type FetchFilings,
  type FilingRecord,
} from "./edgar-client.ts";

// REST/data-shape and filing-decision concerns (padCik, FilingRecord,
// parseFilings, resolveCik/loadTickerMap, fetchFilingsFromSec, FetchFilings,
// matchesFormFilter, diffNewFilings, seedAccessionSet, filingUrl) moved to
// edgar-client.ts — catalog/providers/edgar-sweep.ts (Phase 3's connector
// sweep) needs them without pulling in this file's registerProvider() call
// and module-level watcher singleton below. Re-exported here so existing
// imports/tests in this file are unaffected.
export {
  diffNewFilings,
  fetchFilingsFromSec,
  filingUrl,
  matchesFormFilter,
  padCik,
  parseFilings,
  resolveCik,
  seedAccessionSet,
  type FetchFilings,
  type FilingRecord,
};

function log(line: string) {
  console.log(`[edgar] ${line}`);
}

// SEC has no push channel for filings — polling is the only option (AGENTS.md
// rule 3), so this file's whole job is polling per upstream *resource* (one
// CIK) with every subscriber coalesced onto that one loop, never one loop per
// subscription. REST reads (company_tickers.json, the submissions endpoint)
// are for resolving/seeding state, not a substitute for watching.
const POLL_INTERVAL_MS = 30_000;

/**
 * Debug-only forced-fire trick (AT-8 step 3), read from EDGAR_SEED_SKIP_LATEST:
 * yields the flag's real value exactly once, then always false — so a watch
 * torn down and recreated later in the same long-running process (e.g. a
 * demo operator disarms and re-subscribes) can't keep manufacturing repeat
 * forced wakes from one env var. Pure (given `initial`); the module-level
 * instance below is the only stateful use.
 */
export function createSkipLatestSeedConsumer(initial: boolean): () => boolean {
  let remaining = initial;
  return () => {
    const value = remaining;
    remaining = false;
    return value;
  };
}

// Read once at module load, like every other env var here (a process
// restart is required to change it anyway — KNOWN_ISSUES.md #2); consumed
// (see above) so only the very first watch created in this process can ever
// use it.
const consumeSkipLatestSeed = createSkipLatestSeedConsumer(process.env.EDGAR_SEED_SKIP_LATEST === "1");

interface CikWatch {
  cik: string;
  ticker: string;
  company: string;
  seen: Set<string>;
  subscriptions: Map<string, Subscription>;
  timer: ReturnType<typeof setInterval>;
}

export interface CikWatchInfo {
  cik: string;
  ticker: string;
  subscriberCount: number;
  seenCount: number;
}

export interface EdgarWatcher {
  arm(sub: Subscription, cik: string, ticker: string): Promise<void>;
  disarm(sub: Subscription): void;
  /** Test/introspection only — undefined means no live watch for this CIK (never created, or already torn down). */
  getWatch(cik: string): CikWatchInfo | undefined;
}

/**
 * Builds the coalesced arm/disarm/poll orchestration: one poll loop per CIK,
 * shared by every subscription watching it (AGENTS.md rule 3), regardless of
 * how many subscribe or in what order. Parameterized by `fetchFilings` (real
 * network in production, an injectable fake in tests) and `getSkipLatestSeed`
 * (the debug forced-fire trick) so the whole orchestration — including the
 * arm/disarm race below — is unit-testable without hitting SEC or real
 * timers.
 */
export function createEdgarWatcher(
  fetchFilings: FetchFilings,
  pollIntervalMs: number,
  getSkipLatestSeed: () => boolean,
): EdgarWatcher {
  // One poll loop per watched CIK, regardless of how many subscriptions watch
  // it — keyed by CIK, not by subscription id.
  const watches = new Map<string, CikWatch>();
  // Guards watch creation against two arm() calls for the same CIK racing
  // each other (two different conversations subscribing to the same company
  // can both complete their turns around the same time). Caching the
  // in-flight creation *promise* — set synchronously before any `await`,
  // same pattern as wake.ts's armClaimed — means the second caller reuses
  // the first's result instead of starting a second poll loop.
  const watchCreation = new Map<string, Promise<CikWatch>>();
  // subscriptionId -> cik, so disarm() (which only receives the Subscription,
  // not the watch it lives under) can find the right watch without
  // re-resolving the ticker.
  const subCik = new Map<string, string>();

  async function createWatch(cik: string, ticker: string, armedAt: string): Promise<CikWatch> {
    const { company, filings } = await fetchFilings(cik);
    const seen = seedAccessionSet(filings, armedAt, getSkipLatestSeed());
    const watch: CikWatch = {
      cik,
      ticker,
      company,
      seen,
      subscriptions: new Map(),
      timer: setInterval(() => void poll(watch), pollIntervalMs),
    };
    watches.set(cik, watch);
    log(`watch-start cik=${cik} ticker=${ticker} company="${company}" seeded=${seen.size}`);
    return watch;
  }

  /**
   * Resolves (creating if needed) the live watch for `cik` and inserts `sub`
   * into it — as one operation, not two, and that's the whole point: the
   * liveness re-check below and the `subscriptions.set()` that depends on it
   * must happen in the same synchronous block, with NO `await` anywhere in
   * between. A first version split them (this function returned the watch,
   * the caller awaited that and *then* inserted) — awaiting an async
   * function's returned promise yields to the microtask queue once more
   * regardless of what that function did internally, so a concurrent,
   * fully-synchronous disarm() could still tear the watch down in that
   * second gap, after the recheck had already confirmed it was live. Once a
   * subscription is actually inserted into `watch.subscriptions`, the watch
   * is protected from teardown for as long as that entry exists (disarm()
   * only tears down when the map is empty) — so returning only after the
   * insert, with the check and insert adjacent, closes every such window,
   * not just the first one a racing disarm could land in.
   */
  async function claimWatch(sub: Subscription, cik: string, ticker: string, armedAt: string): Promise<CikWatch> {
    let promise = watchCreation.get(cik);
    if (!promise) {
      promise = createWatch(cik, ticker, armedAt);
      watchCreation.set(cik, promise);
      // A failed first poll must not permanently poison this CIK — drop the
      // cached rejection so the next arm() attempt gets a clean retry instead
      // of reusing a promise that can only ever reject again.
      promise.catch(() => watchCreation.delete(cik));
    }
    const watch = await promise;
    // Synchronous from here to the insert: no `await` between the liveness
    // check and claiming a spot in `watch.subscriptions`.
    if (watches.get(cik) !== watch) return claimWatch(sub, cik, ticker, armedAt);
    watch.subscriptions.set(sub.id, sub);
    return watch;
  }

  async function poll(watch: CikWatch): Promise<void> {
    let company: string;
    let filings: FilingRecord[];
    try {
      ({ company, filings } = await fetchFilings(watch.cik));
    } catch (err) {
      // A transient SEC 5xx/network hiccup must not kill the loop — log
      // loudly and let the next tick try again (AGENTS.md rule 3's "poll
      // loop errors log loudly and keep the loop alive").
      const message = err instanceof Error ? err.message : String(err);
      log(`poll-error cik=${watch.cik} ticker=${watch.ticker} error=${message}`);
      return;
    }
    watch.company = company;

    const fresh = diffNewFilings(watch.seen, filings);
    for (const filing of fresh) watch.seen.add(filing.accessionNumber);

    log(`poll cik=${watch.cik} ticker=${watch.ticker} subscribers=${watch.subscriptions.size} new=${fresh.length}`);

    for (const filing of fresh) {
      for (const sub of watch.subscriptions.values()) {
        const { formTypes } = sub.params as { formTypes?: string[] };
        if (!matchesFormFilter(filing.form, formTypes)) continue;
        void deliverWake(sub, {
          reason: "fired",
          snapshot: {
            company: watch.company,
            cik: watch.cik,
            form: filing.form,
            accessionNumber: filing.accessionNumber,
            filingDate: filing.filingDate,
            primaryDocument: filing.primaryDocument,
            url: filingUrl(watch.cik, filing.accessionNumber, filing.primaryDocument),
          },
        });
      }
    }
  }

  async function arm(sub: Subscription, cik: string, ticker: string): Promise<void> {
    // Any failure inside claimWatch must not leave a dangling subCik entry
    // behind for a sub about to be marked "failed" — arm failures don't get
    // a disarm() call for free (same convention as alpaca.ts). subCik is set
    // only once claimWatch has genuinely inserted `sub` into a live watch;
    // by that point the watch can't be torn out from under it (see
    // claimWatch's doc comment), so no further atomicity is needed here.
    const watch = await claimWatch(sub, cik, ticker, sub.armedAt ?? new Date().toISOString());
    subCik.set(sub.id, cik);
    logCatalog("arm", sub, { cik, ticker, subscribers: watch.subscriptions.size });
  }

  function disarm(sub: Subscription): void {
    const cik = subCik.get(sub.id);
    subCik.delete(sub.id);
    if (!cik) return;

    const watch = watches.get(cik);
    if (!watch) return;
    watch.subscriptions.delete(sub.id);

    if (watch.subscriptions.size === 0) {
      clearInterval(watch.timer);
      watches.delete(cik);
      watchCreation.delete(cik);
      log(`watch-stop cik=${cik} ticker=${watch.ticker}`);
    }
  }

  function getWatch(cik: string): CikWatchInfo | undefined {
    const watch = watches.get(cik);
    if (!watch) return undefined;
    return { cik: watch.cik, ticker: watch.ticker, subscriberCount: watch.subscriptions.size, seenCount: watch.seen.size };
  }

  return { arm, disarm, getWatch };
}

const edgarWatcher = createEdgarWatcher(fetchFilingsFromSec, POLL_INTERVAL_MS, consumeSkipLatestSeed);

async function armFilingNew(sub: Subscription): Promise<void> {
  const ticker = sub.resource.toUpperCase();
  const cik = await resolveCik(ticker);
  await edgarWatcher.arm(sub, cik, ticker);
}

function disarmFilingNew(sub: Subscription): void {
  edgarWatcher.disarm(sub);
}

async function arm(sub: Subscription): Promise<void> {
  switch (sub.event) {
    case "filing.new":
      await armFilingNew(sub);
      return;
    default:
      throw new Error(`edgar provider does not support event: ${sub.event}`);
  }
}

async function disarm(sub: Subscription): Promise<void> {
  switch (sub.event) {
    case "filing.new":
      disarmFilingNew(sub);
      return;
    default:
      throw new Error(`edgar provider does not support event: ${sub.event}`);
  }
}

export const edgarProvider: Provider = {
  supportedEvents: ["filing.new"],
  arm,
  disarm,
};

registerProvider("edgar", edgarProvider);
