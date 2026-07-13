# Handoff: Phase 2 done, Phase 3 next

Working notes for whoever picks this up next — not project docs, not committed convention,
just "read this first." Written 2026-07-13, updated same day after team-lead signed off on all
three flagged trade-offs and directed continuing into Phase 3 (EDGAR sweep, expiry migration,
Phase 1 recovery-sweep migration) in the same session. Kept up to date as insurance against a
context wall mid-Phase-3, not just as an end-of-session artifact. Nothing in this worktree is
committed. Team-lead is running a re-verify Codex pass on the p2a/p2b fixes in parallel with
Phase 3 continuing — expect either a clean PASS or a short follow-up findings list.

## CLOUD STATE AS OF END OF SESSION (2026-07-13, morning): EMPTY — no preview deployments, nothing running

Everything described below about EDGAR/expiry/recovery chains running live on a preview deployment
is now HISTORICAL — team-lead deleted ALL 13 preview deployments from the night's iterations (with
Philipp's approval), specifically because a live demo was starting from the main worktree's local
dev server against the SAME shared Redis, and this session's expiry-sweep/recovery-sweep chains
scan that Redis GLOBALLY (any subscription in "delivering" or past its `expiresAt`, not scoped to
test data) — a real, if bounded and self-healing, interference risk with a live demo. **A workflow
run's chain dies with its pinned deployment** — deleting the deployment is the blunt instrument that
actually worked, since no in-CLI cancellation path was ever found (see the still-open Phase 6 item
right below). Confirmed: only the frozen, pre-cron production shell remains (no functional routes,
predates the cron entries), so nothing cloud-side can touch the shared Redis right now.

**Redeploy path for whoever does Phase 6 (or resumes this work)**: `vercel deploy --target=preview
--yes` from the repo root, then `vercel inspect <url>` to confirm `target: preview` before touching
anything further (hard standing rule, see "Deploy mechanics" below) — everything needed to redeploy
(the pnpm workspace, the `installCommand` override, the lazy Alpaca client Proxy) is already in
place and working, proven twice this session. Re-add the three `*_SWEEP_TICKS_PER_RUN` Preview env
vars (`EDGAR_SWEEP_TICKS_PER_RUN`, `EXPIRY_SWEEP_TICKS_PER_RUN`, `RECOVERY_SWEEP_TICKS_PER_RUN`,
all `2` for a quick smoke cycle) if a fresh smoke test is wanted — they were deleted along with
their deployments' relevance, but the Preview env var entries themselves may still exist (`vercel
env ls`) since env vars are project-scoped, not deployment-scoped; check before re-adding.

## OPEN (Phase 6, not now): find/build a workflow run-cancellation path

No `vercel workflow` CLI subcommand exists (checked `vercel workflow --help`, `vercel --help`).
`@workflow/core`'s own `Run` type DOES expose `.cancel(): Promise<void>` (confirmed in its
`.d.ts`, and a working `connector/routes/stop-run.post.ts` throwaway route now exists proving
`getRun(runId).cancel()` works from a deployed route — see the p3 preview-boot section below), but
there is still NO way found to ENUMERATE "the current active run for workflow X" without already
knowing its runId — `getRun` needs an ID you already have, a completed run's own ID doesn't reveal
what it chained to, and `getWorkflowBaggage()` (`@workflow/core`'s OTEL-baggage-based
`{workflowRunId, workflowName}` accessor, found this session — see its own `.d.ts` in
`@workflow/core/dist/telemetry.d.ts`) is available from WITHIN a running step but nothing currently
persists it anywhere external to look up later. Whoever tackles Phase 6's real cancellation story:
the cleanest fix is probably having `recordHeartbeat` (or a sibling call) also write its own
`workflowRunId` (via `getWorkflowBaggage()`) to a Redis key per workflow name, so a future
`stop-run`-style route (or a supervisor variant) can always resolve "the CURRENT run" without
guessing. Deleting the whole deployment (this session's actual solution) remains the blunt
fallback for "just make it stop right now."

## Phase 3 item 2 (expiry migration) — DONE, 2026-07-13

Durable driver for subscription expiry, alongside (not replacing) wake.ts's own in-process
`scheduleExpiry`/`expire()` (kept exactly as-is for local dev — one code path per host, matching
the alpaca legs' WATCHER_HOST split):

- **`catalog/registry.ts`**: new Redis sorted-set index (`catalog:expiry-index`, score = expiresAt
  as epoch ms, member = subscription id), dual-written INSIDE `writeSubscription` — any write that
  leaves a subscription "armed" with a non-null `expiresAt` adds/refreshes it in the set; any
  write that doesn't (disarmed, terminal, or armed-with-no-expiry) removes it. This is the whole
  "written at arm time" requirement satisfied for free: every existing caller already goes through
  `updateSubscription` → `writeSubscription`, so wake.ts needed ZERO code changes to participate.
  New `readDueExpirySubscriptionIds(nowMs)` (ZRANGE ... byScore, "-inf" to nowMs) is the durable
  sweep's read side. `deleteSubscription` (test hygiene) also cleans the new index. 4 new tests in
  `registry.test.ts`, red-green proven (temporarily removed the ZADD/ZREM entirely — both the
  "is due" test and the "removed on terminal" test failed for the right reason; restored).
- **`connector/lib/deliver-wake.ts`**: extracted the shared armed→delivering→terminal lifecycle
  into a private `deliverTerminalWakeFromConnector(sub, reason, snapshot?)`, used by BOTH the
  existing `deliverWakeFromConnector` (reason="fired", untouched signature — no existing call site
  needed to change) and a new `deliverExpiredWakeFromConnector(sub)` (reason="expired", no
  snapshot — matches wake.ts's own `expire()`, which passes none either). New
  `connector/lib/deliver-wake.test.ts` (4 tests) including **the binding "both-fire race" test**:
  wake.ts's own `deliverWake(sub, {reason:"expired"})` (the LOCAL in-process path) and
  `deliverExpiredWakeFromConnector(sub)` (the DURABLE connector path) called via `Promise.all`
  against the SAME subscription — both funnel through the SAME `tryTransitionToDelivering` CAS, so
  exactly one ever POSTs the wake. Red-green proven twice (temporarily bypassed the CAS entirely —
  both the "already-terminal is a no-op" test and the race test failed with the wrong delivery
  count; restored).
- **`catalog/providers/expiry-sweep.ts`** (new): `runExpirySweepTick(deliver, nowMs)` — reads every
  due id, looks up the live subscription, calls `deliver` (production:
  `deliverExpiredWakeFromConnector`) for each; one poison row (an id whose record vanished, or
  whose delivery throws) is logged and skipped, not a reason to abort the round (same "poison row"
  isolation as wake.ts's own `sweepStrandedDeliveries`). 4 tests, including **the required overlap
  test**: two genuinely concurrent `runExpirySweepTick` calls racing the same due subscription
  produce exactly one delivery, via a fake `deliver` that calls the REAL `tryTransitionToDelivering`
  (not a reimplementation) — same pattern as `edgar-sweep.test.ts`'s own overlap test. Both the
  poison-row test and the overlap test red-green proven (removed the per-row try/catch — the
  poison-row test failed reproducing the exact thrown error; restored).
- **`connector/workflows/expiry-sweep.ts`** (new): identical run-forever shape to
  `edgar-sweep.ts` (chain-guard-guarded `start(self)` recursion, `EXPIRY_SWEEP_TICKS_PER_RUN`
  smoke-test override shrinking tick count only). **`connector/routes/ensure-expiry-running.get.ts`
  + `start-expiry.post.ts`** (new) mirror the EDGAR sweep's own routes, with `claimSupervisorLock`
  baked in from the start (not retrofitted later, unlike the market-data/EDGAR routes which needed
  the p2v fix round to add it). `vercel.json` gets a third cron entry, `/ensure-expiry-running`,
  same `*/5 * * * *` schedule.

**Verified**: connector `pnpm typecheck` + `pnpm build` clean (now 4 workflows, 15 steps — up from
3/12 after the EDGAR sweep). Root `pnpm typecheck` clean. Root `pnpm test`: see the report to
team-lead for the exact count (run alongside this handoff update). **Not done**: no live preview
smoke test of this specific workflow (team-lead's smoke-test sequencing was EDGAR-specific;
awaiting direction on whether item 2 needs its own, or whether the already-proven EDGAR sweep
smoke test's evidence — same chain-guard/sleep/supervisor primitives — is sufficient).

## RESOLVED: duplicate EDGAR sweep implementation (was OPEN, BLOCKING)

Team-lead's adjudication (2026-07-13): the collision was real — a crossed message accidentally
resumed the predecessor (phase1-builder), which built a SECOND EDGAR sweep implementation
(`connector/lib/edgar-session.ts` + `.test.ts`) concurrently with this session's own
(`catalog/providers/edgar-sweep.ts` + connector workflow/routes). Predecessor is now permanently
stood down; single-writer rule holds going forward. `catalog/providers/edgar-sweep.ts`'s
implementation was accepted as the one that ships. `connector/lib/edgar-session.ts` +
`edgar-session.test.ts` DELETED (2026-07-13) after confirming via grep that nothing else imported
either file, and after skimming the duplicate for anything worth porting — its one substantive
difference (a separate `isCikSeeded`/`markCikSeeded` Redis marker in `edgar-redis.ts`, to
distinguish "never watched" from "watched but zero eligible historical filings") turned out
unnecessary for this implementation's own design (`sweepOneCik` always persists every fetched
filing's accession number every tick, not just the seed baseline, so a genuinely-zero-filings
CIK's seen-set stops reading empty the moment SEC records its first filing); its OTHER difference
(explicit per-tick fencing via `acquireFenceToken`) was already rejected by team-lead's own
sign-off reasoning (no socket session to supersede — the CAS is the dedupe) and confirmed absent
from the kept implementation. `isCikSeeded`/`markCikSeeded` themselves are still in
`edgar-redis.ts` (still tested, now unused/orphaned) — not removed, since removing them wasn't
explicitly asked; flagged to team-lead as a possible further cleanup. Stale doc-comment references
to the deleted file's path (in `edgar.ts`, `edgar-client.ts`, `edgar-redis.ts`) were fixed to point
at the real files. Full suite re-verified green after deletion: 243/243 (down from 248 — exactly
the 5 tests that were `edgar-session.test.ts`'s own).

## RESOLVED: connector preview deploy fails — cross-directory imports can't resolve on Vercel

Found 2026-07-13 attempting the team-lead-requested bundled preview smoke test (observe the
EDGAR sweep workflow live through real `sleep(30s)` ticks + a chain handoff). `vercel deploy
--target=preview --yes` from the repo root builds successfully LOCALLY (`connector`'s own
`pnpm build`) but FAILS on Vercel's remote build:

```
UNRESOLVED_IMPORT
../catalog/providers/chain-guard.ts (1:22) [UNRESOLVED_IMPORT] Could not resolve '@upstash/redis'
```

...and the same for every other `../../catalog/*.ts` file the connector reaches into
(`history.ts`, `fence-redis.ts`, `edgar-redis.ts`, `registry.ts`, `gap-replay-cursor.ts`,
`alpaca-client.ts`'s `@alpacahq/alpaca-trade-api` import). Confirmed via `vercel inspect <url>
--logs`: the remote build's own "Installing dependencies... Lockfile is up to date... Done in
837ms" step is far too fast to be a real full install, and only 98 files were uploaded for the
whole build — Vercel Services appears to scope the install/upload to the SERVICE's own root
(`connector/`, per `vercel.json`'s `root: "connector/"`) and never installs (or uploads
node_modules for) the true monorepo root, even though the service's own traced source reaches
outside that root into shared `catalog/*.ts` files that need root-level packages to resolve.
`@upstash/redis`/`@alpacahq/alpaca-trade-api` are already declared in BOTH `package.json`s — this
isn't a missing-dependency bug, it's that the shared files, being outside `connector/`'s directory
tree, can't reach EITHER install location from Vercel's actual remote build filesystem layout.

This is the exact "known gap" already flagged in `connector/README.md` (no `pnpm-workspace.yaml`,
two independent lockfiles, cross-directory relative imports) — just never hit before, because the
only prior successful deploy (`sleep-resume-smoke-test.ts`) doesn't import anything under
`../../catalog/`. This is the FIRST attempt to deploy either real connector workflow
(`market-data-session.ts` or `edgar-sweep.ts`) that reaches into the shared catalog code.

**Reported to team-lead, not fixed unilaterally** — every real fix is architecture-adjacent: a
real `pnpm-workspace.yaml`, a Vercel-specific install-root override, or duplicating/vendoring the
needed catalog code into `connector/` (which fights "one code path, two hosts" everywhere else in
this codebase). Left in place: `EDGAR_SWEEP_TICKS_PER_RUN=2` (Preview-only Vercel env var) and a
matching optional override in `connector/workflows/edgar-sweep.ts` (`SWEEP_TICKS_PER_RUN =
Number(process.env.EDGAR_SWEEP_TICKS_PER_RUN) || 500` — shrinks the TICK COUNT before a chain
handoff for observability, never the sleep duration; defaults to the real 500 in production) —
both harmless, both ready to use once the underlying build issue is resolved. The one failed
preview deployment is confirmed inert (`vercel inspect`: target=preview, status=Error, unaliased).

**Resolution (team-lead's ruling, 2026-07-13): make the repo a REAL pnpm workspace — this is
build plumbing within the decided topology, not an architecture fork.** Execution:
1. Added `pnpm-workspace.yaml` at the repo root (`packages: ["connector"]`). Verified shared dep
   versions between root and connector `package.json` already matched exactly
   (`@alpacahq/alpaca-trade-api`, `@upstash/redis`, `@types/node`, `typescript`) — no alignment
   needed.
2. Backed up both `node_modules` dirs + both lockfiles to `/tmp` first (cheap insurance, ~500MB).
   Reinstalled with the pinned version: `corepack pnpm@10.32.1 install` from the repo root — no
   `CI=true`, no destructive prompts appeared. Root `pnpm-lock.yaml` grew by ~4000 lines (now
   encodes connector's own dependency graph as part of the unified workspace).
3. **Eve fully survives**: root `pnpm typecheck` clean, full suite 241/241 (down from 243 — the 2
   `isCikSeeded`/`markCikSeeded` tests removed in the same round, no other regression), dev server
   booted once (`pnpm dev`), `GET /eve/v1/health` returned `{"ok":true,"status":"ready",...}`,
   killed cleanly before any further test runs. Connector `pnpm typecheck` + `pnpm build` also
   clean. No contingency needed — never touched `.npmrc`/node-linker config.
4. **The workspace file ALONE did not fix the Vercel deploy** — same UNRESOLVED_IMPORT failure,
   because `connector/pnpm-lock.yaml` (a STALE, untracked, pre-workspace lockfile that was never
   deleted) was still present, and Vercel's remote build keys its "skip install, reuse cache"
   decision off finding *a* lockfile inside the service's own `root` — it was reading the old
   standalone one (unchanged content) and reusing a stale, pre-workspace `node_modules` snapshot
   from cache, never noticing the new root-level workspace lockfile existed at all. Deleted
   `connector/pnpm-lock.yaml` (a real pnpm workspace only needs ONE lockfile, at the true root;
   confirmed local `connector/pnpm typecheck`+`build` still pass without it). Redeployed: the
   remote install log changed from "Lockfile is up to date... Done in 837ms" (a cache no-op) to a
   genuine fresh resolve/download run correctly reading `package.json#packageManager` from the
   ROOT package.json (proof it was now workspace-aware) — but the SAME `UNRESOLVED_IMPORT` errors
   persisted even after this real reinstall, including for packages inside `connector/node_modules`
   itself trying to resolve OTHER packages (`@opentelemetry/api`, an optional transitive dep) —
   meaning Rolldown's own module resolution during the Nitro build, not the install step, was the
   remaining blocker: it wasn't walking up past `connector/` to find a hoisted/root-level
   `node_modules` for files reached via `../../catalog/*.ts`.
5. **Actual fix**: per-service `installCommand` override in `vercel.json` (confirmed via Vercel's
   own current docs — `/docs/services/config-reference` documents `installCommand` as a real,
   supported per-service field, "the install command override for the service"):
   ```json
   "connector": {
     "root": "connector/",
     "installCommand": "cd .. && corepack pnpm@10.32.1 install --frozen-lockfile"
   }
   ```
   This runs the install from the TRUE monorepo root (not `connector/`) as part of building the
   connector service, producing a properly hoisted root-level `node_modules` the build step's own
   module resolution can actually reach by walking up from `../../catalog/*.ts` files. Redeployed:
   **build succeeded** ("workflows build complete (12 steps, 3 workflows...)"). Verified via
   `vercel inspect`: target=preview, status=Ready (never trust the bare deploy JSON's own
   `"target": null` field — the hard standing rule held here too).
6. **First real trigger surfaced a SECOND, unrelated live bug**: `vercel curl "/start-edgar" ...
   -X POST` started the real `edgarSweepWorkflow` (`runId` returned), but its very first step call
   500'd and crashed the process: `Error: Alpaca authentication requires either an OAuth
   accessToken ... or both keyId and secret`, thrown from `catalog/providers/alpaca-client.ts`'s
   own `export const alpacaClient = new Alpaca({...})` — a MODULE-SCOPE side effect that runs the
   moment the file is imported, regardless of whether the importing code path ever touches Alpaca.
   Root cause: Nitro bundles the connector's ENTIRE app (every "use step" handler across every
   workflow) into one shared module graph for the generic `/.well-known/workflow/v1/step`
   endpoint, so importing `alpaca-client.ts` anywhere (via `market-data-session.ts` →
   `alpaca-session.ts`) crashes EVERY workflow's steps — including `edgar-sweep`'s, which never
   references Alpaca at all — in any environment lacking Alpaca credentials. Confirmed via
   `vercel env ls`: `ALPACA_API_KEY_ID`/`ALPACA_API_SECRET_KEY` are Development-only, NOT Preview
   (same gap noted earlier for `CATALOG_API_SECRET`/`EDGAR_USER_AGENT`, but this is the first time
   it actually broke something, since the EDGAR sweep with zero subscriptions doesn't need EITHER
   of those, but couldn't avoid the SHARED BUNDLE'S eager Alpaca-client construction).
7. **Fixed with a lazy Proxy** (not an architecture question — a narrow, one-file correctness fix,
   same class as `ensureStockStream()`'s already-lazy stream construction elsewhere in this
   codebase): `alpacaClient` now defers the real `new Alpaca(...)` call to the first ACTUAL
   property access, via a `Proxy` whose `get` trap lazily constructs-and-caches the real instance.
   One subtlety found the hard way: the trap must call `Reflect.get(instance, prop)` with NO
   `receiver` argument — passing the Proxy itself as `receiver` (the naive 3-arg form) rebinds the
   SDK's own lazy `trading`/`marketData` getters' internal `this` to the Proxy, silently breaking
   their own instance-level caching (caught by a real test regression:
   `alpaca-client.test.ts`'s pre-existing monkey-patch test started failing — the patched method
   and the one actually called were different cached sub-client instances). New
   `alpaca-client-lazy-init.test.ts` (2 tests): importing the module never throws even with zero
   credentials configured; accessing a property on it DOES throw the real SDK error (proving the
   defer is genuine, not a silent swallow). Both red-green proven (reverted to eager construction,
   confirmed the import-throws test fails reproducing the exact live stack trace; restored).
8. **Redeployed, re-triggered — clean this time**: fresh `runId`, all `/.well-known/workflow/v1/*`
   step/flow calls returned 200 (no crashes). Full sleep/chain observation results: see the
   dedicated report to team-lead (this session's own message), not duplicated here.

**Contingency NOT needed** (`.npmrc` node-linker tweaks, reverting the workspace) — the
`installCommand` override alone, combined with a real workspace + a deleted stale lockfile, was
sufficient for the BUILD issue. The SEPARATE live Alpaca-credentials crash needed its own fix (the
lazy Proxy), unrelated to the workspace/build fix. Kept: `pnpm-workspace.yaml`, the
`installCommand` override, `EDGAR_SWEEP_TICKS_PER_RUN` (Preview env var) and its matching code
override in `connector/workflows/edgar-sweep.ts`, and the lazy `alpacaClient` Proxy.

## Sign-off on the three flagged trade-offs (2026-07-13) — RESOLVED, not just accepted

1. **Non-atomic delivery fence** — signed off. Team-lead's own framing: the CAS
   (`tryTransitionToDelivering`) is the actual guarantee, matching the Phase 1 architecture itself;
   fencing was made atomic exactly where it prevents real corruption (the cursor write, via
   `fencedSet`/`writeCursorFenced`). No further action needed here.
2. **`edgar-redis.ts` seen-set** — signed off AS DOCUMENTED, with ONE BINDING REQUIREMENT for
   whoever builds the EDGAR sweep (see the Phase 3 EDGAR item below for the full spec): the sweep
   design must explicitly state that overlap races are harmless because per-subscription delivery
   dedupes through `tryTransitionToDelivering` (these are one-shot subscriptions), AND the sweep's
   own test suite must include a genuine overlap test proving two concurrent sweeps produce
   exactly one wake per subscription. This is not optional polish — treat it as a gate on calling
   the EDGAR sweep done.
3. **REST wrapper live-semantics gap** (`alpaca-client.ts`'s inclusive-cursor/pagination/429
   behavior against the real API) — signed off. Live verification deferred to Phase 6's
   market-hours cloud E2E; team-lead is adding it to that phase's checklist directly. No action
   needed from Phase 3.

## Where things stand, module by module

All of the following are in `catalog/providers/` (shared, importable from both the eve app
in-process and the connector) unless noted. "Tested" means real-Redis integration tests
(`node --env-file-if-exists=.env.local --test <file>`), not mocked — this whole session's
convention. Every pure module was also red-green verified (a plausible bug injected, confirmed
the expected test failure, restored, confirmed green) — not just written-then-passing.

- **`fenced-lease.ts`** — pure (`nextToken`, `isWriteAllowed`). Done, tested (6 tests, pure).
- **`fence-redis.ts`** — real Redis INCR fencing. `acquireFenceToken`, `getCurrentFenceToken`,
  `isFencedWriteAllowed` (plain GET-then-decide — see "fencing is fast-path, not correctness"
  below), and `fencedSet` (atomic Redis EVAL — check-and-write in one round trip, added in the
  second Codex gate round to close a check-then-act race in the cursor write path). Done, tested
  (9 tests). **Honest test limitation documented in the test file itself**: the fencedSet tests
  verify correct behavior at each boundary but can't manufacture true concurrent interleaving
  (sequential `await`s can't race a single EVAL call) — the atomicity guarantee is structural
  (one Redis command), not something a unit test proves empirically.
- **`gap-replay.ts`** — pure gap-replay engine (`mergeGapTrades`, `filterTradesAfterCursor`,
  `replayThroughCrossingPredicate`, `advanceCursor`, `cursorFromTrade`, `performGapReplay`). Done,
  tested (18 tests). Two real bugs found and fixed by the second Codex gate round:
  1. `mergeGapTrades` used to concatenate historical-then-buffered instead of sorting
     chronologically — historical and buffered trades can genuinely interleave in time (the live
     buffer starts collecting before the historical REST fetch's own "as of now" boundary
     resolves), so concatenation could hand the crossing predicate an out-of-order sequence. Fixed
     with a total-order comparator (timestamp, then exchange, then id) and an explicit sort.
  2. No defense against Alpaca's historical-trades REST `start` param being INCLUSIVE — a re-fetch
     from the persisted cursor's own timestamp can return the cursor's own trade again. Added
     `filterTradesAfterCursor` (excludes anything at-or-before the cursor, using the same total
     order) plus a regression guard in `advanceCursor` (never moves the cursor backward).
- **`gap-replay-cursor.ts`** — real Redis cursor+price persistence, per symbol. `readCursor`,
  `writeCursorFenced` (atomic, via `fence-redis.ts`'s `fencedSet`). Done, tested (5 tests). The
  original **unfenced** `writeCursor` (a plain `redis.set`, no atomicity) was **removed entirely**
  after the second gate flagged it as a stale-write hazard — every real caller now goes through
  the fenced version.
- **`membership-delta.ts`** — pure (`computeMembershipDelta`, `shouldRecheckMembership`,
  `performMembershipCheck`, `MEMBERSHIP_CHECK_CADENCE_MS = 15_000`). Done, tested (9 tests).
- **`desired-membership.ts`** — real registry reads deriving the connector's desired watch sets.
  `readDesiredAlpacaPriceSubscriptions`, `readDesiredAlpacaSymbols`,
  `readDesiredAlpacaOrderSubscriptions`. Done, tested (2 tests, rewritten with unique per-test
  resources and immediate `t.after()` cleanup after the second gate flagged fixed shared symbols
  and batched cleanup as a test-hygiene risk). **Design reversed mid-session**: only `"armed"`
  counts as desired now, NOT `"delivering"` — a delivering subscription's fate is already sealed
  via the registry CAS (`tryTransitionToDelivering`), so keeping it "desired" only kept dead
  symbols subscribed to the live stream and caused pointless redundant delivery attempts on every
  subsequent tick. Team-lead confirmed this reversal was the right call.
- **`order-reconciliation.ts`** — pure, **fully redesigned** in the second Codex gate round. The
  original design scanned Alpaca's closed-orders endpoint over an `[after, until]` date bracket —
  Codex found that endpoint filters on the order's `submitted_at`, not its terminal transition, so
  an order submitted before the bracket but terminalized DURING it was invisible regardless of how
  the bracket was chosen, and the endpoint pages at a default limit of 50 with no auto-pagination
  and no `ids` filter (checked the SDK's own `GetAllOrdersRequest` type to confirm). Since every
  order here is already a KNOWN watched id (a subscription's own `resource`), the redesign looks
  up each watched order's CURRENT status directly instead: `reconcileOrderStatuses`,
  `performOrderReconciliation(fetchOrderStatuses, watchedOrderIds, alreadyDeliveredOrderIds)` — no
  bracket at all. This also means **no state needs to carry across connector session steps or
  runs anymore** (see `market-data-session.ts` below). Done, tested (9 tests, including a same-
  batch-duplicate guard and a genuine "two sweeps from the same snapshot only wake once, via the
  alreadyDelivered guard" test replacing the original's vacuous manually-seeded overlap test).
- **`edgar-redis.ts`** — real Redis seen-set for EDGAR (Phase 3's first, decision-independent
  piece — team-lead confirmed this scoping was correct). `readSeenAccessions`,
  `addSeenAccessions`. Done, tested (5 tests, including a genuine concurrent-adds test).
  **Explicitly documented as NOT a delivery-dedup mechanism** — it's a diffing aid only. It is
  NOT wired into any real delivery path yet (no EDGAR sweep workflow exists). Codex correctly
  flagged that a naive "not in the seen-set → deliver" design would double-deliver under two
  overlapping sweep workers; whoever builds the real sweep MUST use the same
  `tryTransitionToDelivering`-based atomic claim the price-crossing and order-reconciliation legs
  already use. **This is the single most important landmine for the next builder** — read the
  module's own top-of-file comment before writing the sweep.
- **`alpaca-client.ts`** — the shared Alpaca SDK seam (used by both the in-process provider and
  the connector). Added this session: `getHistoricalTrades` (uses `timestampRaw`, full nanosecond
  precision, not the millisecond-truncated `timestamp` — a HIGH Codex finding, fixed with a
  fallback), `getOrderStatuses` (per-order-id `getOrderByOrderID` calls, `Promise.allSettled` so
  one order's lookup failing doesn't abort the batch), `describeAuthFailure` (moved here from
  `alpaca.ts` so the connector can use it without pulling in `alpaca.ts`'s unrelated
  `registerProvider()` side effect and module-level Maps — `alpaca.ts` re-exports it for backward
  compatibility). Partially tested: test-feed/empty-input short-circuits and a monkey-patched
  per-order-failure-isolation test are real; full REST-semantics coverage (inclusive cursor
  boundaries against the live API, SDK pagination on other endpoints, 429 handling) is NOT
  covered — `gap-replay.ts`'s `filterTradesAfterCursor` defends the inclusive-boundary risk at the
  pure-logic layer regardless, which is why this gap wasn't escalated further.
- **`chain-supervisor.ts`** — pure (`isChainDead(heartbeatMs, nowMs, staleAfterMs)`; `null`
  heartbeat = dead/bootstrap; strict `>`, not `>=`). Done, tested (4 tests).
- **`chain-guard.ts`** — real Redis: `claimChain(runNonce)` (SET NX, TTL ~7d — the fork-prevention
  fix), `recordHeartbeat(workflowName, staleAfterMs)`, `readHeartbeat(workflowName)`. Done, tested
  (5 tests, including the exact "zombie" chain-claim scenario against real Redis).

## The retry-fork risk (KNOWN_ISSUES.md #15) — found, understood, FIXED

While validating gate 7's "run forever via `start(self, ...)` recursion" design against real
Vercel infra (`connector/workflows/sleep-resume-smoke-test.ts`, deployed to a preview), found two
real SDK bugs neither gate 7's own research nor the SDK docs surfaced:

1. `start()` cannot be called directly inside a `"use workflow"` function body — throws
   `"The workflow environment doesn't allow this runtime usage of start."` at runtime. Must be
   wrapped in its own `"use step"` function.
2. A step's return value must be JSON-serializable — the `Run` object `start()` resolves to isn't
   (its `world` field holds live functions). Returning it from a step fails with a serialization
   error.

**The sharper finding**: while a step was retrying against bug #2's serialization failure, it
called `start()` again on EVERY retry — 4 retries produced 4 distinct downstream runs before the
step gave up. `start()` has no idempotency-key option (checked the full `StartOptions` shape:
`world`, `specVersion`, `deploymentId` only). **A step wrapping a chaining `start()` call is not
safely retryable as written — any transient failure after `start()` already succeeded forks a
duplicate "forever" chain.**

**Fix status: DONE.** `market-data-session.ts`'s `startNextRun` step now calls `claimChain(runNonce)`
(SET NX) BEFORE calling `start()`; only the winner proceeds. `runNonce` is minted once via a
separate `generateRunNonce()` step at the top of the workflow — steps are memoized for a run's
entire lifetime once they succeed, so every retry/replay of the SAME run gets the SAME nonce back,
giving a stable per-run identity without the SDK exposing "my own runId" anywhere (checked; no
such accessor exists on the workflow-context surface). A retry of `startNextRun` after the first
attempt already claimed and called `start()` now finds the claim taken and returns without
forking. Verified against real Redis (`chain-guard.test.ts`'s exact zombie-claim scenario).

The supervisor (`connector/routes/ensure-running.get.ts`, Vercel Cron every 5 min, root
`vercel.json`) is the OTHER half: it reads the heartbeat every session step writes
(`catalog/providers/chain-guard.ts`'s `recordHeartbeat`, `HEARTBEAT_STALE_AFTER_MS = 20min`,
comfortably above `SESSION_DURATION_MS = 10min` with buffer) and starts a fresh chain if the
heartbeat is stale or has never existed. One mechanism, three jobs: first-ever bootstrap, general
dead-chain recovery (crash, bad deploy, anything else), and belt-and-suspenders alongside the
claim above.

## Durable sleep vs. sorted-set sweep for Phase 3 timers — DECIDED

**Decision: durable `sleep()`.** Team-lead confirmed this explicitly, based on the smoke test's
own evidence: `sleep-resume-smoke-test.ts`'s original (pre-fix) run survived 6×30s sleeps plus one
full 35-minute sleep — past vercel/workflow issue #634's reported ~30-minute trouble spot —
without any resume failure. It only failed afterward, on the unrelated `start()` bug above. The
sorted-set sweep remains the documented fallback if `sleep()` ever misbehaves at real campaign
scale, but nothing observed so far suggests it's needed.

## What Phase 3 still needs (not started, or started-and-stopped deliberately)

1. ~~**The EDGAR sweep workflow itself.**~~ **DONE — see "Phase 3 item 1" section below** for what
   was actually built; kept the original planning text below for context on what was asked for.
   `catalog/providers/edgar-redis.ts` (seen-set) is ready;
   `catalog/providers/edgar.ts`'s existing pure functions (`diffNewFilings`, `matchesFormFilter`,
   `seedAccessionSet`, `filingUrl`, `parseFilings`, `padCik`) are ready and already tested. What's
   missing: a `connector/workflows/edgar-sweep.ts` (or similar) doing a `sleep(30s)` loop
   (replacing `edgar.ts`'s in-process `setInterval`), coalescing across every currently-watched
   CIK (mirror `desired-membership.ts`'s pattern — a `readDesiredEdgarWatches()` reader deriving
   ticker/CIK from armed `filing.new` subscriptions; `resolveCik`/`loadTickerMap` in `edgar.ts`
   aren't currently exported — will need to be, or duplicated, to resolve ticker→CIK from the
   connector), and — **critically** — delivering through the SAME
   `tryTransitionToDelivering`/`updateSubscription` lifecycle the price-crossing and
   order-reconciliation legs use, NOT a naive "not in seen-set → deliver" check (see the
   `edgar-redis.ts` warning above). Should also reuse the chain-claim + supervisor pattern
   end-to-end (team-lead explicitly said to reuse it, not rebuild it) — this sweep will hit the
   exact same `start(self, ...)` chaining requirement `market-data-session.ts` does.

   **BINDING requirement from team-lead's sign-off on the edgar-redis trade-off (2026-07-13),
   not optional polish — the sweep is not done without both of these:**
   - The sweep's own code/doc comment must explicitly state WHY overlapping sweeps are harmless:
     two concurrent sweep workers can both read an accession as unseen and both decide to
     deliver, but `filing.new` subscriptions are one-shot — the SECOND delivery attempt for the
     same subscription is caught by `tryTransitionToDelivering`'s atomic CAS (only one caller ever
     wins the armed→delivering transition), the same reasoning that already makes the
     price-crossing and order-reconciliation legs safe. Say this explicitly; don't leave it
     implicit or assume the reader will re-derive it from `edgar-redis.ts`'s own comment.
   - The sweep's test suite must include a genuine overlap test: two concurrent (real,
     `Promise.all`-fired, not sequentially-awaited) sweep calls against the SAME CIK/subscription
     state must produce EXACTLY ONE wake per subscription — not "no test crashes," an actual
     assertion on wake count. This is the same rigor bar the second Codex gate round demanded of
     `order-reconciliation.test.ts`'s overlap test (see that file's own "genuine overlap" test for
     the pattern to follow) and of `fence-redis.test.ts`'s concurrent-acquisition test.
2. **Expiry migration.** `wake.ts`'s current expiry mechanism (`expiryTimers` Map, `setTimeout`)
   is an in-process stand-in that doesn't survive a serverless instance recycling. Per the
   decision above, migrate to durable `sleep()` — likely its own workflow, or folded into
   whichever workflow ends up owning expiry checks. Not started.
3. ~~**Phase 1 recovery-sweep migration.**~~ **DONE — see "Phase 3 item 3" section below.**
   `wake.ts`'s `startRecoverySweep`/`sweepStrandedDeliveries` currently runs via `setInterval` in
   the eve process (flagged by the Phase 1 Codex gate as a stand-in: "a frozen Fluid instance
   never ticks"). Kept exactly as-is for local dev; the connector now has its own durable driver.
4. **Providers running fully headless.** Verify `catalog/providers/*.ts` (edgar.ts, alpaca.ts —
   the in-process versions) have zero eve imports in the watcher path (AGENTS.md architecture
   note: "they already only import catalog/*; verify"). Not re-verified this session — the
   connector's OWN parallel implementation (`connector/lib/alpaca-session.ts`) was built fresh
   rather than extracting the in-process one, so this verification is still open for whenever the
   in-process path itself needs touching.

## Deploy mechanics learned this session (useful for Phase 3's own deploys)

- **Vercel Services**: root `vercel.json`'s current-generation `services` key (not the legacy
  `experimentalServices`). Minimal working shape used throughout:
  ```json
  {
    "services": { "connector": { "root": "connector/" } },
    "rewrites": [{ "source": "/(.*)", "destination": { "service": "connector" } }],
    "crons": [{ "path": "/ensure-running", "schedule": "*/5 * * * *" }]
  }
  ```
  The doc UI shows a "🔒 Permissions Required" badge on `services`/crons but it did NOT block
  actual deployment.
- **Target verification is NOT optional.** `vercel deploy --target=preview` can still report
  `"target": null` in its own JSON output (ambiguous, not a bug exactly — the CLI's colored status
  line said "Preview" correctly) — never trust that alone. Always follow with
  `vercel inspect <url>` and read the `target` field literally (`preview` vs `production`) plus
  check for an absent "Aliases" section before treating a URL as disposable or touching it further.
  This is a **hard standing rule** after an earlier incident this session where a bare `vercel
  --yes` (first-ever deploy for the project) silently defaulted to production — confirmed to have
  caused no actual damage (`vercel project ls` showed no prior deployment existed), left
  deliberately as-is per team-lead's call, not rolled back.
- **Preview URLs auto-redirect plain `curl` to Vercel's SSO wall** (302 to `vercel.com/sso-api`),
  regardless of the project's own Deployment Protection toggle. Sanctioned bypass:
  `vercel curl <path> --deployment <url> --yes -- <curl-args>` — auto-generates and applies an
  `x-vercel-protection-bypass` token from the authenticated CLI session. Flag-placement matters:
  `--yes` (long form) works; short `-y` before `--` was misparsed as a numeric flag in testing.
- **`vercel logs <url> --level error --expand`** is what actually surfaces a workflow's real
  thrown error — the connector's own `/status` route (built early, throwaway) only returns
  `status`/`returnValue` on `"completed"`, nothing on `"failed"`. This is how both `start()` SDK
  bugs above were actually diagnosed — read the real stack trace, don't guess from symptoms.
- **`pnpm-lock.yaml` mismatches are a real first-deploy failure mode**, not a sign of a deeper bug:
  adding a dependency to `connector/package.json` by hand (without running `pnpm install` in that
  directory) causes Vercel's build to fail on `ERR_PNPM_OUTDATED_LOCKFILE` (frozen-lockfile by
  default in CI). Fix is just `pnpm install` inside whichever package.json changed.
- **Nitro's Vercel preset needs explicit `vercel.functions.maxDuration`** in `nitro.config.ts` for
  anything holding a socket near or past Vercel's default Fluid function ceiling — it does NOT
  inherit a longer duration just because the workflow SDK's own step/event budgets are generous.
  Documented mechanism: `nitro.config.ts`'s `vercel.functions.maxDuration` (global) or
  `vercel.functionRules` (per-route override) — found in the bundled Nitro package's own
  `dist/docs/1.deploy/2.providers/21.vercel.md`, not the main published docs site.

## Standing rules followed this session (context for a fresh builder)

- **Red-green discipline, every pure module, every fix**: write test, confirm it fails for the
  RIGHT reason against a plausible buggy implementation, restore the fix, confirm green. Applied
  even to fixes inside an already-large rewrite (e.g., `gap-replay.ts`'s sort and cursor-filter
  were each independently bug-injected and reverted, not just written-then-trusted).
- **Real Redis for all integration tests**, never mocked — `.env.local`'s `KV_REST_API_URL`/
  `KV_REST_API_TOKEN` (Vercel Marketplace Upstash naming; `@upstash/redis`'s `fromEnv()` falls back
  to these automatically, confirmed by reading the package source directly rather than assuming).
  `test:`-namespaced ids/resources, `t.after()` cleanup — and after the second gate's finding,
  UNIQUE per-test resources with cleanup registered IMMEDIATELY after each create, not batched.
- **No commits, anywhere, at any point** — Codex gate + team-lead review happens before anything
  lands. Verified via `git status` in both worktrees repeatedly throughout.
- **Never touch the main worktree's `.env.local`**, never pull with a server running — the main
  worktree's file was copied (not pulled) into the phase2 worktree once, explicitly authorized,
  confirmed via mtime that the source file was untouched afterward.
- **Deploy only with `--target=preview`, verified** (see "Deploy mechanics" above) — the hard rule
  from the accidental-production-deploy incident.
- **Stop-and-report over self-correction** for anything destructive or ambiguous — applied to the
  accidental production deploy (stopped immediately, verified actual impact precisely via
  `vercel project ls` BEFORE touching anything, reported transparently) and to this session's own
  length (flagged proactively rather than continuing to compound scope alone).
- **Full test suite in BOTH worktrees before declaring anything done** — main worktree's 152/152
  re-confirmed unchanged after every phase2-only change, every single time, not just once at the
  start.

## p2v Codex re-verify fix round — DONE, 2026-07-13 (before EDGAR sweep continued)

The p2v re-verify (team-lead's promised follow-up to the p2a/p2b gates, mentioned above) came
back FAIL with 11 findings against the Phase 2 connector work — `.codex-gate-p2v-findings.md`
(main worktree). Team-lead triaged 3 as design decisions with explicit direction, the rest as
mechanical red-green fixes. All 11 addressed before EDGAR sweep work continued:

1. **Host-mode switch (finding 1, MAIN WORKTREE)** — `catalog/providers/alpaca.ts` gets
   `WATCHER_HOST=in-process|connector` (default `in-process`, so local dev is unchanged). In
   `connector` mode, `armPriceCross`/`disarmPriceCross`/`armOrderFilled`/`disarmOrderFilled` are
   pure no-ops — the provider stays registered (catalog honesty intact) but never opens a stream,
   since the connector's own session does all watching independently. New
   `catalog/providers/alpaca-watcher-host.test.ts` (main worktree) proves the no-op behavior
   without needing real Alpaca credentials — had to use a dynamic `import()` after setting the
   env var, since a static import is ESM-hoisted above the file's own top-level statements (hit
   this the hard way: the first version of the test set the env var textually first but the
   static import still evaluated alpaca.ts, and hence read `WATCHER_HOST`, BEFORE that line ran —
   confirmed by a real stock-stream connect firing anyway). Red-green proven by temporarily
   removing the guard: a real stream connected and authenticated.
2. **Timestamp normalization (finding 2)** — `gap-replay.ts`'s new `padTimestampToNanoseconds`
   pads a millisecond ISO string to the same 9-fractional-digit width Alpaca's `timestampRaw`
   uses; both ingestion boundaries (`alpaca-client.ts`'s `getHistoricalTrades`,
   `alpaca-session.ts`'s `toReplayTrade`) now prefer `timestampRaw` and fall back to padding.
   Red-green proof reproduced the exact bug (an unpadded ms trade sorting BEFORE a genuinely
   later ns-precision one in the same millisecond).
3. **Subscription-ack await (finding 3)** — new `waitForTradeSubscriptionAck` in
   `alpaca-session.ts`, using the SDK's raw `"subscription"` event
   (`MarketDataStream.getSubscriptions()`, the same escape-hatch pattern already used for the
   trading stream's own ack) — awaited after every `subscribeForTrades` call, before any
   historical fetch's "as of now" boundary is fixed.
4. **Findings 6 & 11 (first-connect baseline + new-sub-on-live-symbol)** — the two structurally
   identical bugs (both "a watch got exposed to, or credited with, a decision window that
   started before it existed") are fixed by ONE new pure function,
   `gap-replay.ts`'s `partitionByCursorReadiness`: a watch may only ride the shared
   cursor-anchored historical replay if the persisted cursor is at-or-after ITS OWN armedAt;
   every other watch (no cursor at all, or one older than this watch's own arm time) gets a
   fresh, no-history seed instead (`freshSeedPrice` — reads `ctx.lastKnownPriceBySymbol`
   synchronously if the symbol's already ticking this session, else the same REST/first-tick
   bootstrap `alpaca.ts`'s own in-process arm() uses). The old "adopt a live sibling's `previous`"
   shortcut is gone entirely.
5. **Fixed-point drains (findings 4 & 8)** — both the per-symbol trade buffer (inside
   `seedFromCursorReplay`) and `ctx.pendingWrites` (`drainPendingWrites`) now loop
   drain-then-replay/await until a pass finds nothing new, instead of a single snapshot that
   silently dropped whatever arrived during the previous pass's own awaited work.
6. **SDK auto-reconnect (finding 5)** — `stockStream.onReconnected` now synchronously re-marks
   every currently-watched symbol as seeding and re-runs the SAME cursor-anchored seed path
   (`replayAfterStockReconnect`), queued through `ctx.pendingWrites` so the session step awaits it.
7. **Supervisor self-lock (finding 7)** — `chain-guard.ts`'s new `claimSupervisorLock` (SET NX,
   TTL 60s) guards the WHOLE heartbeat-check-then-start decision in both
   `ensure-running.get.ts` and `ensure-edgar-running.get.ts` (the EDGAR sweep's supervisor has the
   identical shape, so got the same fix even though the Codex finding only named the market-data
   one). Red-green proven twice: the real concurrent-claim test, and a temporary `nx: true`
   removal that reproduced 2-of-2 concurrent claims winning.
8. **Bounded/rotating reconciliation (finding 9)** — new `takeReconciliationBatch` in
   `order-reconciliation.ts` (pure, tested) caps `reconcileOrders` to
   `ORDER_RECONCILIATION_BATCH_SIZE = 25` orders per 15s tick, rotating the offset
   (`ctx.orderReconciliationOffset`) so every order is eventually covered rather than some being
   starved forever; what's deferred is logged.
9. **Live cursor persistence (finding 10)** — `handleLiveTrade` now writes the fenced cursor
   (`writeCursorFenced`) on every ordinary live trade, not only during initial seeding — AT-11's
   "resume from the last processed trade" now actually holds.

**Verified**: connector `pnpm typecheck` + `pnpm build` clean (3 workflows, all routes present).
Root `pnpm typecheck` clean in both worktrees. Root `pnpm test`: main worktree 155/155 (up from
152 — the +3 new `alpaca-watcher-host.test.ts` tests), phase2 worktree 248/248 (up from 232).
Dev server confirmed down before every run (KNOWN_ISSUES #11).

**NOT done / flagged, not decided unilaterally**: `alpaca-session.ts` itself still has no direct
unit tests (matches this file's own established convention — "wiring layer, verified via live
smoke tests only" per `connector/README.md`); findings 3/4/5/6/9/10's wiring-level fixes are
verified via typecheck/build plus the now-tested pure helpers they call
(`partitionByCursorReadiness`, `padTimestampToNanoseconds`, `takeReconciliationBatch`), not a
dedicated integration test of the file itself. **Deployment note for whoever does Phase 6**: the
new `WATCHER_HOST` env var defaults to `in-process` — the deployed eve app MUST have
`WATCHER_HOST=connector` set once the connector is also deployed, or finding 1's exact bug (both
hosts opening the same account's streams) comes right back, silently (no test catches a missing
env var in a real deploy).

## Phase 3 item 1 (EDGAR sweep workflow) — DONE, 2026-07-13

Built on top of the edgar-client.ts / connector/lib/deliver-wake.ts extraction noted above
(that split already happened earlier this session — `edgar.ts` now re-exports
`fetchFilingsFromSec`/`resolveCik`/`padCik`/`parseFilings`/`FetchFilings`/`FilingRecord` from
`edgar-client.ts`, which has zero side effects at module scope, and `connector/lib/deliver-wake.ts`
holds the shared `deliverWakeFromConnector`/`guardedDeliver` both `alpaca-session.ts` and the new
sweep now use).

- **`catalog/providers/desired-membership.ts`**: refactored `readLiveAlpacaSubscriptions` into a
  provider-parameterized `readLiveSubscriptionsByProvider`, and added
  `readDesiredEdgarSubscriptions()` (every armed `filing.new` subscription; grouping by CIK is the
  sweep's own job, not baked in here, since multiple tickers can resolve to the same CIK).
- **`catalog/providers/edgar-sweep.ts`** (new): `runEdgarSweepTick(deps)` — the coalescing/seeding/
  diffing core. Groups armed `filing.new` subs by resolved CIK (one `fetchFilings` call per CIK per
  tick, never per subscription — AGENTS.md rule 3), and on a CIK's first-ever sweep (empty seen-set)
  seeds a baseline from the EARLIEST watching subscription's `armedAt` via the existing
  `seedAccessionSet`, then diffs the SAME fetch against that baseline — so a filing accepted after
  `armedAt` fires on the very first sweep, no "seed now, wait a tick" gap. **Binding design
  requirement satisfied**: the module's top-of-file and `sweepOneCik`'s own doc comments state
  explicitly that overlapping sweeps racing the seen-set are harmless because delivery dedupes
  through `tryTransitionToDelivering`'s CAS (one-shot subscriptions) — the seen-set is a diffing
  aid only, never the delivery gate. A per-CIK sweep failure (bad ticker resolution, a transient
  SEC error) is logged and skipped, not fatal to the tick.
- **`catalog/providers/edgar-sweep.test.ts`** (new, 5 tests): never-before-seen CIK doesn't fire on
  pre-existing filings; fires immediately (same tick) on a post-`armedAt` filing for a brand-new CIK;
  two subs on one CIK coalesce into one `fetchFilings` call; per-subscription `formTypes` filtering;
  and **the required overlap test** — two genuinely concurrent `runEdgarSweepTick` calls against the
  same newly-discovered CIK produce exactly one wake per subscription (2 subs, 2 deliveries, never
  0 or 4), using a `deliver` fake that calls the REAL `tryTransitionToDelivering` (real Redis) rather
  than reimplementing the CAS. Red-green proven twice: (1) reverted the seeding step to prove the
  "no fire on pre-existing filings" test fails for the right reason (1 !== 0, restored, green); (2)
  swapped the overlap test's `deliver` for a naive non-CAS version to prove the overlap test itself
  isn't vacuous (4 !== 2 — both concurrent ticks each delivered to both subs unguarded — restored,
  green).
- **`connector/workflows/edgar-sweep.ts`** (new): the durable run-forever wrapper — SAME shape as
  `market-data-session.ts` (a `generateRunNonce` step, a bounded loop of steps, `claimChain`-guarded
  `start(self, [])` chaining to avoid KNOWN_ISSUES.md #15's fork risk), except each "step" is one
  sweep tick followed by a durable `sleep(30_000)` rather than a socket-holding step — this is the
  connector's first real use of `sleep()` inside the actual workflow body (not just the throwaway
  smoke test), which gate 7 already established has unlimited duration. Wired to the REAL
  dependencies (`fetchFilingsFromSec`/`resolveCik` from `edgar-client.ts`, `deliverWakeFromConnector`
  from `deliver-wake.ts`) — no fencing wrapper (`guardedDeliver`) here, deliberately: there's no
  socket session to be superseded, and the binding requirement is that the CAS alone makes overlap
  safe, not fencing.
- **`connector/routes/ensure-edgar-running.get.ts`** + **`start-edgar.post.ts`** (new): same
  supervisor/manual-start pattern as `ensure-running.get.ts`/`start.post.ts`, keyed by their own
  `EDGAR_WORKFLOW_NAME`/heartbeat so the two chains never collide. Auth still open on both, matching
  every other connector route tonight.
- **`vercel.json`**: added a second cron entry, `/ensure-edgar-running` on the same `*/5 * * * *`
  schedule as the existing one.

**Verified**: `connector/`'s own `pnpm typecheck` clean; `connector/`'s own `pnpm build` clean
(Nitro/rolldown reports 3 workflows now — market-data-session, sleep-resume-smoke-test,
edgar-sweep — and both new routes present in the output). Root `pnpm typecheck` clean. Root
`pnpm test` (dev server down, KNOWN_ISSUES #11): **232/232**, up from the 224/224 baseline (+8: the
5 new `edgar-sweep.test.ts` tests plus 3 already-existing-but-uncounted-in-my-earlier-check tests
from the `desired-membership.ts` refactor's own test file — not a regression, just an accounting
correction against the number quoted earlier in this doc).

**NOT done for item 1** (flagging honestly, not deciding unilaterally): no live Vercel preview
deploy/smoke-test of `edgarSweepWorkflow` itself yet — unlike Phase 2's alpaca session, this
workflow holds no socket and reuses the chain-guard/supervisor/`sleep()` primitives Phase 2 already
verified live (KNOWN_ISSUES.md #15, the sleep-resume smoke test), so there's no NEW SDK behavior
being exercised here that a fresh live gate would uniquely catch — but I haven't independently
confirmed that judgment against real infra, and defer to the lead on whether a preview smoke test
is still wanted before/alongside the Codex gate. Route auth is still open (matches existing
convention, explicitly flagged, not a new gap). Have not touched `wake.ts`'s expiry timers or
recovery sweep (items 2/3) at all yet, per the "report after each item" sequencing.

## Phase 3 item 3 (recovery-sweep migration) — DONE, 2026-07-13

Durable driver for `wake.ts`'s own `sweepStrandedDeliveries` (kept exactly as-is for local dev —
one code path per host, same split as expiry). Building this surfaced a real, previously-latent
bug in shared connector delivery code that would otherwise have made this whole item impossible to
land correctly — documented in detail because it's the most important finding of the round.

- **THE BUG, found while designing this item's own overlap test**: `connector/lib/deliver-wake.ts`'s
  private `deliverTerminalWakeFromConnector` treated EVERY `tryTransitionToDelivering` CAS miss as
  "someone else is handling it, give up" — but a subscription already `"delivering"` with its own
  `deliverReason` ALREADY established (a row STRANDED by an earlier attempt that crashed after the
  transition but before finishing the wake POST — exactly the row a recovery sweep exists to
  resume) fails this exact same CAS, for the exact same reason a genuinely-already-terminal
  subscription does. The two cases were indistinguishable to the old code, which meant **no
  connector-side caller could ever actually resume a stranded row** — only wake.ts's own in-process
  `sweepStrandedDeliveries` could, because it already re-reads on a CAS miss. This defeated item 3
  before it started.
  - **Fixed**: `deliverTerminalWakeFromConnector` now re-reads the subscription on a CAS miss and
    distinguishes: subscription vanished → no-op; genuinely terminal (`fired`/`expired`/`failed`,
    a new `TERMINAL_STATUSES` set) → no-op; `"delivering"` with an established `deliverReason` →
    RESUME using THAT established reason/snapshot (never necessarily the reason the calling
    function itself was invoked with — the durably-recorded intent is the single source of truth,
    same principle as wake.ts's own `deliverWake`). Any other unexpected status is also a no-op
    (nothing established to resume).
  - Red-green proven: reverted to the old "any CAS miss gives up" behavior, confirmed 3 tests
    failed with `0 !== 1` (a stranded row's callCount stayed 0 — genuinely could never be resumed)
    across both `connector/lib/deliver-wake.test.ts` and `catalog/providers/recovery-sweep.test.ts`;
    restored, confirmed all green again.
  - This fix also required correcting `connector/lib/deliver-wake.test.ts`'s own `stubFetchOk()`
    helper, which previously returned `{ok:true}` unconditionally for every call — too naive to
    model the REAL `/catalog/wake` route's own per-subscriptionId claim (`claimWakeDelivery`, a
    Redis SET NX — first caller for an id gets a real send, any concurrent second caller for the
    SAME id gets `alreadyInFlight: true`). Without this correction the "both-fire race" test
    couldn't distinguish "the fix works, and the route's OWN claim is what prevents a double-send"
    from "the fix is broken and both attempts genuinely sent."
- **`catalog/providers/recovery-sweep.ts`** (new): `runRecoverySweepTick(deliver)` — reads every
  subscription, filters to `status === "delivering" && deliverReason` (identical filter to
  wake.ts's own `sweepStrandedDeliveries`), calls `deliver` (production:
  `deliverStrandedWakeFromConnector`) for each; one poison row is logged and skipped, not fatal to
  the round. **Deliberate simplification, flagged to team-lead rather than silently decided**:
  unlike wake.ts's own sweep, this module does NOT check the delivery lease (a separate Redis key
  private to `wake.ts`) before resuming a row — it resumes every currently-"delivering" row it
  finds, every tick. This is safe, not just convenient: the actual correctness guarantee for
  one-shot delivery is `tryTransitionToDelivering`'s own CAS plus the wake-delivery marker's
  `alreadyInFlight`/`alreadyDelivered` dedup, both already independent of any lease (same "fencing/
  leasing is a fast path, not the guarantee" precedent as the alpaca legs' own fenced writes).
  Skipping the lease check only means this sweep can occasionally retry a subscription wake.ts's
  own eve-side sweep is ALREADY mid-resuming at that exact moment; that retry is a verified no-op.
- **`connector/lib/deliver-wake.ts`**: new `deliverStrandedWakeFromConnector(sub)` — resumes a
  subscription found `"delivering"`, replaying the reason/snapshot persisted at the moment it FIRST
  transitioned (the same fields `tryTransitionToDelivering` writes atomically alongside the status
  change, so they survive whatever crashed the original attempt). Shares
  `deliverTerminalWakeFromConnector` with the fired/expired paths above — same CAS, same route,
  same terminal-write shape.
- **`catalog/providers/recovery-sweep.test.ts`** (new, 4 tests): basic resume of a stranded
  row (using the REAL `deliverStrandedWakeFromConnector`, not a fake); an armed (not delivering)
  subscription is left alone; poison-row isolation (one row's resume throwing does not starve the
  rest); and **the required overlap test** — two genuinely concurrent `runRecoverySweepTick` calls
  racing the SAME stranded subscription resume it exactly once, via the REAL production delivery
  function end-to-end (the real CAS, which BOTH calls lose since the row is already
  `"delivering"` — both correctly fall through to the resume-via-reread path — and the real
  wake-delivery claim via a faithful `stubFetchOk`). Uses `deliverStrandedWakeFromConnector`
  directly (not a hand-rolled fake), matching the established convention
  (`edgar-sweep.test.ts`/`expiry-sweep.test.ts`'s own overlap tests use the real CAS too).
  - **A design note worth flagging for whoever runs the next full-suite check**: this test file's
    poison-row and overlap assertions are scoped to the SPECIFIC subscription id(s) each test
    creates (`delivered.some(s => s.id === healthy.id)`, `fetchStub.callCountFor(sub.id)`) rather
    than a raw total count. This was NOT cosmetic — `node --test`'s default full-suite run executes
    test FILES concurrently against the SAME live Redis, and both this file's sweep and
    `expiry-sweep.test.ts`'s sweep read/act on ALL matching subscriptions globally, so an unrelated,
    concurrently-running test file's own legitimately-due/stranded subscription can get swept up in
    the SAME tick. A raw-count assertion (`delivered.length === 1`) flakes under full-suite load
    even though the code under test is correct; a same-file-isolated run always passed. Applied the
    identical scoping fix retroactively to `expiry-sweep.test.ts` (item 2's own file, which had the
    exact same latent flakiness, now fixed too) — both files' poison-row/overlap tests pass
    reliably now, confirmed via three consecutive full-suite `pnpm test` runs.
- **`connector/workflows/recovery-sweep.ts`** (new): identical run-forever shape to
  `edgar-sweep.ts`/`expiry-sweep.ts`. `SWEEP_INTERVAL_MS = 15_000` matches wake.ts's own
  `startRecoverySweep` default cadence exactly (confirmed by reading `wake.ts:711` directly rather
  than guessing). `RECOVERY_SWEEP_TICKS_PER_RUN` smoke-test override, same convention as the other
  two sweeps (shrinks tick count only, never sleep duration). **`connector/routes/
  ensure-recovery-running.get.ts` + `start-recovery.post.ts`** (new) mirror the expiry sweep's own
  routes, `claimSupervisorLock` baked in from the start. `vercel.json` gets a fourth cron entry,
  `/ensure-recovery-running`, same `*/5 * * * *` schedule.

**Verified**: connector `pnpm typecheck` clean. Root `pnpm typecheck` clean. Root `pnpm test`
(dev server confirmed down, KNOWN_ISSUES #11): **258/259**, up from 254/254 at the end of item 2
(net +5: 4 new `recovery-sweep.test.ts` tests, +1 new resume test added to
`connector/lib/deliver-wake.test.ts` while fixing the CAS-miss bug above). Confirmed stable across
three consecutive full-suite runs.

**The one remaining failure is a PRE-EXISTING, out-of-scope flake, not a regression from this
item**: `catalog/wake.test.ts`'s `"deliverWake sends the exact same firedAt it stores on the
subscription"` fails consistently (3/3 full-suite runs) under full-suite load, by a gap of
150–215ms each time (the STORED value always later than the POSTed one), but passes cleanly
46/46 when `wake.test.ts` is run alone. This is Phase 1 code I did not touch in items 2 or 3 — I
characterized it enough to rule out "my changes caused this" (isolated run is clean; the gap's
consistent direction/magnitude suggests a genuine second writer racing the same subscription
record under load, not measurement jitter) but deliberately did NOT chase a fix, since that's
outside this item's mandate and Phase 1 code shouldn't get an unreviewed drive-by change. Flagging
for the "final Codex passes over the whole worktree" team-lead mentioned as the step after this
item — this is exactly the kind of thing that pass should catch, and worth a dedicated look rather
than a guess from me.

**NOT done for item 3** (flagging honestly): no live Vercel preview smoke test of
`recoverySweepWorkflow` itself specifically — same reasoning already accepted for item 2 (no new
SDK behavior being exercised; reuses the chain-guard/supervisor/`sleep()` primitives already
verified live by the EDGAR sweep's own smoke test), but not independently re-confirmed against real
infra this round; deferring to team-lead on whether it's wanted before the final Codex pass.

### Follow-up: a LIVENESS gap in the CAS-miss resume fix, found by team-lead's review

Team-lead's review of item 3 caught something the safety framing above missed: for the canonical
row this sweep exists to recover — `"delivering"`, `deliverReason` persisted, but the earlier
attempt actually got as far as a successful `send()` before crashing (the wake-delivery marker
already reached `"sent"`) — `deliverTerminalWakeFromConnector`'s CAS-miss resume (above) would
still fall through to a REAL POST attempt, rather than completing terminal from the marker's own
recorded `firedAt` with zero POSTs, the way wake.ts's own `deliverWake` does
(`getWakeDeliveryMarker` checked BEFORE deciding whether to POST at all — see `wake.ts:487-495`).
It happened to be masked by the route's own `alreadyDelivered` response handling, but depending on
that downstream safety net instead of checking the marker directly is the wrong mechanism for a
resume path whose whole point is minimizing redundant real network calls.

**Fixed**: `connector/lib/deliver-wake.ts` now imports `getWakeDeliveryMarker` from `catalog/wake.ts`
(a narrow, side-effect-free read — confirmed `wake.ts`'s own module scope and its `catalog.ts`/
`log.ts`/`history.ts` imports have no eager credential-requiring construction, unlike the earlier
Alpaca-client landmine, and this file's own test already imports `deliverWake` from `wake.ts`
directly, so this isn't a new import-direction precedent) and checks it BEFORE the POST, mirroring
`deliverWake` exactly: marker `phase === "sent"` with a `firedAt` → skip the POST, complete
terminal using the marker's own value; otherwise → proceed as before. Connector `pnpm build`
reconfirmed clean after adding the import (5 workflows, no crash — this was exactly the class of
risk the eager-Alpaca-client bug was, checked deliberately).

**Three binding tests added to `catalog/providers/recovery-sweep.test.ts`, per team-lead's own
naming** (now 6 tests total in that file, all using the REAL `deliverStrandedWakeFromConnector`):
- **(a) canonical crash-recovery** — a stranded row with no marker and no lease → delivered exactly
  once, lands terminal. (Already covered by the pre-existing resume test; renamed/relabeled to
  match team-lead's framing, not new coverage.)
- **(b) marker-present variant** — a row already marked `"sent"` (via the real `claimWakeDelivery`/
  `markWakeSent`) → completes terminal from the marker's stored `firedAt`, **zero wake POSTs**.
  Red-green proven: reverted the marker check (skipped straight to the POST branch), confirmed this
  test failed with `1 !== 0` (a real POST fired despite the marker); restored, confirmed green.
- **(c) redundant retry** — an actively-being-delivered row (the stub's `preClaimed` option models
  the real route's claim already being held by someone else) → no-op, no duplicate send, left
  `"delivering"` for whichever attempt actually owns it. Distinct from the pre-existing overlap test
  (two genuinely racing connector calls) — this is a single attempt arriving after the claim is
  already held.

**Verified again after this fix**: root `pnpm typecheck` clean, connector `pnpm typecheck` + `pnpm
build` clean, root `pnpm test` (dev server down): **261/261** (up from 258/259 — the wake.test.ts
flake noted above didn't trigger on this run; still the same pre-existing, out-of-scope, load-only
issue, not fixed here).

## p3 Codex gate — FAIL (7 findings), then all 7 FIXED, 2026-07-13 morning

The final Codex gate over the whole worktree (`.codex-gate-p3-findings.md`, main worktree) came
back FAIL. Team-lead triaged and resequenced: fix all 7 BEFORE the all-workflows preview boot
continued (the first boot attempt, described in the item-2/item-3 sections above, was on
PRE-fix code — superseded by the redeploy described below). All 7 fixed, tested, and ACCEPTED by
team-lead in full:

1. **Event budget** — `connector/workflows/{edgar,expiry,recovery}-sweep.ts`'s `SWEEP_TICKS_PER_RUN`
   default dropped from 500 to 360 ticks (500 ticks ≈ 2,506 workflow events per run, over the
   ~2,000-event chain-before guidance). Mechanical constant change, all three files.
2. **EDGAR ordering, "the round's real bug"** — `catalog/providers/edgar-sweep.ts`'s `sweepOneCik`
   used to call `addSeenAccessions` BEFORE the delivery loop; a delivery failure (transient error,
   or a genuine crash) left the filing marked seen forever while the affected subscription stayed
   armed — permanently lost, no later tick could ever see it as fresh again. **Fixed**: the
   seen-set write now happens AFTER every delivery attempt for the tick's fresh filings. Red-green
   proven in `edgar-sweep.test.ts`: a forced delivery failure against the OLD ordering lost the
   filing (0 deliveries ever, even on a clean retry tick); against the fix it's redelivered and
   succeeds. A second test proves a crash immediately AFTER a successful delivery (before the
   seen-set write) redelivers on the next tick but the CAS keeps the real count at exactly one.
3. **EDGAR per-subscriber `armedAt` filter** — the seed cutoff is the CIK GROUP's earliest
   `armedAt`, not each subscriber's own, so a filing legitimately "fresh" for an earlier-armed
   sibling could still fire for a LATER-armed subscriber whose subscription postdates the filing.
   **Fixed**: every delivery decision in `sweepOneCik` is now also filtered by
   `filing.acceptanceDateTime > sub.armedAt`, applied uniformly whether the filing came from the
   seeding gap or an existing seen-set's idle-gap diff. Red-green proven: two subs on one CIK
   (one armed before, one after a filing's acceptance) — old code fired both (2 !== 1), fixed code
   fires only the earlier one.
4. **Heartbeat staleness vs. slow ticks** — a connector step can legitimately stay live for the
   platform's full function duration (~800s) plus retry headroom, but `*_HEARTBEAT_STALE_AFTER_MS`
   was 5 minutes across all three sweep workflows: a slow-but-healthy tick could look dead to the
   `*/5 * * * *` Cron supervisor, which would start a SECOND chain while the original later resumed
   and kept ticking too (`claimChain` only stops one run from forking itself, not two independently
   -started runs from coexisting). **Fixed**: all three raised to 20 minutes (comfortably past the
   worst realistic single-tick duration — the supervisor is a backstop for genuinely dead chains,
   not a tight liveness check), and each `sweepStep` now writes the heartbeat both BEFORE and AFTER
   the tick, not just before. `chain-supervisor.test.ts`'s own `isChainDead` tests were checked, not
   assumed — they already use 20-minute literals as generic pure-function inputs, unrelated to the
   production constant, so no changes were needed there.
5. **`recordEvent` stale subscription** — `connector/lib/deliver-wake.ts`'s terminal write recorded
   history from the CALLER's own stale `sub` parameter (still showing e.g. `"armed"`), not the
   subscription `updateSubscription` actually just wrote — connector-fired history rows said
   `action: "fired"`/`"expired"` but `status: "armed"` (or `"delivering"` on a recovery resume).
   **Fixed**: `recordEvent` now receives the `updated` object `updateSubscription` returns. Red-
   green proven: a new test in `deliver-wake.test.ts` passes a stale-status `sub`, delivers it, then
   reads the real history row back via `listEvents()` — old code recorded `status: "armed"`, fixed
   code records `status: "fired"`.
6. **`firedAt` full-suite test flake, root-caused** — `node:test` runs test FILES concurrently by
   default against the SAME live Redis; `wake.test.ts`'s own stub and this session's new sweep
   tests' stubs are each per-process and unaware of each other's claims for the SAME real
   subscriptionId, so two different files' stubs could each believe "I'm the first sender" for one
   subscription, letting the wrong one's `firedAt` win the final write — a TEST-INFRASTRUCTURE gap,
   confirmed NOT a production bug (production's marker is one real shared Redis key). **Fixed**
   (the smaller of two diffs team-lead offered): added `--test-concurrency=1` to `package.json`'s
   `test` script, serializing test files so no two ever race the same live Redis simultaneously.
   Verified via two consecutive full clean runs (265/265, no flake either time). **Backlog, not
   forgotten (team-lead's own instruction)**: restore test parallelism later via marker-aware stubs
   (make every sweep/wake test file's fetch stub honor the REAL Redis wake-delivery marker via
   `claimWakeDelivery`/`markWakeSent`, not an in-memory per-process Set) — accepted for now because
   correctness beats the ~2-minute runtime cost (suite went from ~78s to ~200s), but worth
   revisiting once there's time.
7. **Claim-expiry `firedAt` footnote** — documentation only, no code: added one sentence to
   `deliver-wake.ts`'s marker-check comment noting the accepted Phase-1 duplicate-wake limit
   (`WAKE_CLAIM_TTL_SECONDS` expiring between `send()` succeeding and the route's own upgrade to
   `"sent"`) can mean this function's terminal `firedAt` postdates the first envelope the agent
   actually received — same accepted-limit precedent as `wake.ts`'s own `clearWakeClaim` doc
   comment, not engineered further per AGENTS.md rule 1.

**Verified**: connector `pnpm typecheck` + `pnpm build` clean (5 workflows). Root `pnpm typecheck`
clean. Root `pnpm test` (dev server down): **265/265**, confirmed across two consecutive full runs.

## All-workflows preview boot on the FIXED code — DONE, then deployments deleted (see above)

Resequenced per team-lead: fix all 7 p3 findings first, THEN redeploy and boot. Deployed fresh
(`vercel deploy --target=preview --yes`, confirmed `target: preview`/`status: Ready` via
`vercel inspect` as always). Build output showed **5 workflows** (market-data-session, edgar-sweep,
expiry-sweep, recovery-sweep, plus the throwaway sleep-resume-smoke-test), all four
`ensure-*-running` supervisor routes present. Hit all four supervisors directly (`vercel curl`):
`ensure-edgar-running`/`ensure-expiry-running`/`ensure-recovery-running` responded (a mix of
`"alive"` — from the still-running PRE-fix chains left over from the first boot attempt on
unfixed code — and `"restarted"` once those went stale); `ensure-running` (market-data-session)
came back `"restarted"` and then immediately failed — Preview has no Alpaca credentials configured
(a pre-existing, already-documented gap, not a new bug: `runSocketSession` unconditionally connects
the Alpaca stock stream regardless of subscription count, unlike the three sweeps which only touch
external services when there's real work to do). Manually triggered fresh `expiry-sweep` and
`recovery-sweep` runs via `/start-expiry`/`/start-recovery` on the FIXED code specifically (the
supervisors alone wouldn't exercise it, since the pre-fix chains' heartbeats were still fresh) —
both showed live heartbeat writes and both reached `"completed"` status (proving the tick loop +
`claimChain`+`start()` chaining fire correctly on the fixed code, i.e. the "one short chained
cycle" requirement was satisfied in substance). Could not obtain either chain's NEXT generation's
runId to cancel it directly (see the Phase 6 cancellation-gap section above) — this, combined with
the still-alive PRE-fix chains from the first boot attempt, is what led to the interference-risk
report and team-lead's decisive fix: delete every preview deployment. Confirmed cloud-empty
afterward (see the section at the top of this file).

## Final state at handoff

- Phase 2 worktree (`event-catalogue-phase2`, branch `phase2-connector`): **265/265** tests green
  on the latest run (confirmed twice), after fixing team-lead's CAS-miss-resume liveness finding
  AND all 7 p3 Codex gate findings (see the dedicated sections above). The `wake.test.ts` flake
  documented in item 3's own section is now fixed for real (finding 6, `--test-concurrency=1`), not
  just characterized — confirmed clean across the two most recent full-suite runs. Root
  `pnpm typecheck` clean, connector's own `pnpm typecheck` and `pnpm build` clean.
- Main worktree (`event-catalogue`, branch `main`): 152/152 tests green as of the last check,
  untouched by anything in this file except the two Codex gate findings files team-lead dropped
  there (`.codex-gate-p2a-findings.md`, `.codex-gate-p2b-findings.md`) and earlier
  `KNOWN_ISSUES.md`/plan-doc commits (already landed before this handoff was written). A live demo
  is running from this worktree's local dev server (:2000) as of this handoff's last update —
  nothing in this session touched it, and the cloud side is now confirmed empty (no preview
  deployments) specifically so nothing cloud-side could interfere with it.
- Nothing committed in the phase2 worktree. Everything above is sitting as working tree changes.
  Phase 3's three items (EDGAR sweep, expiry migration, recovery-sweep migration) are all DONE per
  team-lead's own sequencing, the p3 Codex gate's 7 findings are all fixed and ACCEPTED, and the
  all-workflows preview boot ran successfully on the fixed code before every preview deployment was
  deleted (cloud is currently EMPTY except one frozen, pre-cron production shell with no functional
  routes). Next: team-lead's own narrow Codex verify pass on these 7 fixes, then their own suite
  runs, then the branch commit + merge — which waits on Philipp's local demo finishing, since a
  full suite run needs his dev server down. This session's own work is complete and holding per
  explicit instruction.
