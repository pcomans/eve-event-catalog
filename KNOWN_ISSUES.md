# Known Issues

Sharp edges discovered while building on eve 0.22.5 (beta). Read this before touching channel
code or running a demo.

## 1. Channel event handlers can silently stop firing after a hot reload

eve re-resolves channel `events` handlers from a registry keyed by channel "kind" on every
workflow step — handler functions are not carried by reference across steps. After a hot reload,
a session started *before* the edit can look its handlers up against the rebuilt registry and
miss: eve's internal `callAdapterEventHandler` is a **silent no-op** on a missing/mismatched
entry. No error, no log line. For us this means arm-on-turn-complete (`turn.completed` →
`pending → armed`) simply doesn't happen for pre-edit sessions.

- **For development**: after touching channel code, restart the dev server and use a fresh
  conversation id. Never trust behavior of a session that predates your latest edit.
- **For the demo**: not a risk, as long as nothing is edited and `.env.local` isn't touched
  mid-demo — both reload triggers are things you control.
- **Worth knowing**: it's arguably an eve bug (a silent no-op on handler resolution failure is
  hostile to debugging), and it's beta software. If you ever talk to the eve team, this plus the
  broken `getEventStream` docs example (issue 3) are two concrete pieces of feedback from this
  project.

## 2. Any `.env.local` write triggers a hot reload that wipes in-process state

`eve dev` watches env files (documented in eve's CLI reference). A reload drops all in-process
module state — live websocket connections, timers, anything not in Redis — and orphans sessions
mid-turn ("Unhandled queue" log spam). Corollaries:

- Never run `vercel env pull` while the dev server is up.
- `vercel env pull` **overwrites** `.env.local` wholesale — it only writes what's stored in
  Vercel's project env store. All secrets are stored there now (as of 2026-07-11), so pulls are
  safe, but any var added only to the local file will be lost on the next pull.
- `VERCEL_OIDC_TOKEN` expires after ~12h; refresh with `vercel env pull` (server down) **before**
  a demo or test session, never during one.

## 3. eve's custom-channel docs example for streaming is broken

`session.getEventStream()` returns a `ReadableStream` of JS objects, not bytes. Passing it
directly to `new Response(...)` — exactly what eve's `docs/channels/custom.mdx` shows — kills the
connection with an opaque ECONNRESET. The fix (copied from eve's own built-in channel source) is
bridging through a TransformStream that does `JSON.stringify(event) + "\n"` via `TextEncoder`.
See `agent/channels/catalog.ts`.

## 4. `channel.continuationToken` arrives prefixed

In channel event handlers, `channel.continuationToken` is the fully-qualified token
(`"catalog:demo-1"`), not the raw conversation id passed to `send()` — the framework prepends the
channel name. Strip the prefix before registry lookups. The docs mention token namespacing but
never show it landing on this field.

## 5. `vercel integration add` installs agent skills as a side effect

Provisioning the Upstash Marketplace integration auto-installed Upstash reference-doc skills into
`agent/skills/` + `skills-lock.json`, silently expanding the agent's own context surface. Removed
(2026-07-11, user-approved). If another integration is ever added, check `git status` for
unrequested `agent/` changes afterwards.

## 6. LangSmith exporter is a silent no-op without `LANGSMITH_TRACING=true`

`LangSmithOTLPTraceExporter` checks `isEnvTracingEnabled()` per export batch; if
`LANGSMITH_TRACING` (or `LANGSMITH_TRACING_V2`) isn't `"true"`, it drops all spans while
reporting success to the OTel pipeline — no error, no log. The var is provisioned in Vercel's
env store (development) as of 2026-07-11, so `vercel env pull` includes it; if traces ever stop
appearing, check this var first.

**Second silent-stop mode (hit 2026-07-12): the LangSmith monthly quota.** When the org
exhausts its unique-traces limit, ingest returns 429 ("tenant exceeded usage limits: Monthly
unique traces usage limit exceeded") — the exporter treats it as retryable and the spans
silently vanish, while dashboard READS keep working, so the project just looks frozen at the
last ingested run. Config-side debugging is wasted here. Quick check:
`curl -X POST https://api.smith.langchain.com/api/v1/runs -H "x-api-key: $LANGSMITH_API_KEY"
-H 'content-type: application/json' -d '{"id":"<uuid>","name":"quota-probe","run_type":"chain",
"start_time":"<now>","session_name":"eve-events"}'` — a 429 with that message is the answer;
fixing it is a plan/billing action in LangSmith, not a code change.

## 7. A wake POSTed from inside `turn.completed` races session parking — and eve handles it correctly

`emitTurnEpilogue` (eve's compiled `harness/emission.js`) awaits the `turn.completed` emit — which
drives our channel event handler to completion — *before* emitting `session.waiting`. So a
`provider.arm()` that calls `deliverWake()` synchronously sends its loopback `POST /catalog/wake`
(→ `send()` on the same continuation token) while the session hasn't technically parked yet.

Verified experimentally (`catalog/wake.ts`'s `armPendingForConversation` doc comment has the
detail): a throwaway provider whose `arm()` called `deliverWake()` with zero delay — worse than any
real provider, which needs at least a network round trip to detect a tick — still landed the wake
as the correctly-ordered next turn on the *same* session. eve's local dev (`world-local`) backend
buffers the reentrant `send()` rather than falling back to a new session. No extra defer/scheduling
machinery was added; the existing session-id-mismatch check in the wake route stays as an automatic
backstop in case this behaves differently against a different workflow backend (e.g. in production).

## 8. corepack silently upgraded pnpm mid-session; pnpm 11 rejects fresh packages

Observed 2026-07-12: corepack drifted pnpm from 10.32.1 to 11.12.0 without any action on our
part. pnpm 11 enforces a default `minimumReleaseAge` supply-chain policy that rejects packages
published within the last day — which breaks installs here because eve's beta dependency tree
routinely contains day-old transitive packages (crossws/nf3/srvx at the time). A failed install
can leave the shared `node_modules` broken mid-operation (we lost `node_modules/.bin/eve` and
both running dev servers this way).

- `package.json`'s `packageManager` field pins the exact pnpm version — corepack then stops
  drifting. Pinned to the session's known-good 10.32.1; revisit after the POC (pnpm 11's policy
  is a *good* security feature — the right long-term move is adopting it deliberately, not
  bypassing it).
- If an install still fails with a `minimumReleaseAge` error, run
  `corepack pnpm@10.32.1 <cmd>`. Do NOT reach for `--no-verify-store-integrity` — that disables
  a real security check.
- Never run pnpm with `CI=true` to skip its confirmation prompts — the prompt you're bypassing
  may be "recreate node_modules?", which is destructive to every process using it.

## 9. TS parameter properties break `node --test`

Node's native type-stripping (used by `node --test` / `pnpm test`) cannot parse TypeScript
parameter properties (`constructor(private readonly x: T) {}`) — any test that transitively
imports a file using one fails, and the failure looks like a broken test, not a syntax
limitation. Write explicit field declarations + constructor assignment instead.

## 10. `@alpacahq/alpaca-trade-api` is pinned to a pre-1.0 alpha, by explicit decision

Pinned to `4.0.0-alpha.3` (2026-07-12), exact version, no `^`. This is a deliberate call, not an
oversight:

- The stable `3.x` line is aging and pulls in CVE-bearing transitive dependencies; `4.x` is
  Alpaca's actively-developed ground-up TypeScript rewrite (native `fetch`, typed errors,
  built-in retry/rate-limiting, ergonomic order builders, unified `trading`/`marketData`
  namespaces) — see [PR #295](https://github.com/alpacahq/alpaca-trade-api-js/pull/295).
  Published 5 days before this decision; the wider PR/alpha effort is ~11 days old.
- The alpha is **absent from Alpaca's docs site** as of this date — the README on the `ts-alpha`
  branch is the only canonical reference; the published docs site still describes `3.x`.
- **Root-export surprise**: most of the SDK's own README examples import types (`Order`,
  `StockDataStream`, `TradeUpdate`, `toStockTrade`, `STATE`, ...) as if they were top-level
  exports. They are not — `dist/index.d.ts` only re-exports the common-case surface (the `Alpaca`
  client, error classes, chart helpers). Everything else lives under namespace exports:
  `trading.Order`, `streaming.{StockDataStream,TradingStream,StreamTrade,TradeUpdate,STATE}`,
  `marketDataShapes.toStockTrade`. `tsc` catches the mismatch immediately (`has no exported
  member`) — if this happens, check the namespace, not the package version.
- A [migration codemod](https://github.com/alpacahq/alpaca-trade-api-js/blob/ts-alpha/codemods/alpaca-v3-to-v4.js)
  exists for `3.x -> 4.x` when the stable release ships — revisit this pin then. Until stable,
  breaking changes between alpha patch versions are possible; re-verify `pnpm test` +
  `pnpm typecheck` after any alpha version bump.

## 11. Stop the dev server before running `pnpm test`

Since Phase 1 (2026-07-12), a booted server runs its own delivery-recovery sweep
(`startRecoverySweep`, `agent/channels/catalog.ts`) against the same shared Upstash Redis the
tests use. A dev server left running during `pnpm test` is a second, unstubbed process: its
sweep steals test subscriptions' delivery leases and — because test subscriptions have no
conversation record — its real loopback wake POSTs 404 and mark those rows `failed` under the
tests' feet. Symptom: intermittent (~30–50%) liveness failures in the `sweepStrandedDeliveries`
tests that never reproduce solo and look like Redis flakiness. It isn't; kill the server first.
(Found by the Phase 1 Codex gate after a long rate-limit goose chase.)

## 12. Upstash Lua: `cjson.null` is indistinguishable from `nil` — null fields silently vanish

In Upstash's EVAL sandbox (verified experimentally 2026-07-12, Phase 1), `t.field = cjson.null`
behaves exactly like `t.field = nil`: the key simply doesn't exist afterward (`pairs()` never
sees it), even on a table that was never `cjson.decode`d. Consequence: any decode → mutate →
re-encode round trip in a Lua script silently DROPS every null-valued JSON field — `lastError`,
`firedAt`, an unset `deliverReason` — persisting records whose nulls have become missing keys
(`undefined` on the JS side). A second, related trap: cjson decodes `{}` and `[]` to the same
empty Lua table and re-encodes it as `[]`, so `params: {}` comes back an *array*.

**The rule this project settled on (after a sentinel-string workaround was itself gate-failed
for data-corruption edge cases): never round-trip a stored JSON record through cjson at all.**
Do the read, guard checks, and JSON construction in TypeScript, and keep Lua down to a raw
string compare-and-swap (`if GET==ARGV[1] then SET ARGV[2]`) with a bounded JS retry loop — see
`tryTransitionToDelivering` in `catalog/registry.ts`. Two practicalities: read the expected
value byte-exact with a second client (`Redis.fromEnv({ automaticDeserialization: false })`),
never parse→re-stringify it; and remember `@upstash/redis` auto-retries failed commands (~5×),
so fault-injection tests need sustained failures, not single-shot throws.

## 13. A never-deployed project's FIRST `vercel` deploy targets production

Observed 2026-07-13, verified from the deploy output: on a project with no prior production
deployment ("Latest Production URL: --"), a bare `vercel` / `vercel --yes` (no `--prod`)
created a deployment with `"target": "production"` and aliased the project's production domain
to it — the usual "bare deploy = preview" behavior does not hold for the very first deploy.
Bit us during a Phase 2 smoke test: a throwaway connector build briefly became
event-catalogue.vercel.app (inert — 404 on all routes, no secrets, nothing overwritten, since
nothing had ever been deployed). Rule: on a project's first-ever deploy, pass the target
explicitly and read back `"target"` in the deploy output before doing anything that depends on
it being a preview.

**Related (2026-07-13): preview URLs are SSO-walled by default.** Plain curl against a preview
deployment 302s to vercel.com/sso-api — Vercel's default Standard Protection applies to
previews regardless of any project posture we've decided in docs (production URLs are NOT
walled by default; that's why the loopback concern only applies if protection is turned up).
Sanctioned bypass for scripts/tests, no env var needed:
`vercel curl <path> --deployment <url> --yes -- <curl-args>` (auto-generates a
protection-bypass token from the authenticated CLI session). To make previews truly public
per the "open from day one" decision, the project's Deployment Protection setting must be
changed in the dashboard — a Philipp action, not CLI.

## 14. Assorted

- The dev server listens on port **2000**, not 3000 as eve's own docs curl examples suggest.
- Local durable workflow state lives in `.workflow-data/` (gitignored). If sessions look stuck
  after crashes/reload incidents, stopping the server and deleting it gives a clean slate —
  active subscriptions in Redis survive, but their parked sessions do not; re-subscribe.
- Live IEX market data only flows during US market hours (9:30–16:00 ET, Mon–Fri). Off-hours,
  price subscriptions arm but never fire, and notional market orders won't fill.
- **Superseded 2026-07-12 (Phase 1, AT-10)**: `POST /catalog/chat` and `POST /catalog/wake` now
  require `authorization: Bearer $CATALOG_API_SECRET` (`catalog/auth.ts`; checked in
  `agent/channels/catalog.ts` before any session-touching code runs) — the server refuses to
  boot without the secret configured (`assertCatalogApiSecretConfigured`). `payload`/
  `subscribedAt`/`firedAt` are still caller-suppliable to anyone holding the secret (unchanged),
  and `guidance` still can't be spoofed — the route rejects (400) any request that supplies one
  and resolves it itself from catalog.json (AGENTS.md rule 4). `GET /catalog/subscriptions` and
  `GET /catalog/events` remain open, unauthenticated, read-only (see #7's cross-instance dedup
  note, still relevant to the wake-delivery race this entry originally described).

## 14. A library module (`catalog/catalog.ts`) gets evaluated more than once per process — its module-level state is NOT a singleton across every code path

Found 2026-07-12 while adding the clock provider: a runtime-dependent check (`clock.time.at`'s
`at` must be a real, future datetime — Ajv's static JSON Schema can't express that) was first
implemented as an optional `Provider.validateParams` hook, called from `subscribe()` via
`getProvider(input.provider)`. It passed every isolated `node:test` run cleanly, but a live
end-to-end check through the real `subscribe_event` tool showed a subscription with a datetime
**12 days in the past** get silently accepted. Debug logging (a `Math.random()`-tagged identity
stamped on the module-scope `providers` Map) proved the cause: `catalog.ts` is evaluated as
**at least three separate module instances** in one running dev server — two before
`[DEV] server listening`, a third after — each with its own independent, empty-until-populated
`providers` Map. `assertCatalogHonesty()` and `arm()`/`disarm()` dispatch always looked correct
because they run in whichever instance also ran the provider-registering imports
(`agent/channels/catalog.ts`'s side-effecting imports of `alpaca.ts`/`edgar.ts`/`clock.ts`) — but
`subscribe()`, invoked from a tool's `execute()`, does not reliably run in that same instance, so
`hasProvider()`/`getProvider()` calls made from inside `subscribe()` cannot be trusted to see
what registered elsewhere.

**The rule this project settled on**: never make `subscribe()` (or anything invoked from a
tool's `execute()`) depend on the `providers` registry, or any other module-level state populated
by a side-effecting import elsewhere. A constraint that must be enforced at `subscribe()` time
has to be self-contained — expressed as data in `catalog.json` and checked by something with no
cross-module dependency, e.g. an Ajv custom keyword (`ajv.addKeyword` in `catalog/catalog.ts`;
see the `futureDatetime` keyword backing `clock.time.at`'s `at` field). This generalizes: catalog
entries needing more subscribe-time constraints later should add more such self-contained
keywords, not another registry-dependent hook. Full debug trail (the three-instance evidence) is
in this session's transcript, not preserved in git history since the debug logging was removed
before committing.

**A second concrete instance (Codex clock-gate review, 2026-07-12, not yet fixed):**
`catalog/providers/alpaca-client.ts`'s `testFeedTrades` Map (populated by `alpaca.ts`'s
`ALPACA_DATA_FEED=test` tick handler, read by `getLatestTrade`) has the exact same shape of bug:
`get_latest_price`'s tool `execute()` can read an empty `testFeedTrades` in whatever module
instance IT runs in, and falsely report "no test-feed trade observed yet" even while the FAKEPACA
stream is actively ticking in the main process's instance. Not fixed now — the real fix is
Phase 2's provider extraction (moving providers out of this same-process, multi-instance-prone
arrangement entirely), not a patch here.
