# Acceptance Tests — Event Catalog POC

Manual test scripts, one per milestone. Each milestone is done only when its checklist passes.
Run everything from the repo root. You need two terminals: **T1** runs the dev server (`pnpm dev`),
**T2** runs the curl commands. `jq` recommended.

## Prerequisites

- Node ≥ 24, pnpm.
- `.env` populated (see `.env.example`): Alpaca paper keys, `EDGAR_USER_AGENT`, LangSmith keys, AI Gateway key.
- AT-4 through AT-7 need **US market hours** (9:30–16:00 ET, Mon–Fri) — live IEX ticks only flow then.
- The Alpaca account is a **paper** account. Verify: base URL in code is `paper-api.alpaca.markets`. No test in this document may ever place a real-money order.

Conventions used below:

```bash
CHAT()  { curl -s -X POST localhost:3000/catalog/chat -H 'content-type: application/json' -d "$1"; }
SUBS()  { curl -s localhost:3000/catalog/subscriptions | jq .; }
STREAM(){ curl -sN localhost:3000/catalog/sessions/$1/stream; }
```

---

## AT-1 — Scaffold boots

**Covers:** task 1 (eve scaffold).

1. [ ] `pnpm install` completes without errors; `package.json` pins an exact `eve` version (no `^`/`~`).
2. [ ] `pnpm dev` starts the dev server; note the port (expected 3000 — if different, adjust all commands).
3. [ ] `curl -s localhost:3000/eve/v1/health` returns a healthy response.
4. [ ] Create a session on the built-in channel and get a model reply (proves model/AI-Gateway wiring):
       `curl -s -X POST localhost:3000/eve/v1/session -H 'content-type: application/json' -d '{"message":"Say hello in one word."}'`
       A coherent reply arrives (via response or stream).
5. [ ] `docs/prd-draft.md` and this file are untouched by the scaffold.

## AT-2 — Wake loop on the catalog channel

**Covers:** task 2 (the load-bearing mechanism: park + external wake + approval round-trip).

1. [ ] Start a conversation:
       `CHAT '{"conversationId":"demo-1","message":"Reply with the word READY and nothing else."}'`
       Response identifies a session (id visible in response or via logs). Stream shows the reply; the turn ends.
2. [ ] Wake the parked session from outside:
       `curl -s -X POST localhost:3000/catalog/wake -H 'content-type: application/json' -d '{"conversationId":"demo-1","payload":{"note":"synthetic wake"}}'`
3. [ ] The **same session** resumes (session id in wake response/logs matches step 1 — no new session was created) and the agent produces a new turn that references the payload.
4. [ ] **Wake-awareness**: the resumed turn shows the agent knows (a) it was woken by the Event Catalog, not addressed by the user — it does not answer the payload as if the human had typed it — and (b) that time has passed: the wake message carries `subscribedAt`/`firedAt`, and with a synthetic wake sent ≥2 minutes after step 1 the agent's reply reflects the elapsed time (e.g., "about 2 minutes after I started waiting…") rather than treating it as instantaneous. Test both: a wake seconds later and a wake minutes later.
5. [ ] Sending a wake for an unknown conversation id fails visibly (error response + log line), and does NOT silently create a fresh session.
6. [ ] Approval round-trip: trigger any approval-gated test tool through `demo-1`; the stream shows an approval request; deliver the approval decision back through the catalog channel; the tool executes and the agent reports its result.
7. [ ] Every step above produced exactly one structured `[catalog]` log line per action (chat, wake, mismatch failure), each carrying the conversation id.

## AT-3 — Discover, subscribe, lifecycle, expiry

**Covers:** tasks 3 + 5 (catalog core + tools), without needing a live price cross.

1. [ ] `SUBS` on a fresh server returns an empty list.
2. [ ] `CHAT '{"conversationId":"demo-2","message":"Wake me when NVDA drops below $1. Set the subscription to expire in 3 minutes."}'`
       — the stream shows the agent calling `search_events` then `subscribe_event`; its reply names the provider (alpaca), the event type (`price.crossesBelow`), and says it will wait.
3. [ ] `search_events` results (visible in stream/tool output) include provider metadata — freshness, latency, auth, cost — not just the event name.
4. [ ] Immediately after the reply, `SUBS` shows the subscription with status `armed` (it was `pending` during the turn; `armed` only after the turn completed), with created/armed timestamps and the predicate (`NVDA`, `1`, expiry).
5. [ ] $1 is never crossed, so after ~3 minutes the **expiry wake** fires: the session resumes with `reason: "expired"`, and the agent closes the loop conversationally ("NVDA never fell below $1…").
6. [ ] `SUBS` now shows the subscription status `expired`, and the timer is gone (no further wakes; nothing fires later).
7. [ ] Restart `pnpm dev`. `SUBS` is empty again (in-memory registry; documented behavior, not a bug).

## AT-4 — Live price fire (market hours)

**Covers:** task 4 (Alpaca provider, edge-triggered semantics).

1. [ ] Edge-semantics script check (no market needed): run the provided script (`pnpm test:edge` or as documented in README) — synthetic ticks `150.2 → 149.8` against `crossesBelow 150` fire **exactly once**; ticks `149.8 → 149.5` (already below at seed) fire **zero** times.
2. [ ] Get the current NVDA price:
       `curl -s "https://data.alpaca.markets/v2/stocks/NVDA/trades/latest?feed=iex" -H "APCA-API-KEY-ID: $ALPACA_API_KEY_ID" -H "APCA-API-SECRET-KEY: $ALPACA_API_SECRET_KEY" | jq .trade.p`
3. [ ] `CHAT` (new conversation `demo-3`): *"Wake me when NVDA drops below $\<current − 0.1%\>. Don't buy anything, just tell me."*
4. [ ] Server logs show, in order: ws connect → auth ok → subscribe NVDA → seeded previous price from REST → sub `armed`.
5. [ ] When NVDA crosses the threshold (usually within minutes for −0.1%): exactly **one** wake. Logs show `armed → delivering → fired`. The agent's resumed turn quotes the trigger price and `firedAt`.
6. [ ] After firing, ticks keep flowing but the once-subscription never fires again (`SUBS`: `fired`, no repeat wakes).

## AT-5 — Approved paper trade + fill wake (market hours)

**Covers:** task 5 tools end-to-end (order path).

1. [ ] `CHAT` (new conversation): *"Buy $100 of NVDA at market, right now."*
2. [ ] The agent checks account first (`get_account` visible in stream), then calls `submit_order` — which **parks on approval**; nothing is submitted to Alpaca yet (verify: no new order in Alpaca dashboard).
3. [ ] Decline path: answer the approval with a rejection → agent reports it did NOT trade; Alpaca dashboard shows no order. (Run this once — it's the safety-relevant path.)
4. [ ] Repeat, approve this time → order submitted; agent reports order id; the `order.filled` subscription appears in `SUBS`; session parks.
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
3. [ ] Price crosses → wake → stream shows the agent **re-fetching the quote and re-checking the predicate** before acting (visible tool calls), then requesting approval.
4. [ ] Human approves → paper trade submitted → agent parks again on `order.filled` → fill wake → final plain-language report (what it bought, at what price, vs. the trigger price).
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

1. [ ] A tester who has NOT read this file or the plan can go from `git clone` to passing AT-7 using only `README.md` (env setup, market-hours caveat, threshold guidance, curl commands, approval instructions).
2. [ ] README states the runtime boundary plainly: eve sessions are durable; catalog watchers are in-process and local-only; restart = re-subscribe.
