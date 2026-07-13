# connector (Phase 2 — real Alpaca wiring, two Codex gate rounds)

The connector runtime as its own Vercel Service (`docs/plan-vercel-production.md` Phase 2):
chained Workflow steps hold the real Alpaca market-data/`trade_updates` sockets, with the same
provider/watcher logic the eve app runs in-process today ("one code path, two hosts").

**Status: real wiring, typechecks and builds clean** (`pnpm typecheck`, `pnpm build`), fork-safe
chaining + a bootstrap/recovery supervisor added, and TWO rounds of Codex gate review (12 findings
total — 5 P0/HIGH-severity correctness bugs, 7 P1/MEDIUM — see below) addressed. Deployed and
verified on a real Vercel preview (the `sleep-resume-smoke-test` workflow, not the connector
workflow itself — see KNOWN_ISSUES.md #15). The connector workflow (`market-data-session.ts`)
has not yet been run end-to-end against real Alpaca on deployed infra — it's built against the
same real Redis/Alpaca REST seams the pure prerequisite modules are integration-tested against
(`catalog/providers/*.test.ts`), and it typechecks/builds through Nitro's workflow transform, but
nobody has watched it hold a live socket in production yet.

## What's here

- `nitro.config.ts` — registers the `workflow/nitro` module and `vercel.functions.maxDuration: 800`
  (a Codex gate finding: without this, the socket-holding step's Vercel Fluid function defaults to
  a much shorter ceiling than the session duration budgeted against).
- `lib/alpaca-session.ts` — the real wiring: opens Alpaca's `StockDataStream`/`TradingStream`,
  buffers live ticks per symbol from the moment of subscribe (not just after gap-replay completes
  — a Codex gate finding: the original version merged an empty buffer, silently losing the
  connect-time window), gap-replays every watched symbol on connect through
  `catalog/providers/gap-replay.ts` (chronologically sorted merge, cursor-boundary filtering, a
  cursor persisted per-symbol via a FENCE-ATOMIC write in `gap-replay-cursor.ts`), reconciles
  `order.filled` subscriptions by looking up each watched order's CURRENT status directly
  (`order-reconciliation.ts` — no closed-orders date bracket; Alpaca's own bracket filters on
  `submitted_at`, not the terminal transition, so it couldn't actually do what it claimed to), and
  rechecks desired subscription membership on prereq 3's 15s cadence — incrementally, preserving
  each subscription's own crossing state across ticks rather than discarding it. Delivers wakes
  through the SAME armed→delivering→terminal lifecycle wake.ts's own `deliverWake` uses
  (`registry.ts`'s `tryTransitionToDelivering`/`updateSubscription`) before POSTing to eve's
  `/catalog/wake`, so a subscription can't fire twice or hang stuck "armed" forever.
- `workflows/market-data-session.ts` — the run-forever shape: a bounded loop of
  `SESSION_STEPS_PER_RUN` calls into `runFencedAlpacaSession()`, a heartbeat write each step
  (`catalog/providers/chain-guard.ts`, read by `routes/ensure-running.get.ts`'s supervisor), then
  the run recurses into a fresh one via `start(self, [])` — wrapped in its own `"use step"` AND
  guarded by a `claimChain()` SET-NX (KNOWN_ISSUES.md #15: a step retrying after `start()` already
  succeeded would otherwise fork a duplicate forever-chain) — before its own per-run ceilings
  (25,000 events / 10,000 steps / 240s max replay) would ever bind. No `continueAsNew` primitive
  exists in this SDK; recursion across runs is the only "forever." No state carries across steps
  or runs anymore — the order-reconciliation redesign above dropped the last thing that needed one.
- `routes/ensure-running.get.ts` — the supervisor: reads the heartbeat, and if it's gone stale (or
  never existed), starts a fresh chain. Wired as a Vercel Cron (root `vercel.json`, every 5 min) —
  this is how the connector bootstraps on first deploy AND recovers from a dead chain for any
  reason other than the fork risk above (which `claimChain()` already covers).
- `routes/start.post.ts` — manually triggers the connector workflow (smoke tests, deliberate
  restarts). Auth is still open on all routes here — fine for a preview, not for a real deploy.
- `workflows/sleep-resume-smoke-test.ts` — throwaway, but the thing that actually validated the
  recursion shape against real infra (KNOWN_ISSUES.md #15): survived 6×30s + one 35-minute sleep
  past vercel/workflow issue #634's reported trouble spot, then caught two real bugs in the
  `start(self, ...)` chaining pattern gate 7's own research hadn't surfaced.

## Nitro vs. Vite adapter — why Nitro

`workflow@4.6.0` ships adapters for both (`@workflow/nitro` and `@workflow/vite`). Picked Nitro:
`spikes/vercel-queue-smoke/` already proved the Nitro path works cleanly for a standalone Vercel
Service in this exact repo (and documented its gotchas — `serverDir`, `registerDevConsumer` for
`@vercel/queue`), and the main eve app is Nitro-based too, so there's one bundler's worth of
institutional knowledge instead of two. `@workflow/nitro` itself still uses Vite/Rollup
internally for its own bundling, so nothing about correctness hinges on this choice — it's purely
"reuse what's already been debugged in this repo."

## Known gap: cross-package imports

`lib/alpaca-session.ts` and `workflows/*.ts` import `catalog/providers/*.ts` and
`catalog/history.ts`/`registry.ts`/`types.ts` via relative paths reaching outside this package
(`../../catalog/...`) — this worktree has no `pnpm-workspace.yaml` yet, so `connector/` and the
root app are two independent npm packages, not real workspace siblings. Typechecks and bundles
fine today (confirmed via `pnpm build` — Nitro's Rolldown build traces and bundles the imports
correctly, including `@alpacahq/alpaca-trade-api` and `@upstash/redis` as separate dependencies
declared in `connector/package.json`), but a real long-term setup should still move to an actual
pnpm workspace or a small shared internal package rather than relying on relative-path resolution
across two independently-versioned package.json files staying in sync by hand.

## Deliberate, reasoned trade-offs (not full fixes) from the second Codex gate round

- **Fencing for wake delivery is a fast-path skip, not the correctness guarantee.**
  `isFencedWriteAllowed()` (checked before a delivery attempt) is a plain GET-then-decide, not
  atomic with the delivery itself — Codex flagged this as a check-then-act race. It's true, but the
  ACTUAL safety net for delivery is `tryTransitionToDelivering`'s own atomic CAS (registry.ts,
  shared with wake.ts's `deliverWake`): a zombie session that slips past a stale fence check still
  can't double-deliver, because the CAS only lets ONE caller ever win the transition to
  "delivering," regardless of fencing. The fence check just avoids wasted work by a session that's
  probably already stale. `fencedSet` (a real atomic Redis EVAL) WAS added for the cursor write,
  where fencing genuinely is the only protection. Flagged for anyone who wants this hardened
  further rather than silently left as-is.
- **`catalog/providers/edgar-redis.ts`'s seen-set is a diffing aid, not a delivery lock**, and its
  own module comment says so explicitly now. It isn't wired into any real delivery path yet (Phase
  3's EDGAR sweep workflow doesn't exist), so the SMEMBERS-then-SADD race Codex flagged can't
  actually double-deliver anything today — but whoever builds that sweep must use the same
  `tryTransitionToDelivering`-based claim the price-crossing/order-reconciliation legs already do,
  not treat "not in the seen-set" as the delivery gate.
- **`alpaca-client.ts`'s new REST wrappers have partial test coverage.** The test-feed short-circuit
  and empty-input short-circuits are tested without hitting the network; `getOrderStatuses`' per-
  order failure isolation is tested via a minimal monkey-patch of the one SDK method involved. Full
  REST-semantics coverage (inclusive cursor boundaries against the real API, SDK pagination for
  other endpoints, 429 handling) remains untested — `gap-replay.ts`'s `filterTradesAfterCursor`
  already defends the inclusive-boundary risk at the pure-logic layer regardless of what the live
  API does, which is why this wasn't escalated further.

## Not yet done

- The connector workflow itself has not been run end-to-end against a deployed preview with real
  Alpaca sockets open (the smoke test that WAS run validates the recursion/sleep/chain-guard
  mechanics, not this workflow's own body).
- Delivery is a direct HTTP POST to `/catalog/wake` — the Queues topic insertion mentioned in the
  Phase 2 plan is a smaller follow-up diff, not done here.
- Route auth (`start.post.ts`, `ensure-running.get.ts`, `smoke-test.post.ts`) is still open — a
  public GET/POST that can start a workflow run needs a real secret check before production.
