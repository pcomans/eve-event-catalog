import type { Subscription } from "../types.ts";
import { readDesiredEdgarSubscriptions } from "./desired-membership.ts";
import { readSeenAccessions, addSeenAccessions } from "./edgar-redis.ts";
import { diffNewFilings, filingUrl, matchesFormFilter, seedAccessionSet, type FetchFilings, type FilingRecord } from "./edgar-client.ts";

// Phase 3's EDGAR sweep core: the coalescing/seeding/diffing decisions a
// durable connector workflow (connector/workflows/edgar-sweep.ts) drives
// every ~30s, extracted here (not connector/lib/) so it's covered by the
// root test suite the same way order-reconciliation.ts's pure orchestration
// is — real Redis for the seen-set/registry reads, injectable fakes only at
// the true external boundaries (the SEC fetch, ticker->CIK resolution, and
// wake delivery itself).
//
// This intentionally does NOT replace edgar.ts's in-process setInterval
// watcher — that keeps running in the eve process for local dev (Phase 2's
// "one code path, two hosts" carries forward: local mode keeps working).
// Running both against the same subscriptions is harmless, not
// redundant-but-broken: see sweepOneCik's own comment below for why.

function log(line: string): void {
  console.log(`[edgar-sweep] ${line}`);
}

/** Resolves a ticker to a CIK — edgar-client.ts's resolveCik in production, an injectable fake in tests. */
export type ResolveCik = (ticker: string) => Promise<string>;

/** Delivers one filing wake for one subscription — connector/lib/deliver-wake.ts's deliverWakeFromConnector in production. See sweepOneCik's doc comment for why this is the ONLY thing that has to be safe under concurrent sweeps. */
export type DeliverEdgarWake = (sub: Subscription, snapshot: Record<string, unknown>) => Promise<void>;

export interface EdgarSweepDeps {
  fetchFilings: FetchFilings;
  resolveCik: ResolveCik;
  deliver: DeliverEdgarWake;
}

interface CikGroup {
  cik: string;
  ticker: string;
  subs: Subscription[];
}

/**
 * Groups every currently-armed filing.new subscription by resolved CIK —
 * the coalescing AGENTS.md rule 3 requires: one SEC fetch per CIK per tick
 * regardless of how many subscriptions (or distinct tickers resolving to
 * the same CIK) are watching it. A single subscription's ticker failing to
 * resolve (typo, a ticker SEC's own company_tickers.json doesn't have) is
 * logged and skipped rather than failing the whole tick.
 */
async function groupByCik(subs: Subscription[], resolveCik: ResolveCik): Promise<CikGroup[]> {
  const byCik = new Map<string, CikGroup>();
  for (const sub of subs) {
    const ticker = sub.resource.toUpperCase();
    let cik: string;
    try {
      cik = await resolveCik(ticker);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`resolve-cik-error ticker=${ticker} sub=${sub.id} error=${message}`);
      continue;
    }
    const existing = byCik.get(cik);
    if (existing) existing.subs.push(sub);
    else byCik.set(cik, { cik, ticker, subs: [sub] });
  }
  return [...byCik.values()];
}

/** The earliest armedAt among a CIK's watching subscriptions — the conservative seed cutoff (see sweepOneCik): a filing after even the EARLIEST watcher's armedAt must be treated as new for everyone, since it's new information relative to at least one subscriber. */
function earliestArmedAt(subs: Subscription[]): string {
  return subs
    .map((sub) => sub.armedAt ?? new Date().toISOString())
    .reduce((min, armedAt) => (armedAt < min ? armedAt : min));
}

/**
 * One CIK's sweep tick: read the persisted seen-set (edgar-redis.ts), fetch
 * filings once (coalesced across every subscriber), establish a baseline on
 * this CIK's very first sweep (seen-set empty) using the EARLIEST
 * subscriber's armedAt as the cutoff, diff for what's new, and attempt
 * delivery for every subscriber whose formTypes filter matches.
 *
 * Seeding and diffing share the SAME `filings` fetch (unlike edgar.ts's
 * in-process watcher, which seeds at arm() time and only diffs on the next
 * poll): a filing SEC accepted after the cutoff is, by construction, not in
 * the seeded baseline, so it shows up as "fresh" in this very call — no
 * separate "seed now, wait one tick" step is needed.
 *
 * BINDING DESIGN REQUIREMENT (team-lead sign-off condition,
 * HANDOFF-PHASE3.md's EDGAR item): two overlapping sweep ticks racing THIS
 * function for the same CIK can both read the same seen-set, compute the
 * same "fresh" list, and both call `deliver` for the same subscription —
 * this is HARMLESS, not a bug, because `deliver` (deliverWakeFromConnector
 * in production) transitions through registry.ts's tryTransitionToDelivering,
 * an atomic Redis CAS that lets only ONE caller ever win the armed-
 * >delivering transition for a one-shot subscription; every other
 * concurrent caller's `deliver` call is a verified no-op (see that
 * function's own doc comment). The seen-set is explicitly NOT the dedupe
 * mechanism (edgar-redis.ts's own module comment says so) — it only decides
 * what's worth ATTEMPTING, never what's safe to attempt twice. See
 * edgar-sweep.test.ts's "two concurrent sweeps" test for a real-Redis,
 * real-CAS proof of exactly-one-wake-per-subscription under genuine overlap.
 *
 * ORDERING (p3 Codex gate finding 2, "the round's real bug"): the seen-set
 * is advanced ONLY AFTER every delivery attempt for this tick's fresh
 * filings, never before. The original ordering (seen-set advanced first)
 * meant a delivery failure — a transient Redis/CAS error, or a genuine
 * crash mid-tick — left the filing marked seen forever while the affected
 * subscription stayed armed: no later tick would ever see it as fresh
 * again, silently losing it. With this ordering, a crash anywhere before
 * the seen-set write just means the NEXT tick reprocesses the same
 * filing — safe, not wasteful, because `deliver`'s own CAS makes
 * reprocessing an already-won delivery a verified no-op (same reasoning as
 * the overlap paragraph above). See edgar-sweep.test.ts's "a delivery
 * failure does not lose the filing" and "a crash between a successful
 * delivery and marking the filing seen" tests.
 *
 * PER-SUBSCRIBER armedAt FILTER (p3 Codex gate finding 3): the seed cutoff
 * above is the CIK GROUP's earliest armedAt, not each subscriber's own — so
 * a filing can be legitimately "fresh" relative to an earlier-armed sibling
 * while still predating a LATER-armed subscriber's own subscription. Every
 * delivery decision below is filtered against `filing.acceptanceDateTime >
 * sub.armedAt`, not just the group-level "is this filing new at all"
 * question the seed cutoff answers — this applies uniformly whether the
 * filing came from the seeding gap (a CIK's very first sweep) or an
 * existing seen-set's idle-gap diff, both of which can produce the same
 * "fresh for the group, but pre-subscription for one member" shape.
 */
async function sweepOneCik(group: CikGroup, fetchFilings: FetchFilings, deliver: DeliverEdgarWake): Promise<void> {
  const seen = await readSeenAccessions(group.cik);
  const { company, filings } = await fetchFilings(group.cik);

  const baseline = seen.size === 0 ? seedAccessionSet(filings, earliestArmedAt(group.subs), false) : seen;
  const fresh = diffNewFilings(baseline, filings);

  log(`sweep cik=${group.cik} ticker=${group.ticker} subscribers=${group.subs.length} new=${fresh.length}`);

  for (const filing of fresh) {
    const filingAcceptedMs = new Date(filing.acceptanceDateTime).getTime();
    for (const sub of group.subs) {
      const { formTypes } = sub.params as { formTypes?: string[] };
      if (!matchesFormFilter(filing.form, formTypes)) continue;
      const armedAtMs = new Date(sub.armedAt ?? new Date().toISOString()).getTime();
      if (filingAcceptedMs <= armedAtMs) continue;
      await deliver(sub, filingSnapshot(company, group.cik, filing));
    }
  }

  await addSeenAccessions(
    group.cik,
    filings.map((filing) => filing.accessionNumber),
  );
}

function filingSnapshot(company: string, cik: string, filing: FilingRecord): Record<string, unknown> {
  return {
    company,
    cik,
    form: filing.form,
    accessionNumber: filing.accessionNumber,
    filingDate: filing.filingDate,
    primaryDocument: filing.primaryDocument,
    url: filingUrl(cik, filing.accessionNumber, filing.primaryDocument),
  };
}

/**
 * One full sweep tick, called every ~30s by the durable connector workflow
 * (connector/workflows/edgar-sweep.ts): reads every currently-armed
 * filing.new subscription, coalesces by CIK, and sweeps each — one poll
 * loop's worth of work per tick, never one per subscription (AGENTS.md rule
 * 3). A single CIK's sweep failing (a transient SEC 5xx, a Redis hiccup) is
 * logged loudly and does not abort the other CIKs' sweeps this tick — the
 * same "poll errors log loudly and keep the loop alive" convention edgar.ts's
 * own poll() uses.
 */
export async function runEdgarSweepTick(deps: EdgarSweepDeps): Promise<void> {
  const subs = await readDesiredEdgarSubscriptions();
  const groups = await groupByCik(subs, deps.resolveCik);

  for (const group of groups) {
    try {
      await sweepOneCik(group, deps.fetchFilings, deps.deliver);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`sweep-error cik=${group.cik} ticker=${group.ticker} error=${message}`);
    }
  }
}
