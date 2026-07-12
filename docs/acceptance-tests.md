# Acceptance Tests — Event Catalog POC

Manual test scripts, one per milestone. Each milestone is done only when its checklist passes.
Run everything from the repo root. You need two terminals: **T1** runs the dev server (`pnpm dev`),
**T2** runs the curl commands. `jq` recommended.

## Prerequisites

- Node ≥ 24, pnpm.
- `.env` populated (see `.env.example`): Alpaca paper keys, `EDGAR_USER_AGENT`, LangSmith keys, AI Gateway key.
- AT-4 through AT-7 need **US market hours** (9:30–16:00 ET, Mon–Fri) — live IEX ticks only flow then.
- The Alpaca account is a **paper** account. Verify: base URL in code is `paper-api.alpaca.markets`. No test in this document may ever place a real-money order.

Conventions used below (eve dev serves on **port 2000**):

```bash
CHAT()  { curl -s -X POST localhost:2000/catalog/chat -H 'content-type: application/json' -d "$1"; }
SUBS()  { curl -s localhost:2000/catalog/subscriptions | jq .; }
STREAM(){ curl -sN localhost:2000/catalog/sessions/$1/stream; }
```

⚠️ `eve dev` hot-reloads whenever `.env.local` changes, wiping in-process state (the subscription
registry and any live watchers). Do not touch `.env.local` while tests are running. The
`VERCEL_OIDC_TOKEN` expires after ~12h — refresh with `vercel env pull` BEFORE a test session,
never during one.

---

## AT-1 — Scaffold boots

**Covers:** task 1 (eve scaffold).

1. [ ] `pnpm install` completes without errors; `package.json` pins an exact `eve` version (no `^`/`~`).
2. [ ] `pnpm dev` starts the dev server on port 2000.
3. [ ] `curl -s localhost:2000/eve/v1/health` returns a healthy response.
4. [ ] Create a session on the built-in channel and get a model reply (proves model/AI-Gateway wiring):
       `curl -s -X POST localhost:2000/eve/v1/session -H 'content-type: application/json' -d '{"message":"Say hello in one word."}'`
       A coherent reply arrives (via response or stream).
5. [ ] `docs/prd-draft.md` and this file are untouched by the scaffold.

## AT-2 — Wake loop on the catalog channel

**Covers:** task 2 (the load-bearing mechanism: park + external wake).

1. [ ] Start a conversation:
       `CHAT '{"conversationId":"demo-1","message":"Reply with the word READY and nothing else."}'`
       Response identifies a session (id visible in response or via logs). Stream shows the reply; the turn ends.
2. [ ] Wake the parked session from outside:
       `curl -s -X POST localhost:3000/catalog/wake -H 'content-type: application/json' -d '{"conversationId":"demo-1","payload":{"note":"synthetic wake"}}'`
3. [ ] The **same session** resumes (session id in wake response/logs matches step 1 — no new session was created) and the agent produces a new turn that references the payload.
4. [ ] **Wake-awareness**: the resumed turn shows the agent knows (a) it was woken by the Event Catalog, not addressed by the user — it does not answer the payload as if the human had typed it — and (b) that time has passed: the wake message carries `subscribedAt`/`firedAt`, and with a synthetic wake sent ≥2 minutes after step 1 the agent's reply reflects the elapsed time (e.g., "about 2 minutes after I started waiting…") rather than treating it as instantaneous. Test both: a wake seconds later and a wake minutes later.
5. [ ] Sending a wake for an unknown conversation id fails visibly (error response + log line), and does NOT silently create a fresh session.
6. [ ] ~~Approval round-trip~~ — RETIRED 2026-07-12: approvals were removed for full autonomy (the mechanism was verified working in the original task-2 run; eve's gate is one line to restore).
7. [ ] Every step above produced exactly one structured `[catalog]` log line per action (chat, wake, mismatch failure), each carrying the conversation id.

## AT-3 — Discover, subscribe, lifecycle, expiry

**Covers:** tasks 3 + 5 (catalog core + tools), without needing a live price cross.

1. [ ] `SUBS` on a fresh server returns an empty list.
2. [ ] `CHAT '{"conversationId":"demo-2","message":"Wake me when NVDA drops below $1. Set the subscription to expire in 3 minutes."}'`
       — the stream shows the agent calling `search_events` then `subscribe_event`; its reply names the provider (alpaca), the event type (`price.crossesBelow`), and says it will wait.
3. [ ] `search_events` results (visible in stream/tool output) include provider metadata — freshness, latency, auth, cost — not just the event name.
3a. [ ] **The catalog is declarative**: `catalog/catalog.json` holds all event-type entries (description, JSON-Schema params, provider metadata); search results trace back to it verbatim. Entries whose provider isn't built yet are marked `"status": "planned"` and labeled as such in search results. Boot honesty check: temporarily add a fake implemented entry (`"provider": "alpaca", "event": "price.doesNotExist"`) to catalog.json → the server refuses to boot with a clear error; remove it → boots clean.
3a2. [ ] **Wakes carry their manual**: every event entry in `catalog.json` has an `onWake` field (prompt-shaped handling guidance); wake messages include the subscribed event's `onWake` text alongside the envelope, and `search_events` results show it at discovery time. The guidance in the wake message comes verbatim from `catalog.json` — never from the event payload (trusted-source boundary).
3b. [ ] **The declared schemas are binding**: `pnpm test` includes green tests showing subscribe() rejects params that violate the entry's JSON Schema (e.g. `price` as a string) with an error naming the field, and accepts valid params. The rejection happens at tool-call time (inside the turn), not at arm time.
4. [ ] Immediately after the reply, `SUBS` shows the subscription with status `armed` (it was `pending` during the turn; `armed` only after the turn completed), with created/armed timestamps and the predicate (`NVDA`, `1`, expiry).
5. [ ] $1 is never crossed, so after ~3 minutes the **expiry wake** fires: the session resumes with `reason: "expired"`, and the agent closes the loop conversationally ("NVDA never fell below $1…").
6. [ ] `SUBS` now shows the subscription status `expired`, and the timer is gone (no further wakes; nothing fires later).
7. [ ] Restart `pnpm dev`. `SUBS` is empty again (in-memory registry; documented behavior, not a bug).

## AT-4 — Price fire: test stream (any time) + live (market hours)

**Covers:** task 4 (Alpaca provider, edge-triggered semantics).

1. [ ] Edge-semantics script check (no market needed): run the provided script (`pnpm test:edge` or as documented in README) — synthetic ticks `150.2 → 149.8` against `crossesBelow 150` fire **exactly once**; ticks `149.8 → 149.5` (already below at seed) fire **zero** times.
1a. [ ] **Test-stream pipeline check (works 24/7)**: with `ALPACA_DATA_FEED=test`, subscribe to a `FAKEPACA` price cross → verify the pipeline through ws connect → auth → subscribe → seed → armed, with ticks flowing in the logs. ⚠️ Observed reality (2026-07-12, two independent checks): FAKEPACA prints a **flat** price (134.56), and edge-triggered crossings cannot fire on a flat line — so the fire leg is NOT expected here. Verify the fire leg off-hours via a short-expiry wake instead; the genuine tick-cross → wake fire is step 5's live IEX check during market hours. (If Alpaca's test feed ever starts varying, a cross near its printing price should fire exactly once through this same pipeline.)
2. [ ] Get the current NVDA price:
       `curl -s "https://data.alpaca.markets/v2/stocks/NVDA/trades/latest?feed=iex" -H "APCA-API-KEY-ID: $ALPACA_API_KEY_ID" -H "APCA-API-SECRET-KEY: $ALPACA_API_SECRET_KEY" | jq .trade.p`
3. [ ] `CHAT` (new conversation `demo-3`): *"Wake me when NVDA drops below $\<current − 0.1%\>. Don't buy anything, just tell me."*
4. [ ] Server logs show, in order: ws connect → auth ok → subscribe NVDA → seeded previous price from REST → sub `armed`.
5. [ ] When NVDA crosses the threshold (usually within minutes for −0.1%): exactly **one** wake. Logs show `armed → delivering → fired`. The agent's resumed turn quotes the trigger price and `firedAt`.
6. [ ] After firing, ticks keep flowing but the once-subscription never fires again (`SUBS`: `fired`, no repeat wakes).

## AT-5 — Autonomous paper trade + fill wake (market hours)

**Covers:** task 5 tools end-to-end (order path). *(Rewritten 2026-07-12: human approval removed — full autonomy by explicit decision; safety is capability-bounded: paper host hard-coded, notional/buy-side/market/day only, agent instructions cap at the stated amount.)*

1. [ ] `CHAT` (new conversation): *"Buy $100 of NVDA at market, right now."*
2. [ ] The agent checks account first (`get_account` visible in stream), then calls `submit_order` — **no approval pause, no `input.requested` event in the stream**; the order goes straight to Alpaca paper.
3. [ ] Mandate cap: ask it to buy an amount exceeding buying power, or phrase a $100 mandate and watch it never exceed it — the agent declines/caps by its own judgment (instructions), not by a gate.
4. [ ] Order submitted; agent reports order id; the `order.filled` subscription appears in `SUBS`; session parks.
5. [ ] Within seconds (market order), the fill wake arrives; agent reports fill price and quantity. Alpaca paper dashboard shows the filled $100 notional NVDA order.

## AT-6 — Observability

**Covers:** task 6 (LangSmith) + catalog logging as a whole.

1. [ ] The full AT-5 run appears in LangSmith (project = `$LANGSMITH_PROJECT`) with model calls and tool calls visible as spans.
2. [ ] Reading only the server console, a newcomer can reconstruct the story: every catalog line carries `conversationId`, `subscriptionId`, event, status transition, and timestamps; ws lifecycle (connect/auth/subscribe/close) is logged.
3. [ ] `SUBS` at any moment reflects reality (statuses, lastError on failures).

## AT-7 — The demo (PRD success metric), twice

**Covers:** task 7. This is the sentence the POC exists for.

1. [ ] One command visible to the audience: `CHAT` *"Buy $100 of NVDA if it falls below $\<slightly below current\> today."*
2. [ ] Without further input: search → subscribe → agent says it's waiting → session parks (server could even be observed idle).
3. [ ] Price crosses → wake → stream shows the agent **re-fetching the quote and re-checking the predicate** before acting (visible tool calls).
4. [ ] Paper trade submitted autonomously (no approval pause) → agent parks again on `order.filled` → fill wake → final plain-language report (what it bought, at what price, vs. the trigger price).
5. [ ] `SUBS` shows both subscriptions' full lifecycle; LangSmith shows the whole run.
6. [ ] **Run the entire flow a second time, fresh conversation. It must pass again with no manual fixes in between.**

## AT-8 — EDGAR provider

**Covers:** task 8 (the poll-based provider; proves push+poll heterogeneity).

1. [ ] `CHAT`: *"Wake me when Apple files an 8-K."* → agent discovers `edgar` / `filing.new` via search (metadata shows freshness ≈ minutes, cost free) and subscribes; `SUBS` shows it `armed`.
2. [ ] Logs show a poll of `data.sec.gov/submissions/CIK0000320193.json` every ~30s with the configured `EDGAR_USER_AGENT`, and no more than that (rate-limit friendly).
3. [ ] Forced fire (filings are rare): restart with the documented seen-set seeding trick (seed minus the most recent accession) → one wake fires; the agent reports the filing (form type, accession number, date) conversationally.
4. [ ] Both providers coexist: an alpaca price subscription and the edgar subscription can be armed at the same time and neither interferes with the other.

## AT-9 — README is sufficient

**Covers:** task 9.

1. [ ] A tester who has NOT read this file or the plan can go from `git clone` to passing AT-7 using only `README.md` (env setup, market-hours caveat, threshold guidance, curl commands).
2. [ ] README states the runtime boundary plainly: eve sessions are durable; catalog watchers are in-process and local-only; restart = re-subscribe.

---

# Production phase (plan: `docs/plan-vercel-production.md`)

AT-10…AT-14 are the acceptance criteria for the everything-on-Vercel build, **authored before the
build** (tests-before-build applies to acceptance criteria). Additional prerequisites: Vercel Pro
project, `CATALOG_API_SECRET` (new), `TAVILY_API_KEY` (new), `AI_GATEWAY_API_KEY` (local dev
only — prod uses AI Gateway OIDC). Where a step says "test suite covers it", the referenced
red-green node:test tests must exist and be green in `pnpm test` — the checkbox is the manual
spot-check on top.

Auth convention from AT-10 on: `CHAT()` and wake POSTs carry
`-H "authorization: Bearer $CATALOG_API_SECRET"`. Read-only GETs never need it.

## AT-10 — Delivery backbone (Phase 1)

**Covers:** cloud-safe delivery semantics (correctness prereq 4), event history, route auth —
all verified locally before anything moves to Vercel.

1. [ ] **Event history stream**: run AT-3 (subscribe → expiry). `curl -s localhost:2000/catalog/events | jq .`
       returns an append-only history in which that subscription's `armed → delivering →
       expired`/wake transitions all appear, each with timestamps, `subscriptionId`, and
       `conversationId`. Nothing in the response requires auth; nothing in it contains secrets.
2. [ ] **Claims are leases, not memory**: test suite covers crash-between-claim-and-publish —
       a subscription stuck in `delivering` whose lease has expired is picked up by the recovery
       sweep and the wake still arrives, exactly once. Manual spot-check: kill the dev server
       mid-delivery (or use the test's documented simulation), restart, watch the sweep log line
       recover it.
3. [ ] **Idempotent delivery**: test suite covers duplicate publish — two deliveries for the
       same `subscriptionId` produce exactly one wake (dedupe on the one-shot subscription id).
4. [ ] **Write routes are closed**: `POST /catalog/chat` and `POST /catalog/wake` without the
       bearer secret → 401 (structured error + log line, no session touched). With the secret →
       behave exactly as before. `GET /catalog/subscriptions` and `GET /catalog/events` work with
       no auth.
5. [ ] **Queues-from-Nitro smoke test**: `@vercel/queue` `send()` from a Nitro route and a
       `handleCallback()` consumer round-trip a message locally (`vercel dev` or the documented
       harness). Result (works / caveats) recorded in `docs/architecture.md` — this de-risks the
       delivery topology before Phase 2 builds on it.
6. [ ] **No regressions**: full `pnpm test` green; AT-2 and AT-3 pass unchanged except for the
       auth header.

## AT-11 — Connector runtime (Phase 2)

**Covers:** correctness prereqs 1–3 on the extracted watcher tier (Vercel Service, chained
socket sessions). Runnable locally (same runtime in-process) except where marked.

1. [ ] **Gap replay, canonical case** (test suite): threshold 150 `crossesBelow`, prev 151;
       the connection gap contains trades 149 → 151 (crossed and recovered before reconnect).
       On reconnect, historical trades are fetched from the persisted per-symbol cursor, merged
       with buffered live trades in source order, deduped by `i`+`x`+`t`, and replayed through
       the predicate — the wake fires, exactly once. The mirror case (no cross inside the gap)
       fires zero times.
2. [ ] **Cursor persistence**: after any processed trade, the per-symbol cursor (trade id +
       timestamp) is visible in Redis; a restarted session resumes from it (log line shows the
       replay window), never from "now".
3. [ ] **Fenced leases / zombie test** (test suite): a watcher holding an expired lease (stale
       fencing token) attempts a delivery/state write → rejected and logged; the current
       leaseholder is unaffected. Exactly one watcher per stream holds the lease at any time.
4. [ ] **Dynamic membership**: with a socket session already running, arm a subscription for a
       new symbol → it is being watched within the membership cadence (~15s; log shows the
       stream subscribe). Cancel/expire the last subscription on a symbol → the symbol is
       dropped from the stream within the same cadence.
5. [ ] **Order reconciliation across a gap**: an order that fills while the trade_updates
       session is down is reconciled on reconnect via REST closed-orders bracketing
       (`after`/`until`) and produces its fill wake, exactly once (test suite; manual variant
       needs market hours).
6. [ ] **One code path, two hosts**: `pnpm dev` still runs the full watcher tier in-process;
       AT-4 step 1a (FAKEPACA pipeline) passes unchanged. No eve imports anywhere in the
       watcher path (verified by a grep the test suite encodes).

## AT-12 — Mandate agent (Phase 4)

**Covers:** sell capability bounds, minimal guardrails, the standing-mandate rewrite.

1. [ ] **Sell is position-bounded** (test suite, red-green): selling more than the held quantity
       is rejected at the tool layer with an error naming the bound; selling a symbol with no
       position (shorting) is rejected; a valid sell of ≤ held quantity goes through. The paper
       host remains hard-coded — no real-money endpoint appears anywhere (grep).
2. [ ] **Runaway cap** (test suite): the per-day turn ceiling is enforced in code and
       env-configurable; the turn over the ceiling is refused with a visible log line, and the
       cap resets the next day. No other structural limits exist (no notional / trades-per-day /
       max-subscription blockers — deliberate; see plan).
3. [ ] **Model pin**: the configured model id is `deepseek/deepseek-v4-pro` via AI Gateway;
       `deepseek-chat` / `deepseek-reasoner` appear nowhere in code or env (they deprecate
       2026-07-24 and would break the campaign mid-run).
4. [ ] **Research tool**: ask the agent (private chat) to evaluate a trade idea — the stream
       shows a Tavily search call before any order; the tool returns real results.
5. [ ] **The campaign never dead-ends**: after any completed campaign turn, at least one
       subscription is armed. Test both paths: (a) agent behavior — a turn in which everything
       fired/expired ends with the agent arming something new; (b) the market-open schedule
       wakes the campaign conversation, so even a fully idle overnight state gets a turn every
       trading day. `SUBS` after each check shows ≥1 `armed`.
6. [ ] **Mandate holds without a human**: a full simulated cycle — open-schedule wake → research
       → subscribe → park → (synthetic or real) event wake → trade decision → fill wake — runs
       with zero human input, and every decision is visible in the stream/LangSmith.

## AT-13 — Public observatory (Phase 5)

**Covers:** the public read-only site. The audience is a Vercel engineer; presentation counts.

1. [ ] **Read-only by construction**: the site renders no composer and exposes no mutation
       route; browsing every page fires no authenticated/write request (check the network tab);
       no secret appears in HTML, JS bundles, or API responses.
2. [ ] **Campaign view is truthful**: equity curve, positions, and realized P&L match the
       Alpaca paper account (spot-check numbers against the Alpaca dashboard at the same
       moment).
3. [ ] **Subscriptions table is live**: it matches `GET /catalog/subscriptions` (statuses,
       predicates, timestamps), and a lifecycle transition (e.g. an expiry) appears without a
       redeploy.
4. [ ] **Event feed**: wakes/arms/fires/expiries/failures from the event-history stream render
       with timestamps and elapsed times (subscribed → fired), newest first.
5. [ ] **Transcripts — "see it think"**: a conversation view renders the full transcript
       (agent reasoning, tool calls, wake envelopes) via eve's `defaultMessageReducer` over the
       session stream replay, threaded into the campaign timeline.
6. [ ] **A live wake end-to-end on the site**: subscribe (private chat) → event fires → the wake,
       the resumed turn, and any resulting order all become visible on the public site with no
       manual intervention.

## AT-14 — Cloud E2E + campaign launch (Phase 6)

**Covers:** production deploy, the world-vercel re-verification, and the launch bar. All steps
run against the deployed Vercel project, not localhost.

1. [ ] **KNOWN_ISSUES #7 on world-vercel (hard gate)**: on a real preview deploy, a wake that
       races turn-end (sent while the arming turn is still streaming) is buffered and delivered
       after park — not lost, not duplicated. Run the race repeatedly (≥5×). Arming is not
       trusted in prod until this passes.
2. [ ] **Deployment plumbing**: deployed via `vercel deploy` (not `--prebuilt`); all three
       services up; secrets are real Vercel env vars; wake loopback works (with
       `VERCEL_AUTOMATION_BYPASS_SECRET` if Deployment Protection is on); private bindings — the
       connector reaches eve's wake route without a public hop.
3. [ ] **Cloud E2E during market hours**: subscribe → park → real price cross → wake →
       autonomous trade → fill wake — with every stage visible on the public observatory.
       **Twice, fresh conversations, no manual fixes between runs.**
4. [ ] **One full unattended market day**: the standing campaign runs open→close with zero human
       intervention; the turn cap is never hit by accident (or if hit, correctly — logged);
       the feed and transcripts populate; the day ends with ≥1 armed subscription.
5. [ ] **Docs close the loop**: README + `docs/architecture.md` updated — the "watcher tier is
       local-only" boundary is gone, replaced by the deployed topology; only then does the link
       go out.
