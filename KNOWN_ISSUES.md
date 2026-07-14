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

**Addendum (2026-07-13, from the LangSmith exporter incident's offline harness — see
`spikes/langsmith-exporter-harness/FINDINGS.md`): a reload doesn't just go stale — it actively
DELETES.** eve's dev env loader (`dist/src/cli/dev/environment.js`, parsing via `node:util`'s
`parseEnv` — same parser as `node --env-file`, quotes handled identically) removes from
`process.env` any key it set on a previous load that is absent from the new file read. So one
reload against an incomplete `.env.local` doesn't leave the old value in place — it deletes the
var from the live process, and it stays gone until a later reload sees a complete file or the
process restarts. Combined with #6 (exporter silently no-ops without `LANGSMITH_TRACING`), this
is a verified mechanism for "some subsystem died silently at time T and stayed dead" (repro:
`spikes/langsmith-exporter-harness/step6-env-reload-deletion.mjs`). The file watcher's
`awaitWriteFinish` (160ms stability) protects against reading a torn single-writer write, so the
realistic trigger is two writers overlapping on `.env.local` — which the rule above already
forbids. The corollary is new: if a subsystem that reads env per-operation goes quiet, suspect a
past bad reload FIRST, and know a clean restart fixes it.

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

**Extension (2026-07-13, post-demo Codex gate pass C): the same gap becomes deterministic —
not just multi-instance-flaky — under `WATCHER_HOST=connector` + `ALPACA_DATA_FEED=test`.** In
connector mode the in-process arm() guards mean `handleTrade` (the only writer of
`testFeedTrades`) never runs in the eve process at all, and a separate connector process can't
populate an in-process Map — so `get_latest_price` always fails on the test feed even while the
connector is receiving FAKEPACA ticks, and price-wake guidance tells the agent to do exactly
that fresh-price check before acting. The IEX path is unaffected (REST). Fix tracked for
post-merge, before Phase 6's cloud E2E (task #27): fall back to the connector's Redis-persisted
per-symbol latest price (`gap-replay-cursor`) when in connector mode.

## 15. `workflow@4.6.0`'s `start()` cannot be called directly in a `"use workflow"` body — and its own retries can fork the "run forever" chain

Found 2026-07-13 on real infra (preview deployment), running `connector/workflows/sleep-resume-smoke-test.ts` to verify gate 7's `start(self, [state])` recursion shape (the SDK's only "run forever" primitive — no `continueAsNew`). Two distinct bugs, found in sequence:

1. **`start()` must be called from inside its own `"use step"` function, never directly in the `"use workflow"` body.** Calling it at the workflow's top level (as gate 7's own research and this project's first connector skeleton both did) throws at runtime: `Error: The workflow environment doesn't allow this runtime usage of start. Move this call to a step function ("use step") or call it outside the workflow context.` The `workflow/api` module's `start`/`getRun`/etc. exports are unconditional stubs that always throw this — the real implementation is only wired in for step-context or outside-workflow (e.g. route-handler) call sites, not the workflow body itself. Fix: wrap the call —
   ```ts
   async function startNextRun(nextState: State): Promise<void> {
     "use step";
     await start(selfWorkflow, [nextState]);
   }
   ```
   Applied in both `sleep-resume-smoke-test.ts` and the real `market-data-session.ts`.

2. **A step's return value must be JSON-serializable — the `Run` object `start()` resolves to is not.** Returning it directly from a `"use step"` function (e.g. to log `chained.runId`) fails with `[Workflow] Serialization failed { context: 'step return value', problematicValue: Run { ..., world: { ...AsyncFunctions... } } }`. Fix: extract only the primitive fields you need (`{ runId: run.runId }`), never return the `Run` instance itself.

   **Sharper and more important finding riding along with #2**: while retrying against that serialization failure, the step actually called `start()` again on every retry — 4 retries produced 4 distinct downstream `wrun_...` run IDs before the step gave up as `FatalError: ... exceeded max retries`. `start()` has no idempotency-key option (checked `StartOptions`'s full shape: `world`, `specVersion`, `deploymentId` only). **This means any step wrapping a chaining `start()` call is not safely retryable as written** — if it ever fails for a transient reason after `start()` has already succeeded (not just this now-fixed serialization bug), the retry forks a second, redundant "forever" chain running in parallel with the first. Not fixed here (the smoke test's fix avoids retries by not failing at all); flagged for whoever hardens `market-data-session.ts`'s own `startNextRun` — worth an explicit "has this run already been chained" check (e.g. a Redis flag keyed by the parent runId) before calling `start()` again on retry, or confirming from Vercel whether a future SDK version adds an idempotency key.

**Why this matters for Phase 3**: the *sleep/resume* mechanism itself is NOT what failed — the smoke test's first (pre-fix) run survived 6×30s sleeps plus one full 35-minute sleep (past vercel/workflow issue #634's reported ~30-minute trouble spot) without incident, and only failed afterward on the unrelated `start()` bug above. That's a positive signal for using durable `sleep()` for Phase 3's expiry timers rather than falling back to a sorted-set sweep — the sweep alternative would still be worth keeping in mind for whatever workaround #2's forking risk needs, though.

## 16. Package-manager CLIs run from inside `observatory/` silently create a second lockfile

`observatory/` carries its own `pnpm-workspace.yaml` (holding only `ignoredBuiltDependencies`,
mirroring `connector/`'s shape). Any package-manager CLI run with its cwd *inside* that
directory — hit 2026-07-14 with `npx ai-elements@1.9.0 add ...` — treats it as its own
workspace root and writes a stray `observatory/pnpm-lock.yaml` instead of updating the root
lockfile. The stray file is silently stale from birth and shadows the real resolution. Caught
via `git add -n` before commit; fixed by deleting the stray and re-running `pnpm install` from
the repo root. Rule: run installs and scaffold CLIs (`npx shadcn add`, `npx ai-elements add`,
anything that touches dependencies) from the WORKSPACE ROOT, and check for stray lockfiles
after any `npx` inside a subdirectory. Related cosmetic symptom: `next dev` warns "inferred
workspace root ... multiple lockfiles"; a `turbopack.root` fix attempt broke the dev server
outright (couldn't resolve `next/package.json`) and was reverted — leave the warning alone.

## 17. eve 0.22.5 `defaultMessageReducer`: a whitespace-only message part is stuck at `state: "streaming"` forever

The harness only emits `message.completed` when accumulated text is non-whitespace (every
flush site in `harness/emission.js` gates on `d.trim().length>0`; end-of-stream emits a
`message: null` completion only for the empty-delivery sentinel). The client reducer
(`client/message-reducer.js`) has no trim logic and only `message.completed` transitions or
removes a text part — `turn.completed` touches message *metadata* only. Net: a model step that
streams only whitespace leaves a text part permanently `state: "streaming"` in the reducer's
projection. Observed impact in the observatory decisions view is near-invisible (Streamdown
renders whitespace as nothing), so this is ACCEPTED ship-as-is (decision 2026-07-14), not
patched around. Third item for eve-team feedback, alongside #1's silent handler no-op and
#3's broken streaming docs example.

## 18. `ai-elements@1.9.0` vendored `code-block.tsx`/`shimmer.tsx` fail current react-hooks lint rules

The ai-elements CLI vendors component source into `observatory/components/ai-elements/`; two
files trip newer `eslint-plugin-react-hooks` rules (ref-during-render, component-created-
during-render). Upstream registry code, deliberately not patched locally — lint is run scoped
to files we author. Revisit on the next `ai-elements` upgrade.

## 19. Upstash free tier hard-caps at 500k commands/month — and market hours burn it fast

Hit 2026-07-14, ~2 hours into the campaign's first live market session: every Redis command
started failing with `UpstashError: ERR max requests limit exceeded. Limit: 500000, Usage:
500000` — the catalog's entire state layer (registry, delivery transitions, event history,
turn cap, cursors) degrades at once, while anything not Redis-backed (in-process timers,
parked eve sessions, Alpaca REST) keeps working, so the failure is PARTIAL and confusing:
the observe page's transcript still streams while its event feed dies. Same
silent-quota-death family as #6's LangSmith incident. Burn profile: the standing
EDGAR/expiry/recovery sweeps consume steadily 24/7, but the big spike is market hours — the
in-process price watcher persists the gap-replay cursor on EVERY live trade tick (p2v fix
10). Resolution: upgraded to pay-as-you-go (Philipp, 2026-07-14) — service resumes on the
next command, no restart needed. Follow-up tracked (task #33): throttle per-tick cursor
writes and audit sweep command counts, since on paid this is now a cost knob, not a quota
cliff. Quick check when Redis-backed features die weirdly: `grep 'max requests limit'` in
the dev server log.
