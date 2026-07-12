# HANDOFF — read this first

Entry point for the next session. Written 2026-07-12. The forward plan is
`docs/plan-vercel-production.md` (self-contained); this doc is the *current state + decisions +
open threads* on top of it. Also read `AGENTS.md` (hard rules) and `KNOWN_ISSUES.md` before any
code. Project memory: `~/.claude/projects/-Users-philipp-code-event-catalogue/memory/`.

## Where we are

- **Local POC is complete, Codex-gated, and public** at github.com/pcomans/eve-event-catalog.
  HEAD = **ee77dfa** on `main`, tree clean (only untracked `.claude/`). 86 tests green.
- What exists: eve app (Nitro, port 2000) with catalog channel (chat/wake/subscriptions),
  declarative `catalog/catalog.json` (Ajv-enforced, server-side-only onWake guidance),
  Redis-backed registry, wake delivery (in-process claim + expiry timers), Alpaca provider (SDK
  `4.0.0-alpha.3`, push-based, edge-triggered crossings), EDGAR provider (coalesced 30s/CIK
  poll), 5 fully-autonomous agent tools, LangSmith OTel.
- **The next phase has NOT started.** No production/Vercel/observatory/mandate-agent code exists
  yet. The plan doc is approved but unbuilt.

## Decisions locked this session (do not re-litigate)

All confirmed with Philipp 2026-07-12 and folded into the plan (commits 17f732e, ee77dfa):

1. **Full realtime connector** is the point (not the polling fallback) — the 4 correctness
   prerequisites are the majority of the build.
2. **Topology: ONE Vercel project, THREE Vercel Services** — eve app + connector-runtime (public
   `workflow` pkg) + Next.js observatory; private bindings; shared Upstash Redis; atomic deploy.
   Same-app Workflows are INFEASIBLE (eve vendors `@workflow/*` `5.0.0-beta` privately; public
   `workflow` is `4.6.0`, incompatible; `/.well-known/workflow` route collision). Vercel Services
   preserves the "one deploy on Vercel" story.
3. **Model: DeepSeek V4-Pro via Vercel AI Gateway.** Use model id `deepseek-v4-pro` — NOT the
   legacy `deepseek-chat`/`deepseek-reasoner` aliases (they **deprecate 2026-07-24**, would break
   the campaign mid-run). eve reaches it via AI Gateway OIDC (no DeepSeek key in prod; local dev
   needs `AI_GATEWAY_API_KEY`).
4. **Mandate: fully open** — agent picks symbols, strategy, sizing. Trades: **buy + sell held
   positions**, no shorting. **Guardrails minimal**: a runaway/loop turn-cap only (cost is not a
   constraint on a cheap model + paper money); do NOT add notional / trades-per-day /
   max-subscription blockers — they constrain the showcase autonomy. Keep the existing
   paper-only / buy-side / market / day-order correctness bounds.
5. **Observatory is read-only and fully public**, including **all conversation transcripts**
   (agent reasoning + tool calls — "see it think"). Chat/subscribe stay private. Reuse eve's
   `defaultMessageReducer` (`eve/react`|`eve/client`) to render transcripts server-side from
   `GET /eve/v1/session/:id/stream?startIndex=0`; equity/positions/subscriptions/feed are custom
   Next.js over Redis + the Alpaca account. No prebuilt eve chat page exists.
6. **Vercel Pro is available** (Fluid 800s/1800s, Queues, Cron).
7. **Process:** Sonnet agents build/test (TDD red-green, node:test), lead orchestrates + writes
   docs only, every coding step gets a Codex gate (gpt-5.6-sol xhigh, narrow passes — long
   verdicts hang; kill the repo's broker tree on ≥3min silence, retry). Check npm versions before
   adding deps. Verify `git log` before believing any "done". Stage by full-diff review.
8. **Architecture forks STOP and ask Philipp** before committing to a branch (both known forks —
   connector host, dashboard host — are already decided above; this applies to *new* forks).

## Phase 0 research — RESOLVED (deploy-research + dashboard-research, 2026-07-12)

Full findings are in the plan's Phase 0 section. Key facts the build depends on:

- **Queues**: `@vercel/queue@0.4.0`, `send()`/`handleCallback()`, `experimentalTriggers`
  `queue/v2beta` makes consumer routes private; not Pro-gated.
- **Alpaca gap replay on FREE IEX is viable** — the 15-min delay is SIP-only. Dedupe key
  `i`+`x`+`t`; order reconciliation via `GET /v2/orders?status=closed&after=&until=`.
- **eve deploy**: ordinary Vercel project; `vercel deploy` (**NOT `--prebuilt`**); route-auth
  secrets must be real Vercel env vars. Self-invoking wake loopback works UNLESS Deployment
  Protection is on → then attach `VERCEL_AUTOMATION_BYPASS_SECRET`.
- **No eve session-list API exists** — track sessionIds in Redis (we already do).

## Open threads (carry into the build — none block starting)

1. ~~Gate 7 — the "run forever" API~~ **RESOLVED 2026-07-12** (gate7-research): recursion across
   runs via `start(self, [state])` in the final step (no `continueAsNew`); chain before ~2,000
   events; ws steps capped by Fluid ceiling (800s GA ≈ 12-min sessions); steps retry from the
   top → through-write + idempotent + drop=return. Full findings:
   `docs/architecture.md` ("How workflow@4.6.0 expresses 'forever'"). One carry-over: verify
   vercel/workflow issue #634 (sleep-resume) on a preview deploy early in Phase 2.
2. **world-vercel pre-park buffering (KNOWN_ISSUES #7)** — structurally likely to hold (eve's
   buffering is world-agnostic), but the network round-trip changes the race window. **Hard
   test on a real preview deploy before trusting arming (Phase 6 gate).**
3. **Queues-from-Nitro** — no doc confirms clean use from a Nitro route; smoke-test early in
   Phase 1.
4. **Task 7 (supervised local live market-hours demo, twice)** is still formally open; likely
   subsumed by Phase 6's cloud E2E but not yet confirmed as such.

## How to resume

Read `docs/plan-vercel-production.md` and execute Phases 0→6, authoring **AT-10…AT-14**
(`docs/acceptance-tests.md`) FIRST (tests-before-build applies to acceptance criteria). Before any
live/demo work: `vercel env pull` with the dev server DOWN (OIDC ~12h; the pull OVERWRITES
`.env.local`), fresh conversation ids. New secrets to promote to Vercel prod when their phase
lands: `CATALOG_API_SECRET`, `TAVILY_API_KEY`, `AI_GATEWAY_API_KEY` (local only).
