import type { Subscription } from "../types.ts";
import { registerProvider, type Provider } from "../catalog.ts";
import { deliverWake } from "../wake.ts";
import { logCatalog } from "../log.ts";

function log(line: string) {
  console.log(`[edgar] ${line}`);
}

// SEC has no push channel for filings — polling is the only option (AGENTS.md
// rule 3), so this file's whole job is polling per upstream *resource* (one
// CIK) with every subscriber coalesced onto that one loop, never one loop per
// subscription. REST reads (company_tickers.json, the submissions endpoint)
// are for resolving/seeding state, not a substitute for watching.
const POLL_INTERVAL_MS = 30_000;

// Debug-only forced-fire trick (AT-8 step 3): when set, the very first watch
// created for a CIK seeds its seen-set with every filing EXCEPT the single
// most recent one, so the next poll (~30s later) treats that already-existing
// filing as "new" and fires — useful on weekends when no real filing will
// land. Read once at module load, like every other env var here (a process
// restart is required to change it anyway — KNOWN_ISSUES.md #2).
const SEED_SKIP_LATEST = process.env.EDGAR_SEED_SKIP_LATEST === "1";

/** Zero-pads a CIK to the 10 digits data.sec.gov's submissions URL requires. Pure. */
export function padCik(cik: number | string): string {
  return String(cik).padStart(10, "0");
}

export interface FilingRecord {
  accessionNumber: string;
  filingDate: string;
  form: string;
  primaryDocument: string;
}

interface RecentFilings {
  accessionNumber: string[];
  filingDate: string[];
  form: string[];
  primaryDocument: string[];
}

/** Zips the submissions API's structure-of-arrays into one record per filing, preserving order (newest first). Pure. */
export function parseFilings(recent: RecentFilings): FilingRecord[] {
  return recent.accessionNumber.map((accessionNumber, i) => ({
    accessionNumber,
    filingDate: recent.filingDate[i],
    form: recent.form[i],
    primaryDocument: recent.primaryDocument[i],
  }));
}

/** True if `form` passes the subscription's optional formTypes filter (no filter = match anything). Pure. */
export function matchesFormFilter(form: string, formTypes?: string[]): boolean {
  if (!formTypes || formTypes.length === 0) return true;
  return formTypes.includes(form);
}

/** Filings not already in the per-CIK seen-set — the diff that turns a poll into "what's new". Pure. */
export function diffNewFilings(seen: ReadonlySet<string>, filings: FilingRecord[]): FilingRecord[] {
  return filings.filter((filing) => !seen.has(filing.accessionNumber));
}

/**
 * Builds the seen-set a freshly-created watch starts from. `filings` is
 * newest-first (the submissions API's own order — verified live). With
 * `skipLatest`, the single most recent filing is left out on purpose: see
 * SEED_SKIP_LATEST above. Pure.
 */
export function seedAccessionSet(filings: FilingRecord[], skipLatest: boolean): Set<string> {
  const toSeed = skipLatest ? filings.slice(1) : filings;
  return new Set(toSeed.map((filing) => filing.accessionNumber));
}

/** The human-viewable SEC Archives URL for a specific filing document. Pure. */
export function filingUrl(cik: string, accessionNumber: string, primaryDocument: string): string {
  const cikNoLeadingZeros = String(Number(cik));
  const accessionNoDashes = accessionNumber.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cikNoLeadingZeros}/${accessionNoDashes}/${primaryDocument}`;
}

/** Required by SEC on every request (data.sec.gov and www.sec.gov both 403 without a descriptive User-Agent) — verified live. */
function edgarHeaders(): HeadersInit {
  const userAgent = process.env.EDGAR_USER_AGENT;
  if (!userAgent) {
    throw new Error(
      'EDGAR_USER_AGENT is not set — SEC EDGAR requires a descriptive User-Agent ("<name> <email>") ' +
        "or it 403s every request. Set it in .env.local.",
    );
  }
  return { "User-Agent": userAgent, "Accept-Encoding": "gzip" };
}

interface TickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

// Fetched once per process and cached — company_tickers.json is ~9k entries
// and doesn't change fast enough to justify refetching per ticker lookup.
// Cached as the in-flight promise itself (not its resolved value) so
// concurrent lookups during the first fetch share one request rather than
// firing several.
let tickerMapPromise: Promise<Map<string, string>> | null = null;

async function loadTickerMap(): Promise<Map<string, string>> {
  const res = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: edgarHeaders() });
  if (!res.ok) throw new Error(`EDGAR ticker lookup failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as Record<string, TickerEntry>;
  const map = new Map<string, string>();
  for (const entry of Object.values(data)) map.set(entry.ticker.toUpperCase(), padCik(entry.cik_str));
  return map;
}

async function resolveCik(ticker: string): Promise<string> {
  tickerMapPromise ??= loadTickerMap();
  const map = await tickerMapPromise;
  const cik = map.get(ticker.toUpperCase());
  if (!cik) throw new Error(`EDGAR: unknown ticker "${ticker}" (not found in SEC company_tickers.json)`);
  return cik;
}

async function fetchFilings(cik: string): Promise<{ company: string; filings: FilingRecord[] }> {
  const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: edgarHeaders() });
  if (!res.ok) throw new Error(`EDGAR submissions fetch failed for CIK${cik}: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { name: string; filings: { recent: RecentFilings } };
  return { company: data.name, filings: parseFilings(data.filings.recent) };
}

interface CikWatch {
  cik: string;
  ticker: string;
  company: string;
  seen: Set<string>;
  subscriptions: Map<string, Subscription>;
  timer: ReturnType<typeof setInterval>;
}

// One poll loop per watched CIK, regardless of how many subscriptions watch
// it (AGENTS.md rule 3) — keyed by CIK, not by subscription id.
const watches = new Map<string, CikWatch>();
// Guards watch creation against two arm() calls for the same CIK racing each
// other (two different conversations subscribing to the same company can
// both complete their turns around the same time). Caching the in-flight
// creation *promise* — set synchronously before any `await`, same pattern as
// wake.ts's armClaimed — means the second caller reuses the first's result
// instead of starting a second poll loop. See createWatch's rejection
// cleanup below for the failure path.
const watchCreation = new Map<string, Promise<CikWatch>>();
// subscriptionId -> cik, so disarm() (which only receives the Subscription,
// not the watch it lives under) can find the right watch without
// re-resolving the ticker.
const subCik = new Map<string, string>();

async function createWatch(cik: string, ticker: string): Promise<CikWatch> {
  const { company, filings } = await fetchFilings(cik);
  const seen = seedAccessionSet(filings, SEED_SKIP_LATEST);
  const watch: CikWatch = {
    cik,
    ticker,
    company,
    seen,
    subscriptions: new Map(),
    timer: setInterval(() => void poll(watch), POLL_INTERVAL_MS),
  };
  watches.set(cik, watch);
  log(
    `watch-start cik=${cik} ticker=${ticker} company="${company}" seeded=${seen.size}` +
      (SEED_SKIP_LATEST ? " skip-latest=1 (debug forced-fire seeding)" : ""),
  );
  return watch;
}

function getOrCreateWatch(cik: string, ticker: string): Promise<CikWatch> {
  let promise = watchCreation.get(cik);
  if (!promise) {
    promise = createWatch(cik, ticker);
    watchCreation.set(cik, promise);
    // A failed first poll must not permanently poison this CIK — drop the
    // cached rejection so the next arm() attempt gets a clean retry instead
    // of reusing a promise that can only ever reject again.
    promise.catch(() => watchCreation.delete(cik));
  }
  return promise;
}

async function poll(watch: CikWatch): Promise<void> {
  let company: string;
  let filings: FilingRecord[];
  try {
    ({ company, filings } = await fetchFilings(watch.cik));
  } catch (err) {
    // A transient SEC 5xx/network hiccup must not kill the loop — log loudly
    // and let the next tick try again (AGENTS.md rule 3's "poll loop errors
    // log loudly and keep the loop alive").
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

async function armFilingNew(sub: Subscription): Promise<void> {
  const ticker = sub.resource.toUpperCase();
  const cik = await resolveCik(ticker);
  // Any failure past this point must not leave a dangling subCik entry
  // behind for a sub about to be marked "failed" — arm failures don't get a
  // disarm() call for free (same convention as alpaca.ts).
  const watch = await getOrCreateWatch(cik, ticker);
  watch.subscriptions.set(sub.id, sub);
  subCik.set(sub.id, cik);
  logCatalog("arm", sub, { cik, ticker, subscribers: watch.subscriptions.size });
}

function disarmFilingNew(sub: Subscription): void {
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
