I think we should resist the temptation to build “yet another event framework.”

Instead, build something that feels like a missing primitive in eve.

Here’s the PRD I would write.

⸻

PRD: Event Catalog

Vision

AI agents today are excellent at reacting now.

They are terrible at reacting later.

To wait for the world to change, developers have to build polling loops, cron jobs, webhook infrastructure, queues, retries, and durable state.

Instead, agents should be able to say:

Wake me when X becomes true.

The Event Catalog makes external events first-class capabilities that agents can discover, subscribe to, and await.

⸻

Goals

An Eve agent should be able to

* discover available event sources
* understand what predicates each source supports
* subscribe to an event
* suspend execution
* resume exactly once when the predicate becomes true

without writing polling code.

⸻

Non-goals

Not trying to become Zapier.

Not trying to build a workflow engine.

Not trying to support arbitrary user integrations.

Everything is provider-based.

⸻

Core abstraction

An Event Provider exposes

interface EventProvider {
    search(query)
    subscribe(predicate)
    unsubscribe()
    listCapabilities()
}

Every provider advertises

* schema
* latency
* freshness
* durability
* authentication
* cost

⸻

Event Subscription

{
    provider: "alpaca",
    event: "price.crossesBelow",
    resource: "NVDA",
    predicate: {
        price: 150
    },
    once: true,
    expires: tomorrow
}

⸻

Agent API

const event = await events.search(
    "notify me when Nvidia drops below 150"
)
await event.subscribe()
await suspend()
// resumes here

This is the magic.

⸻

Internal Architecture

Agent
    │
Event Catalog
    │
Subscription Registry
    │
Provider
    │
External API

⸻

MVP Providers

1. Alpaca ⭐⭐⭐⭐⭐

Purpose

Market data.

Supported events

* price crosses above
* price crosses below
* % move
* volume
* market open
* market close

Why

Streaming websocket.

Free paper account.

Real historical data.

Paper trading API.

Excellent developer experience. Alpaca’s paper environment mirrors the live Trading API, lets you reset balances, and uses separate credentials, making it ideal for iterative development.  

⸻

2. SEC EDGAR ⭐⭐⭐⭐⭐

This one is incredibly interesting.

Supported events

* new 8-K
* new 10-Q
* new 10-K
* insider transactions
* earnings filing

Example

Wake me when Nvidia files an 8-K.

No polling in user code.

SEC publishes filing feeds that can be consumed without paid market-data subscriptions, making this a great “high-value, free” provider.  

⸻

3. Weather (Open-Meteo)

Supported events

* rain starts
* rain ends
* temperature below
* wind above
* sunrise
* sunset

Example

Water my plants when it hasn’t rained for three days.

Open-Meteo has a generous free API with no API key required for non-commercial use.  

⸻

4. RSS

Supported

* new article
* keyword appears
* author publishes

Example

Wake me when Simon Willison writes about MCP.

⸻

5. GitHub

Supported

* PR merged
* release published
* issue closed
* workflow finished

⸻

6. Cron

This is surprisingly important.

Everything eventually becomes

wake me tomorrow.

⸻

Trading Slice

This is the demo.

Not the product.

⸻

User Prompt

Buy $100 of NVDA if it falls below $150 today.

⸻

Agent Flow

Understand intent
↓
Search Event Catalog
↓
Discover Alpaca provider
↓
Subscribe
↓
Suspend

⸻

Later…

Alpaca websocket
↓
Predicate satisfied
↓
Resume workflow
↓
Fetch latest quote
↓
Fetch portfolio
↓
Risk checks
↓
Request approval
↓
Submit paper trade
↓
Wait for fill
↓
Resume

⸻

Why fetch the quote again?

This is subtle.

The triggering event

Price crossed 150

is not

Price is still 150.

When the agent wakes

it should always rehydrate state.

This is a beautiful systems discussion.

⸻

Future Trading Providers

Provider

Robinhood

Capability

Execution only

⸻

Provider

Interactive Brokers

Execution

⸻

Provider

Coinbase

Crypto

⸻

Provider

Polymarket

Prediction markets

⸻

Provider

Kalshi

Event contracts

⸻

Future Event Providers

Commodities ⭐⭐⭐⭐⭐

This could become really cool.

Examples

Gold

Oil

Natural Gas

Corn

Coffee

Copper

Instead of

NVDA < 150

you get

Oil > 100

Useful for supply chain agents.

⸻

FRED

Federal Reserve data.

Events

* CPI released
* unemployment released
* interest rate changes

Imagine

rebalance after CPI.

⸻

Earnings Calendar

Wake

15 minutes before earnings.

⸻

Economic Calendar

Fed meeting

GDP

Jobs report

PMI

⸻

NOAA

Storm alerts

Wildfire

Hurricane

⸻

USGS

Earthquakes

⸻

FAA

Flight delays

⸻

Marine weather

Shipping.

⸻

Energy

California ISO

ERCOT

Electricity prices.

Amazing for home automation.

⸻

Interesting Systems Problems

This is where I think Andrew would lean in.

Deduplication

10,000 agents waiting on

NVDA < 150

Should produce

ONE

provider subscription.

Not 10,000.

⸻

Durable wakeups

The provider emits

crossed below

The region dies.

How do we avoid losing the wakeup?

⸻

Predicate ownership

Should predicates execute

* provider side
* catalog side
* agent side

⸻

Event replay

Can workflows replay events?

⸻

Exactly-once wakeup

Maybe impossible.

Idempotent resume instead.

⸻

Subscription lifecycle

One-shot

Recurring

Windowed

Cooldown

Expiration

⸻

Success Metric

By the end of the weekend, I don’t want you to have “a trading bot.”

I want you to be able to demo this:

“Here’s an eve agent. It doesn’t know anything about Alpaca. It asks the Event Catalog how to wait for a stock price condition, subscribes, suspends itself, resumes when the event fires, requests approval, paper-trades, and then suspends again until the order completes.”

That demo is memorable because the trading logic is almost incidental. The interesting idea is that you’ve introduced interrupts for AI agents—a reusable programming primitive that could power finance, weather, GitHub, SEC filings, and countless other event-driven workflows. I could genuinely imagine a future version of eve growing in this direction.