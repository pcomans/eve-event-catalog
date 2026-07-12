# Event Catalog POC (on eve)

An **Event Catalog** lets AI agents say "wake me when X becomes true": discover event sources,
subscribe, suspend, and get woken by the catalog when the predicate fires. Vertical slice:
agentic trading (Alpaca paper trading + SEC EDGAR). PRD: `docs/prd-draft.md`.

Built on the eve framework (Vercel). Before writing eve-touching code, read the relevant guide in
`node_modules/eve/docs/` (fallback: https://eve.dev/docs) — but note several published examples
are broken; **read `KNOWN_ISSUES.md` first, always.**

## Commands

- `pnpm dev` — dev server on port **2000** (not 3000)
- `pnpm test` — node:test suite (hits live Redis; needs `.env.local`)
- `pnpm typecheck`
- Manual test scripts per milestone: `docs/acceptance-tests.md` (AT-1 … AT-9)

## Architecture (one paragraph)

The agent lives in `agent/` (eve filesystem conventions: `instructions.md`, `tools/`,
`channels/`). The catalog is an in-process library in `catalog/`: `catalog.json` (declarative
event-type registry — see rules below), `registry.ts` (subscriptions + conversation map, Upstash
Redis), `wake.ts` (delivery + expiry timers), `providers/` (alpaca, edgar). The custom channel
`agent/channels/catalog.ts` owns conversations via its own continuation tokens: `POST
/catalog/chat` starts/continues a conversation, `POST /catalog/wake` resumes a parked session,
`GET /catalog/subscriptions` shows the registry. Subscriptions are `pending` during a turn and
armed only on `turn.completed` (closes the tick-arrives-mid-turn race). Wake envelope is
`{subscribedAt, firedAt, payload, guidance}` — `subscribedAt` = armedAt, payload can never shadow
envelope fields, and `guidance` is catalog-owned handling instructions (see the wake-guidance
security rule below), never derived from `payload`. Full design:
`/Users/philipp/.claude/plans/jolly-dazzling-waterfall.md` (session plan); lifecycle:
`pending → armed → delivering → fired | expired | failed`.

## Hard rules (from Philipp)

1. **North star: clean, readable POC.** No defensive programming, no over-engineering. If a
   human can't follow it, it's wrong. Observability over robustness.
2. **Every infrastructure component must map to a Vercel primitive.** Non-Vercel components need
   Philipp's explicit approval. Approved so far: LangSmith (tracing), Upstash Redis via Vercel
   Marketplace (registry). Event providers (Alpaca, EDGAR) are subject matter, not infra.
3. **Providers use push when the source offers it; polling never scales per subscription.**
   Prefer the provider's push channel (websocket/stream) — one connection per account/resource,
   events routed to subscriptions. When polling is unavoidable (EDGAR), poll per upstream
   *resource* with all subscribers coalesced onto one poll loop — never one loop per
   subscription. REST reads are for *seeding* state at arm time, not for watching.
4. **The catalog is declarative and honest.** `catalog/catalog.json` is the single source of
   truth for event types; its JSON Schemas are *enforced* at subscribe() time (Ajv). Entries
   without a registered provider are `"status": "planned"`; `assertCatalogHonesty()` must fail
   the boot if an "active" entry has no handler. Never advertise what isn't implemented. Each
   entry's `onWake` guidance is likewise catalog-owned and the only trusted source of wake-time
   instructions — `wake.ts`'s `resolveWakeGuidance` resolves it from the subscription's own
   Ajv-validated `provider`/`event`, never from `payload`/`snapshot` (external, provider-supplied
   data at fire time).
5. **Tests are written red-green** (failing test first), node:test, no test-framework deps.
6. **Check current versions before adding any dependency** (npm registry) — never install from
   memory. Pin eve exactly.
7. **Never put test files under `agent/`** — eve discovery-scans those directories as agent
   definitions and a stray `*.test.ts` breaks `pnpm dev`/build. Tests for `agent/*` code live in
   `tests/` (e.g. `tests/agent-tools/`); catalog tests stay next to their modules in `catalog/`.
8. Every coding step gets an independent Codex review (gpt-5.6-sol, xhigh) before dependent work
   builds on it — orchestrated by the session lead; don't self-certify.

## Environment

All secrets live in **Vercel's project env store** and land in `.env.local` via
`vercel env pull` (which OVERWRITES the file — never add local-only vars, never pull while the
dev server runs; see KNOWN_ISSUES.md #2). `VERCEL_OIDC_TOKEN` expires ~12h → pull (server down)
before long sessions. Var names: `.env.example`. Trading hits Alpaca **paper** only
(`paper-api.alpaca.markets`) — no real-money endpoints anywhere. `ALPACA_DATA_FEED=test`
switches market data to the 24/7 FAKEPACA test stream for off-hours work.
