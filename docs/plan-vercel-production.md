# Plan: Everything on Vercel + public observatory

**Status: approved by Philipp 2026-07-12. Not started.** This document is self-contained on
purpose — it is the handoff into a fresh session. Read `AGENTS.md` (hard rules) and
`KNOWN_ISSUES.md` before any work; project memory lives at
`~/.claude/projects/-Users-philipp-code-event-catalogue/memory/`.

## Goal

Move the entire Event Catalog POC — including the watcher tier that currently runs only in the
local dev process — onto Vercel, and add a **public, read-only website** showing the agent's
history (conversations, wakeups) and current subscriptions. Purpose: this is the follow-up to
Philipp's pitch of the event catalog to **Pranay Prakash (Vercel)** — "here, see it in action."
A specific, technically sharp audience will receive a link; the bar is a living system, not a
screenshot.

**Showcase model (Philipp, 2026-07-12): the agent drives itself.** It gets a standing mandate —
*"trade and make (paper) money; everything else is up to you"* — and runs a continuous campaign:
researching, subscribing to events, sleeping, waking, trading, repeating. The site is live proof
of an autonomous event-driven agent, running unattended for **weeks**, always-on. Cost is not a
constraint (within reason).

## Decisions already made (do not re-litigate)

1. **Full realtime connector** — the Alpaca websockets stay realtime via Workflow-chained
   bounded socket sessions. NOT the polling fallback. All four correctness prerequisites below
   are in scope; they are the majority of the build.
2. **Public site is read-only** — subscriptions + lifecycle, wake/event history feed, and
   **full conversation transcripts** (the agent's reasoning, tool calls, decisions all public —
   confirmed 2026-07-12; "see it think" is the point). Chat and subscribe remain private
   (secret-protected). No public demo chat.
3. Standing process rules apply: Sonnet agents build/test (TDD red-green, node:test), the lead
   orchestrates and writes docs only, every coding step gets a Codex gate (gpt-5.6-sol, xhigh;
   split into narrow passes — long single-pass verdicts hang; kill the repo's codex broker tree
   on ≥3min silence and retry). Check current npm versions before adding any dependency. Verify
   `git log` before believing any agent's "done". Stage by full-diff review.
4. Non-Vercel components require Philipp's explicit approval (AGENTS.md rule 2). Approved so
   far: Upstash Redis, LangSmith, Tavily.
5. **Architecture forks require a check-in** (confirmed 2026-07-12). When Phase 0 (or later
   research) forks the topology — e.g. same-app Workflows don't work → connector becomes a
   sibling service — the build session **stops and asks Philipp** before committing to the
   branch. Autonomy holds within a chosen topology; the topology choice itself is his call.
6. **Vercel Pro is available** (confirmed 2026-07-12) — build against Pro-tier Fluid durations
   (800s GA / 1800s beta), Vercel Queues (beta), and Cron. No need to constrain to Hobby limits.

## Current state (baseline: commit 09fbce4, pushed to github.com/pcomans/eve-event-catalog)

Everything works locally and is Codex-gated: eve app (Nitro, port 2000) with catalog channel
(chat/wake/subscriptions routes), declarative catalog.json (Ajv-enforced schemas, onWake
guidance resolved server-side only), Redis-backed registry (subscriptions + conversationId↔
sessionId maps), wake delivery with in-process claim + expiry timers, Alpaca provider (SDK
4.0.0-alpha.3 pinned: StockDataStream + TradingStream push, edge-triggered crossings with
seeded prev), EDGAR provider (coalesced 30s/CIK polling), 5 agent tools (fully autonomous —
approval gate removed by explicit decision), LangSmith OTel, 86 tests. `docs/architecture.md`
documents the deployment thinking, incl. the "Deploying to Vercel" section this plan executes.
Task 7 (supervised live market-hours demo, twice) is still pending and independent of this plan.

## The four correctness prerequisites (requirements, not options)

These exist because distribution removes the hidden correctness mechanism of "one process, one
memory, dies together." Each must land with red-green tests:

1. **Historical gap replay** — edge triggers require continuous observation. Persist a
   per-symbol cursor (last processed trade id+timestamp) in Redis; on every (re)connect, fetch
   historical trades covering the gap, merge with buffered live trades in source order, dedupe
   by trade id, and run each through the crossing predicate before going live. Canonical failure
   to test: threshold 150, prev 151, gap contains 149→151 (crossed and recovered) — the wake
   MUST fire. (Local restart has a milder documented cousin: "restart = re-subscribe".)
2. **Fenced leases** — one watcher per stream. Redis lease with monotonically increasing fencing
   token; every delivery/state write carries the token; writes with stale tokens are rejected.
   Test: a "zombie" holder resuming after lease expiry cannot deliver or corrupt state.
3. **Dynamic membership** — a running socket session cannot receive in-memory updates (no
   instance affinity). The session re-reads its subscription set from Redis on a short cadence
   (~15s) and adjusts stream subscriptions. Test: subscription armed mid-session is watched
   within the cadence; last-unsubscribed symbol is dropped.
4. **Idempotent delivery recovery** — claim-then-publish is a dual write. Claims become
   expiring Redis leases (SET NX PX) with a recovery sweep for stranded `delivering`; queue
   consumers dedupe by `subscriptionId` (one-shot semantics make this the natural idempotency
   key). Test: crash-between-claim-and-publish recovers; duplicate publish wakes once.

## Architecture target

```
Vercel project(s)
  eve app (Functions + eve's workflows): agent, catalog API, wake route (now authenticated)
  connector runtime: Workflow chaining ~25-min socket-session steps
        (market-data stream + trade_updates stream), gap replay on each step start
  EDGAR: scheduled resource sweep (Workflow sleep(30s) loop preferred over Cron to keep the
        ~30s freshness contract; one sweep coalesces all CIKs; seen-sets in Redis)
  expiry: durable Workflow sleep per subscription OR sorted-set sweep (pick in design)
  delivery: deliverWake → Vercel Queues topic → consumer → authenticated POST /catalog/wake
  event history: NEW append-only Redis stream (all wakes, arms, fires, expiries, failures)
        written by wake.ts — this feeds the public site
  public site: read-only dashboard (hosting option per Phase 0)
Upstash Redis: registry, conversation maps, cursors, leases, seen-sets, event history
```

## Phase 0 — feasibility gates (research; may already be answered)

Two Explore agents (`deploy-research`, `dashboard-research`) were dispatched 2026-07-12 to
answer these; if their reports are in the prior session's transcript, use them, else re-run:

1. Can the public `workflow` npm package coexist with eve's pinned internal @workflow/* in ONE
   app (build integration, route collisions at /.well-known/workflow)? If not → the connector
   runtime becomes a **sibling app** (same repo or second project) sharing Redis and calling the
   eve app's wake route over HTTP. Also: Vercel Services (multi-framework projects) viability.
2. Does world-vercel buffer a wake `send()` arriving pre-park the way world-local does
   (KNOWN_ISSUES #7)? Must be re-verified on a deployed instance before trusting arming.
3. Vercel Queues current API/package/plan requirements; usable from Nitro/non-Next apps?
4. Alpaca historical trades REST on the FREE IEX feed (gap replay depends on it): recency
   restrictions, pagination, trade ids for dedupe.
5. eve production deploy mechanics (build command, custom channel routes → Functions, env,
   Agent Runs) + whether a deployed function may POST its own public URL (loopback wake).
6. Dashboard hosting pick: eve-channel-served HTML vs Vercel Services multi-app vs separate
   Next.js project on the same Redis.

Phase 0 outputs go into `docs/architecture.md` and adjust Phases 2/4 below. **If gate 1 or 6
forks the topology (same-app Workflows fail → sibling service; dashboard hosting choice), STOP
and ask Philipp before committing to the branch** (decision 5 above) — do not pick autonomously.

## Phases (each: build → tests green → live verification → Codex gate → commit/push)

**Phase 1 — delivery backbone (cloud-safe semantics while still running locally).**
Event-history Redis stream written by wake.ts/registry transitions (this also serves the site);
claims → expiring Redis leases + recovery sweep + idempotent consumer dedupe (prereq 4); wake +
chat routes gain shared-secret auth (env `CATALOG_API_SECRET`; public read routes stay open);
GET /catalog/subscriptions + new GET /catalog/events stay public read-only. All existing tests
must stay green; AT-2/AT-3 regression locally.

**Phase 2 — connector runtime.** Per Phase 0: same-app Workflows or sibling service. Implement
chained socket sessions with prereqs 1–3 (cursor+gap replay, fenced lease, membership cadence).
trade_updates gets the same treatment (order reconciliation is terminal-state REST — easy).
Extract-from-eve-process refactor: providers must run headless (no eve imports in the watcher
path — they already only import catalog/*; verify). Local mode keeps working (the dev server
runs the same runtime in-process — one code path, two hosts).

**Phase 3 — EDGAR + expiry migration.** Workflow sleep(30s) sweep for EDGAR (coalescing across
CIKs preserved; seen-sets already Redis-shaped — move them from memory); expiry via durable
sleep or sorted-set sweep. catalog.json freshness stays honest either way.

**Phase 4 — the mandate agent (the showcase's engine).**
- **Sell capability**: extend the order tools to position-bounded selling (market sell of held
  quantities only — no shorting, no margin; paper host stays hard-coded). This is a
  capability-bounds change: red-green tests + Codex gate scrutiny on the bounds.
- **Campaign guardrails — minimal (confirmed 2026-07-12: "it's paper, keep it light").** The one
  cap that genuinely matters is a **daily token/turn budget** for the agent (cost + runaway
  protection), enforced in code and env-configurable. The paper host + fully-autonomous open
  mandate are the intended posture, so do NOT add per-trade notional caps, max-trades-per-day, or
  max-concurrent-subscription limits as hard structural blockers — they constrain the very
  autonomy that's the showcase. Keep the existing paper-only / buy-side / market / day-order
  bounds that already exist (those are correctness, not judgment). Sell stays position-bounded
  (below). If a single cost cap needs a number, propose one; Philipp confirms at deploy.
- **Instructions rewrite** for the standing mandate: manage the paper portfolio via events —
  research, pick watches (price crossings both directions now meaningful, EDGAR filings as
  signals), size positions, realize P&L, always leave a subscription armed (the campaign must
  never dead-end with nothing watched). Keep the identity-only prompt discipline from task #10.
- **Tavily web search tool** (user-approved external service): one defineTool wrapping Tavily's
  search API (check current API + pricing; env TAVILY_API_KEY) so the agent can research before
  trading. Subject-matter tool like Alpaca, not infrastructure.
- **Campaign lifecycle**: an eve schedule (agent/schedules/) opens the market day — wakes the
  campaign conversation with a "market's open, review and act" turn; the event catalog does the
  intraday waking. Decide in design: one perpetual conversation vs daily conversations linked by
  a Redis-stored campaign summary (context growth over weeks says: daily conversations +
  carried-forward summary; the site threads them into one campaign view).

**Phase 5 — public observatory.** Hosting per Phase 0. Pages: (a) campaign view: equity curve +
positions + realized P&L over time (Alpaca account history; load the dataviz skill for charts),
(b) subscriptions table (live lifecycle from Redis), (c) event feed (wakes/arms/fires/expiries
with timestamps + elapsed times), (d) conversation/decision view (transcripts via
conversationId→sessionId map + eve session stream replay), threaded into the campaign timeline.
Read-only; no secrets rendered; rate limiting if trivially available. This is the demo's public
face — presentation quality matters (the audience is a Vercel engineer).

**Phase 6 — production deploy + cloud E2E + campaign launch.** Promote env vars to production
(incl. new secrets: CATALOG_API_SECRET, TAVILY_API_KEY), deploy, re-verify KNOWN_ISSUES #7 on
world-vercel (hard gate for trusting arming in prod), then the full cloud E2E during market
hours: subscribe → park → real cross → wake → autonomous trade → fill wake → all visible on the
public site. Twice. Then launch the standing campaign, observe one full unattended market day
(guardrails hold, feed populates, no human intervention), and only then send the link. Update
README/architecture.md (the "watcher tier runs locally" boundary dies; the narrow-gap statement
gets an "assembled anyway — here's how" epilogue).

## Acceptance additions

Extend `docs/acceptance-tests.md` with AT-10 (delivery backbone semantics incl. crash-recovery
tests), AT-11 (connector: gap-replay canonical case, zombie fencing, mid-session membership),
AT-12 (mandate agent: sell bounds — cannot sell more than held, cannot short; daily token/turn
budget enforced in code; campaign never ends with zero armed subscriptions), AT-13 (public site shows a
live wake end-to-end + campaign view renders equity/positions truthfully), AT-14 (cloud E2E
twice + one full unattended market day). Author these FIRST (tests-before-build applies to
acceptance criteria too).

## Risks / honest notes

- eve is beta; production behavior (world-vercel) may differ from everything we verified locally
  — Phase 5's #7 re-verification is a hard gate, not a formality.
- The Alpaca SDK is a pinned 11-day-old alpha; watch PR #295 for stable.
- Websocket sessions on the 30-min Fluid duration are beta on Pro; budget ~$15–20/mo always-on
  equivalent (market-hours-only less).
- If Phase 0 kills same-app Workflows AND sibling-service ergonomics are bad, the approved
  fallback discussion is documented in docs/architecture.md ("Where the connector primitive
  already exists") — but any non-Vercel host needs Philipp's explicit approval first.
