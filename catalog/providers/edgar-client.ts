// Thin seam over SEC EDGAR's REST endpoints — ticker->CIK resolution and
// the per-CIK filings fetch — with zero side effects at module scope (no
// registerProvider(), no watcher construction). Split out from edgar.ts
// (the in-process provider) for the same reason alpaca-client.ts's
// describeAuthFailure was split out from alpaca.ts: catalog/providers/
// edgar-sweep.ts (Phase 3's connector sweep) needs these REST calls
// without pulling in edgar.ts's module-level watcher singleton and
// provider registration into a process that never uses them. edgar.ts re-exports
// everything below for backward compatibility with its existing imports
// and tests.

/**
 * One filing, in the shape needed for gap diffing — mirrors the submissions
 * API's own fields.
 */
export interface FilingRecord {
  accessionNumber: string;
  filingDate: string;
  form: string;
  primaryDocument: string;
  /** When SEC accepted the filing (ISO 8601) — the seed-window cutoff is measured against this, not filingDate. */
  acceptanceDateTime: string;
}

interface RecentFilings {
  accessionNumber: string[];
  filingDate: string[];
  form: string[];
  primaryDocument: string[];
  acceptanceDateTime: string[];
}

/** Zips the submissions API's structure-of-arrays into one record per filing, preserving order (newest first). Pure. */
export function parseFilings(recent: RecentFilings): FilingRecord[] {
  return recent.accessionNumber.map((accessionNumber, i) => ({
    accessionNumber,
    filingDate: recent.filingDate[i],
    form: recent.form[i],
    primaryDocument: recent.primaryDocument[i],
    acceptanceDateTime: recent.acceptanceDateTime[i],
  }));
}

/** Zero-pads a CIK to the 10 digits data.sec.gov's submissions URL requires. Pure. */
export function padCik(cik: number | string): string {
  return String(cik).padStart(10, "0");
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

export async function resolveCik(ticker: string): Promise<string> {
  tickerMapPromise ??= loadTickerMap();
  const map = await tickerMapPromise;
  const cik = map.get(ticker.toUpperCase());
  if (!cik) throw new Error(`EDGAR: unknown ticker "${ticker}" (not found in SEC company_tickers.json)`);
  return cik;
}

/** The shape a filings watcher/sweep needs from a filings source — the real implementation hits data.sec.gov; tests inject a fake. */
export type FetchFilings = (cik: string) => Promise<{ company: string; filings: FilingRecord[] }>;

export async function fetchFilingsFromSec(cik: string): Promise<{ company: string; filings: FilingRecord[] }> {
  const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: edgarHeaders() });
  if (!res.ok) throw new Error(`EDGAR submissions fetch failed for CIK${cik}: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { name: string; filings: { recent: RecentFilings } };
  return { company: data.name, filings: parseFilings(data.filings.recent) };
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
 * Builds the seen-set a freshly-created watch starts from: every filing SEC
 * accepted at-or-before `armedAt`. This is a seed WINDOW, not "everything
 * that currently exists" — a filing accepted between the subscription's
 * armedAt and the watch's first poll must NOT be swallowed into the
 * baseline, or it silently never fires (it was genuinely new information the
 * subscriber arrived in time to see). `filings` is newest-first (the
 * submissions API's own order — verified live), which `skipLatest` relies
 * on: with it set, the single most recent *eligible* (<=armedAt) filing is
 * left out on purpose — edgar.ts's own documented forced-fire trick
 * (createSkipLatestSeedConsumer decides whether skipLatest is ever true,
 * and only once per process — the connector's own sweep, catalog/providers/
 * edgar-sweep.ts, doesn't use this debug trick at all, always passing
 * `false`). Pure.
 */
export function seedAccessionSet(filings: FilingRecord[], armedAt: string, skipLatest: boolean): Set<string> {
  const armedAtMs = new Date(armedAt).getTime();
  const eligible = filings.filter((filing) => new Date(filing.acceptanceDateTime).getTime() <= armedAtMs);
  const toSeed = skipLatest ? eligible.slice(1) : eligible;
  return new Set(toSeed.map((filing) => filing.accessionNumber));
}

/** The human-viewable SEC Archives URL for a specific filing document. Pure. */
export function filingUrl(cik: string, accessionNumber: string, primaryDocument: string): string {
  const cikNoLeadingZeros = String(Number(cik));
  const accessionNoDashes = accessionNumber.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cikNoLeadingZeros}/${accessionNoDashes}/${primaryDocument}`;
}
