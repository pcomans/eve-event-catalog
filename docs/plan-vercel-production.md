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

## Architecture target — ONE Vercel project, three services (settled 2026-07-12)

Phase 0 (below) resolved the topology. The connector CANNOT live in the eve app (eve vendors
`@workflow/*` at `5.0.0-beta.x` privately; the public `workflow` package is `4.6.0`,
major-incompatible, and both fight over `/.well-known/workflow/*`). Philipp chose **Vercel
Services** (GA, multi-framework in one project, private bindings, shared Redis, atomic deploys)
for both the connector and the dashboard — so "sibling service" keeps the single-deploy,
everything-on-Vercel story intact.

```
Vercel project (Vercel Services — one project, three services, private bindings)
  ┌ service: eve app (Nitro → Functions): agent, catalog API, authenticated wake route
  ├ service: connector runtime (public `workflow` 4.6.0 pkg): Workflow chaining ~25-min
  │     socket-session steps (market-data + trade_updates streams), gap replay on each step
  │     start; EDGAR scheduled sweep (Workflow sleep(30s) loop preferred over Cron to keep the
  │     ~30s freshness; one sweep coalesces all CIKs); expiry (durable sleep OR sorted-set
  │     sweep — pick in design). Calls eve's wake route via private binding, not public hop.
  └ service: Next.js observatory (read-only public site): equity/positions, subscriptions
        table, event feed, full transcripts. Private-binds to eve/Redis; public via top-level
        rewrite rule.
  delivery: deliverWake → Vercel Queues topic (@vercel/queue) → consumer → wake route
  event history: NEW append-only Redis stream (all wakes/arms/fires/expiries/failures) written
        by wake.ts — feeds the observatory
Upstash Redis: registry, conversation maps, cursors, leases, seen-sets, event history — shared
        across all three services
```

## Phase 0 — feasibility gates (RESOLVED 2026-07-12 by `deploy-research` + `dashboard-research`)

Findings folded in below; the topology forks (gates 1 & 6) were brought to Philipp and decided.
Two items remain as **empirical smoke-tests inside the build** (not blockers to starting): #2
and #3's Nitro caveat. New gate 7 (unbounded-workflow API) is the only fresh research to run.

1. **Same-app Workflows: INFEASIBLE → sibling service (DECIDED: Vercel Services).** eve vendors
   `@workflow/*` at `5.0.0-beta.x` privately (`#compiled/@workflow/...`, not app-importable); the
   public `workflow` package is `4.6.0` — major-incompatible, and both would claim
   `/.well-known/workflow/v1/*`. eve owns its Nitro build (no app-editable `nitro.config.ts`), so
   there's no clean hook to mount `@workflow/nitro`. Connector runs as its own **Vercel Service**
   (public `workflow` pkg) in the same project, private-bound to eve, shared Redis. (Philipp
   chose Vercel Services over a separate project.)
2. **world-vercel pre-park buffering (#7): structurally LIKELY to hold, must still test.** eve's
   buffering/ordering (`session-delivery-hook.js`, `hook-ownership.js` forcing durable hook
   registration before "parked" returns via `getConflict()`) is world-agnostic execution-layer
   code, shipped unmodified to both backends — so the logical guarantee should transfer. BUT
   world-vercel registration is a network round-trip vs local's in-memory write, which can change
   the race-window size. **Hard test on a real preview deploy before trusting arming (Phase 6).**
3. **Vercel Queues: CONFIRMED.** `@vercel/queue@0.4.0`, `send()`/`handleCallback()`,
   `experimentalTriggers: [{type:"queue/v2beta", topic}]` makes the consumer route private, TTL
   60s–7d, visibility 0–60min. **Not Pro-gated** (all plans). Works with `vercel dev`. **Open
   caveat: no doc confirms clean use from a Nitro route — smoke-test `send`/`handleCallback` from
   Nitro early in Phase 1.**
4. **Alpaca gap replay on free IEX: CONFIRMED (moderate confidence).** The 15-min delay is a SIP
   restriction only — IEX historical trades query up to "now" on the free tier. `GET
   /v2/stocks/{symbol}/trades`, `page_token` pagination, trade obj `i`(id)+`x`(exch)+`t`(ns ts);
   dedupe key `i`+`x`+`t`. Order reconciliation is plain REST: `GET /v2/orders?status=closed`
   with `after`/`until` bracketing the gap — no websocket replay needed. Caveat: IEX is one
   venue, not consolidated tape (may miss off-IEX prints — acceptable for the POC).
5. **eve prod deploy: CONFIRMED.** Ordinary Vercel project; `eve build` emits Vercel Build Output
   when `VERCEL` is set; deploy via `vercel deploy` (**NOT `--prebuilt`**); framework auto-
   detected; custom channel routes → Nitro → Functions. Route-auth secrets must be **real Vercel
   env vars** (not baked into `.env.local`). Model creds: AI Gateway via OIDC (automatic on
   Vercel) or explicit keys. **Self-invoking wake loopback works UNLESS Deployment Protection is
   on → then attach `VERCEL_AUTOMATION_BYPASS_SECRET` to the wake POST.** Agent Runs tab exists
   but is gated (team enablement) — not a programmatic API, don't depend on it.
6. **Dashboard: DECIDED — Next.js as a Vercel Service.** No eve session-list API exists (grepped
   dist); track sessionIds in Redis (already do). Reuse eve's `defaultMessageReducer` (`eve/react`
   / `eve/client`) to render transcripts from `GET /eve/v1/session/:id/stream?startIndex=0`
   server-side — no hand-parsing. `withEve()` (`eve/next`) is the idiomatic same-project mount.
   eve ships a headless hook (`useEveAgent`) + reducer, NOT a prebuilt chat page — read-only =
   render with the reducer, never render a composer, never call `send`. Equity/positions/
   subscriptions/feed have no eve equivalent → custom Next.js over Redis + Alpaca account.
7. **Unbounded-workflow primitive: RESOLVED (gate7-research, 2026-07-12).** Full findings in
   `docs/architecture.md` ("How workflow@4.6.0 expresses 'forever'"). Short version: no
   `continueAsNew` — run-forever is **recursion across runs** (final step calls
   `start(sameWorkflow, [state])` and returns; per-run ceilings 25k events / 10k steps / 240s
   replay reset each run; chain before ~2,000 events). `sleep()` and run duration are unlimited.
   A ws-holding step is capped by the **Fluid function ceiling** (800s GA → ~12-min sessions;
   1800s beta for 25-min). Steps are stateless + retry from the top → through-write inside the
   step, idempotent writes, socket drop = graceful return not throw. Nitro/Vite adapters exist —
   no Next.js needed for the connector service. **Carry-over caveat: verify vercel/workflow
   issue #634 (sleep-resume failures) on a preview deploy early in Phase 2** — affects the EDGAR
   sleep(30s) sweep and campaign cadence; fall back to hook/`wakeUp()`-driven resumes if it
   reproduces.

Phase 0 outputs go into `docs/architecture.md`. Both topology forks are now decided (above); any
*new* fork that emerges mid-build STOPs and asks Philipp before committing (decision 5).

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
sleep or sorted-set sweep. catalog.json freshness stays honest either way. The Phase 1
delivery-recovery sweep migrates here too: its local setInterval driver is a stand-in (a frozen
Fluid instance never ticks) — move it onto the same durable primitive as expiry (flagged by the
Phase 1 Codex gate).

**Phase 4 — the mandate agent (the showcase's engine).**
- **Model: DeepSeek V4-Pro via Vercel AI Gateway** (Philipp's pick 2026-07-12: "latest DeepSeek…
  pro"; verified current — V4 shipped ~Apr 2026; V4-Pro is the high-capability/agentic tier
  positioned for multi-step reasoning + tool use, 1.6T/49B-active, tool calls + reasoning +
  implicit caching. Pricier than V4-Flash but still cheap, and cost is explicitly not a
  constraint here — Pro chosen for better trade quality on the public page). eve reaches it
  through AI Gateway (OIDC, automatic on Vercel — no direct DeepSeek key in prod; local dev needs
  `AI_GATEWAY_API_KEY`). Gateway model id `deepseek/deepseek-v4-pro`. **GOTCHA: use the explicit
  `deepseek-v4-pro` id, NOT the legacy `deepseek-chat`/`deepseek-reasoner` aliases — those
  deprecate 2026-07-24 and would break the campaign mid-run.** Bonus for the pitch: a DeepSeek
  agent on AI Gateway is itself a Gateway-breadth story for Pranay.
- **Sell capability**: extend the order tools to position-bounded selling (market sell of held
  quantities only — no shorting, no margin; paper host stays hard-coded). This is a
  capability-bounds change: red-green tests + Codex gate scrutiny on the bounds.
- **Campaign guardrails — minimal (confirmed 2026-07-12: "it's paper, keep it light"; cost is
  explicitly not a constraint).** The remaining cap is purely **runaway/loop protection** (a
  per-day turn ceiling so a stuck tool-loop can't spin forever), NOT a cost cap — keep it small
  and env-configurable. The paper host + fully-
  autonomous open mandate are the intended posture, so do NOT add per-trade notional caps,
  max-trades-per-day, or max-concurrent-subscription limits as hard structural blockers — they
  constrain the very autonomy that's the showcase. Keep the existing paper-only / buy-side /
  market / day-order bounds that already exist (those are correctness, not judgment). Sell stays
  position-bounded (below).
- **Instructions rewrite** for the standing mandate: manage the paper portfolio via events —
  research, pick watches (price crossings both directions now meaningful, EDGAR filings as
  signals), size positions, realize P&L, always leave a subscription armed (the campaign must
  never dead-end with nothing watched). Keep the identity-only prompt discipline from task #10.
  **Seed wording, validated live 2026-07-13 (campaign-launch-1, approved by Philipp):** "your
  standing goal is to grow this account — make (paper) money … research what is worth watching,
  subscribe to the events that would tell you when to act (price crossings both directions,
  filings), and trade when you have a reason … never end a turn with nothing armed." The agent's
  acknowledged plan (bearings → research → subscribe broadly → trade selectively → re-arm) is
  the campaign loop in its own words; note it independently identified buy-without-sell as a
  one-way ratchet and chose conservative sizing — instructions should preserve that instinct.
- **Web search — RESEARCHED 2026-07-13 (Gateway docs verified; supersedes the earlier fallback
  ladder).** Facts: (1) AI Gateway ships **model-agnostic search tools** —
  `gateway.tools.perplexitySearch()/exaSearch()/parallelSearch()` — executed by the Gateway
  itself, work with ANY model incl. DeepSeek, $5–7/1k searches billed via Vercel
  ([docs](https://vercel.com/docs/ai-gateway/models-and-providers/web-search)). (2) OpenAI's
  native search works through the Gateway on OpenAI models (`openai.tools.webSearch({})`).
  (3) DeepSeek's own native search (its Anthropic-compatible endpoint) is NOT exposed through
  the Gateway. (4) All of it requires **paid Gateway credits** — the team is currently free-tier
  (probe 2026-07-13: gpt-5.6-terra refused with "Free tier users do not have access"; raw
  `{"type":"web_search"}` on /v1/responses was silently ignored for Sonnet — the documented
  wiring is AI SDK tool definitions, which matches how eve calls models). **HEAD-TO-HEAD PROBED
  2026-07-13 after Philipp topped up $14 Gateway credit — BOTH paths work**, same correct cited
  answer (S&P 500 7,575.39 on 2026-07-10): (A) DeepSeek V4-Pro + `gateway.tools.parallelSearch`
  (1 search, Yahoo+Investing citations, richer detail) and (B) gpt-5.6-terra + OpenAI native
  `web_search` (2 searches, AP citation). DECISION AT PHASE 4 KICKOFF (Philipp's): A keeps the
  locked model pick and cheaper tokens; B is his search-quality lean. Either way: no Tavily, no
  new vendor; the eve-side work is one defineTool override.
- **Campaign lifecycle**: an eve schedule (agent/schedules/) opens the market day — wakes the
  campaign conversation with a "market's open, review and act" turn; the event catalog does the
  intraday waking. Decide in design: one perpetual conversation vs daily conversations linked by
  a Redis-stored campaign summary (context growth over weeks says: daily conversations +
  carried-forward summary; the site threads them into one campaign view).

**Phase 5 — public observatory.** Hosting per Phase 0. **UI base (Philipp, 2026-07-13): evaluate
[vercel/chatbot](https://github.com/vercel/chatbot) as the starting point ONLY if it reduces
work** — it is chat-first (composer, auth, its own persistence) versus our read-only transcript
replay, so the likely value is its message-rendering components and styling, not its skeleton.
Decide with a short time-boxed spike at Phase 5 kickoff, not by default. Pages: (a) campaign
view: equity curve +
positions + realized P&L over time (Alpaca account history; load the dataviz skill for charts),
(b) subscriptions table (live lifecycle from Redis), (c) event feed (wakes/arms/fires/expiries
with timestamps + elapsed times), (d) conversation/decision view (transcripts via
conversationId→sessionId map + eve session stream replay), threaded into the campaign timeline.
Read-only; no secrets rendered; rate limiting if trivially available. This is the demo's public
face — presentation quality matters (the audience is a Vercel engineer).

**Phase 6 — production deploy + cloud E2E + campaign launch.** Promote env vars to production
(incl. new secret: CATALOG_API_SECRET; TAVILY_API_KEY only if the Phase 4 web_search fallback was needed), deploy, re-verify KNOWN_ISSUES #7 on
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
