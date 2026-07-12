# Event Catalog

**Connections are how agents call the world; the Event Catalog is how the world calls back.**

AI agents are excellent at reacting *now* and terrible at reacting *later*. This POC gives an
[eve](https://eve.dev) agent the missing primitive: **"wake me when X becomes true."** The agent
discovers event sources it knows nothing about, subscribes with typed predicates, suspends
(durably, at zero compute), and is resumed by the catalog when the event fires — interrupts for
AI agents. The vertical slice is agentic trading: Alpaca paper trading + SEC EDGAR filings.

The demo sentence the whole system exists for:

> *"Buy $100 of NVDA if it falls below $150 today."*

The agent finds the right event source in the catalog, subscribes, parks, wakes on the price
cross, re-checks reality, asks a human for approval, paper-trades, parks again, and reports the
fill — without a single polling loop in agent code.

## System architecture

```mermaid
flowchart TB
    User(["User / curl"])

    subgraph app["eve app — local dev server :2000"]
        subgraph channel["catalog channel (owns conversations)"]
            CHAT["POST /catalog/chat"]
            WAKE["POST /catalog/wake"]
            SUBS["GET /catalog/subscriptions"]
        end

        subgraph agent["Trading agent — durable eve session"]
            LLM["model turn"]
            TOOLS["tools: search_events · subscribe_event ·<br/>get_latest_price · get_account · submit_order (approval)"]
        end

        subgraph catalog["Event Catalog (in-process library)"]
            CJ[["catalog.json<br/>event types · JSON Schemas · onWake guidance"]]
            REG["registry — subscription lifecycle"]
            WK["wake — delivery · expiry timers ·<br/>guidance resolution"]
            ALP["alpaca provider<br/>(push: 2 websockets)"]
            EDG["edgar provider<br/>(poll: 30s per CIK, coalesced)"]
        end
    end

    REDIS[("Upstash Redis")]
    MDATA["Alpaca market data ws<br/>(IEX / FAKEPACA test)"]
    TUPD["Alpaca trade_updates ws"]
    PAPER["Alpaca paper REST"]
    SEC["SEC EDGAR<br/>data.sec.gov"]
    LS["LangSmith (OTel traces)"]

    User -->|"message"| CHAT
    CHAT -->|"send(continuationToken)"| LLM
    LLM --> TOOLS
    TOOLS -->|"search / subscribe"| CJ
    TOOLS --> REG
    TOOLS -->|"quote · account · order"| PAPER
    REG <--> REDIS
    ALP <-->|ticks| MDATA
    ALP <-->|"order events"| TUPD
    ALP -->|"seed at arm"| PAPER
    EDG -->|"poll + diff"| SEC
    ALP -->|"predicate fired"| WK
    EDG -->|"new filing"| WK
    WK -->|"loopback POST"| WAKE
    WAKE -->|"send() resumes parked session"| LLM
    agent -.->|"spans"| LS
    User -->|"inspect"| SUBS
```

Key moves, bottom to top:

- **The catalog is a JSON file.** `catalog/catalog.json` declares every event type: a
  model-facing description, a JSON Schema for its parameters (enforced with Ajv at subscribe
  time — the schema the model reads during discovery is the one that validates its input), honest
  provider metadata (freshness, latency, auth, cost, durability), and `onWake` — prompt-shaped
  handling guidance delivered back to the agent when the event fires. A boot-time honesty check
  refuses to advertise anything without a registered handler.
- **Providers watch the world so agents don't.** Push when the source offers it (Alpaca: one
  shared market-data websocket, one account-level `trade_updates` stream), coalesced polling when
  it doesn't (EDGAR: one 30s poll loop per watched company, regardless of subscriber count).
  REST is only for *seeding* state at arm time.
- **The wake is the primitive.** eve sessions are durable workflows that park between turns. The
  catalog channel owns each conversation's continuation token, so waking an agent is one `send()`
  on that token — same session, full memory, plus an envelope that makes time-passage explicit.

## The demo flow

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant CH as catalog channel
    participant A as Agent (eve session)
    participant C as Event Catalog
    participant P as alpaca provider
    participant X as Alpaca APIs

    U->>CH: "Buy $100 of NVDA if it falls below $150 today"
    CH->>A: send(continuationToken) — turn starts
    A->>C: search_events("price drops below")
    C-->>A: price.crossesBelow + schema + metadata + onWake
    A->>C: subscribe_event(NVDA, threshold 150, expires EOD)
    C-->>A: subscription "pending"
    A-->>U: "I'll wait." — turn ends
    Note over A: session parks (durable, zero compute)
    CH->>C: turn.completed → arm pending subs
    C->>P: arm(sub)
    P->>X: seed prev price (REST) + stream ticks (ws)
    X-->>P: tick 149.87 — crossed below!
    P->>C: deliverWake (claim → delivering)
    C->>CH: POST /catalog/wake {subscriptionId, reason}
    CH->>A: send() — wake message (envelope + onWake guidance)
    Note over A: same session resumes
    A->>X: get_latest_price + get_account (rehydrate, re-check predicate)
    A-->>U: approval request: buy $100 NVDA?
    U->>CH: "approve"
    CH->>A: send("approve") — resolves approval
    A->>X: submit_order (paper, notional $100)
    A->>C: subscribe_event(order.filled, orderId)
    A-->>U: "Order placed, waiting for fill." — parks again
    X-->>P: trade_updates: filled
    P->>C: deliverWake
    C->>CH: POST /catalog/wake
    CH->>A: send() — fill wake
    A-->>U: "Bought $100 of NVDA @ 149.9 (trigger was 150)."
```

Two details that look small and aren't:

- **Arm-on-turn-complete** (step 9): subscriptions stay `pending` while the agent's turn is still
  running and arm only after it ends — otherwise a fast tick could try to wake a session that
  hasn't parked yet.
- **Rehydrate + re-check** (step 17): "price crossed 150" is not "price is still 150." The wake's
  `onWake` guidance tells the agent its snapshot is stale by definition (TOCTOU); it re-fetches
  reality before acting, and declines to trade if the condition no longer holds.

## Subscription lifecycle

```mermaid
stateDiagram-v2
    [*] --> pending: subscribe_event (Ajv-validated,<br/>planned entries rejected)
    pending --> armed: turn.completed —<br/>provider.arm + expiry timer<br/>(never mid-turn: closes the race)
    pending --> failed: arm error<br/>(unknown provider, auth, seed)
    armed --> delivering: predicate fires or expiry —<br/>synchronous claim, one winner
    armed --> failed: provider failure<br/>(lastError recorded)
    delivering --> fired: wake delivered,<br/>same session id verified
    delivering --> expired: expiry wake delivered
    delivering --> failed: delivery failed<br/>(session mismatch / HTTP error)
    fired --> [*]: provider.disarm
    expired --> [*]: provider.disarm
    failed --> [*]: provider.disarm

    note right of delivering
        one-shot semantics:
        every terminal state disarms
        the provider watcher
    end note
```

Every transition is visible at `GET /catalog/subscriptions` (status, timestamps, `lastError`) —
the lifecycle *is* the observability model. Wakes are effectively-once: at-least-once delivery
plus a synchronous in-process claim and idempotent resume, with a session-id check that detects
(loudly) if eve's delivery fallback ever mints a fresh session instead of resuming the right one.

## What the catalog offers today

| provider | event | how it watches | freshness | auth | cost |
|---|---|---|---|---|---|
| alpaca | `price.crossesBelow` | shared websocket, edge-triggered, seeded prev | real-time (IEX) | paper keys | free |
| alpaca | `price.crossesAbove` | same | real-time | paper keys | free |
| alpaca | `order.filled` | `trade_updates` push, REST seed at arm; wakes on **any** terminal status | seconds | paper keys | free |
| edgar | `filing.new` | 30s poll per CIK, subscribers coalesced, accession diff | minutes | none (User-Agent required) | free |

Edge-triggered means exactly that: a crossing needs the price to actually *cross*. A subscription
whose price already sits past the threshold will never fire — it expires, and the agent tells you
the condition never triggered (not that the price never got there).

## Running it

Prereqs: Node ≥ 24, pnpm (version pinned via `packageManager`), a Vercel account (linked; OIDC
handles model auth via AI Gateway), an Alpaca **paper** account, a LangSmith key. All secrets
live in Vercel's project env store: `vercel env pull .env.local --yes` (only while the dev server
is **down** — see below). Var names: `.env.example`.

```bash
pnpm install
pnpm dev          # eve dev server on port 2000
pnpm test         # 86 node:test cases (talks to live Redis)
pnpm typecheck
```

Talk to the agent:

```bash
# start a conversation (returns a sessionId)
curl -s -X POST localhost:2000/catalog/chat -H 'content-type: application/json' \
  -d '{"conversationId":"demo-1","message":"Buy $100 of NVDA if it falls below $XXX today."}'

# watch the agent live
curl -N localhost:2000/catalog/sessions/<sessionId>/stream

# approvals are plain replies on the same conversation
curl -s -X POST localhost:2000/catalog/chat -H 'content-type: application/json' \
  -d '{"conversationId":"demo-1","message":"approve"}'

# inspect every subscription's lifecycle
curl -s localhost:2000/catalog/subscriptions | jq .
```

Demo guidance: run during US market hours (9:30–16:00 ET); pick a threshold slightly **below**
the current price (edge-triggered — it has to cross downward). Off-hours, set
`ALPACA_DATA_FEED=test` to stream Alpaca's 24/7 synthetic ticker `FAKEPACA` through the same
pipeline — note its price is flat in practice, so crossings won't fire on it; expiry wakes,
EDGAR wakes, and the approval flow all work any time. The full manual test suite lives in
`docs/acceptance-tests.md` (AT-1 … AT-9).

<!-- TODO after the supervised live demo (task 7): paste the two real AT-7 run transcripts here. -->

## Observability

- **LangSmith**: every turn exports OTel spans (model calls, tool calls, full inputs/outputs)
  to the project in `$LANGSMITH_PROJECT`. Requires `LANGSMITH_TRACING=true` (silent no-op
  without it — see KNOWN_ISSUES #6).
- **eve Agent Runs**: sessions/turns/tool calls in the Vercel dashboard, no setup.
- **Catalog logs**: one structured line per action (`[catalog] …`, `[alpaca] …`, `[edgar] …`),
  always carrying conversation + subscription ids. The console tells the whole story.

## Honest boundaries

This is a local-first POC, and says so:

- eve **sessions** are durable (they survive restarts — that's Vercel Workflows). The catalog's
  **watchers** (websockets, poll loops, expiry timers) are in-process: a dev-server restart keeps
  subscriptions in Redis but drops the watching; re-subscribe. Any `.env.local` write hot-reloads
  the server and does the same (`KNOWN_ISSUES.md` #1–2).
- Trading is hard-coded to Alpaca's **paper** host. Notional, buy-side, market/day orders only,
  every order behind a human approval gate. There is no code path to real money.
- Wake-time `onWake` guidance is resolved server-side from `catalog.json` only; the wake route
  rejects any caller-supplied guidance (400). Event payloads are data, never instructions.
- At production scale, one seam changes: `deliverWake` becomes a publish to a durable topic
  (Vercel Queues) — fired events are low-volume and must-not-lose, while raw ticks stay filtered
  at the provider edge. The claim/idempotency semantics were built for at-least-once delivery
  from day one. Cross-agent dedup, multi-region, and true webhook providers live in the PRD
  appendix, not in this code.

## Map of the repo

| path | what |
|---|---|
| `docs/prd-draft.md` | the PRD this implements |
| `docs/acceptance-tests.md` | manual test scripts per milestone (AT-1 … AT-9) |
| `AGENTS.md` | project rules (north star, Vercel-primitives-only, catalog honesty, TDD) |
| `KNOWN_ISSUES.md` | every sharp edge found building on eve 0.22.5 beta — read before touching channel code |
| `agent/` | the eve agent: 16-line prompt, 5 tools, catalog channel, OTel |
| `catalog/` | the Event Catalog: `catalog.json`, registry, wake, providers |
