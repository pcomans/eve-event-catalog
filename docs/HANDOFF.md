# HANDOFF — read this first (rewritten 2026-07-14 ~17:30Z; Phases 1–5 complete, Phase 6 prep merged)

Entry point for the next session. Read `AGENTS.md` (hard rules incl. rule 9 heartbeat
discipline), `METHOD.md`, `KNOWN_ISSUES.md` (#16–#19 are recent; #19 is the Upstash quota
postmortem) before touching anything. Plan: `docs/plan-vercel-production.md` (routing +
deployment-protection decisions updated 2026-07-14). Project memory:
`~/.claude/projects/-Users-philipp-code-event-catalogue/memory/`.

## Where we are (big picture)

**Phases 1–5 are complete and the campaign has PROVEN the core loop unattended**: on
2026-07-14 the 13:30Z market-open wake fired, the agent bought TSM (now ~14.0 shares) and
opened its planned MU starter (~2.02 shares), received both order-fill wakes, re-armed
MU/TSM crossing guards + the filing watch, and parked — no human in the loop. That is
AT-13's spine, demonstrated on live (paper) markets.

**Phase 6 prep is BUILT, gated (p6a–p6e: three FAIL→fix cycles, two clean PASSes), and
merged**: task #27 (connector-mode get_latest_price Redis-cursor fallback + deterministic
watcher-host test), #32 (zero-P&L rendering), the THREE-SERVICE vercel.json (the eve app
had never been declared a service — connector's old catch-all claimed all traffic and would
have silently killed eve's auto-generated schedule cron at `/eve/v1/cron/<hash>`; the
ordered rewrite table fixes this, observatory is the public catch-all), CRON_SECRET
fail-closed auth on all 11 connector routes, and task #33's Redis burn reduction (MGET
batching, 2s server-side read cache, 5s cursor-write throttle) plus the cursor-write
serialization/shutdown hardening the gates forced out of it.

**A preview deployment validated the topology end-to-end** (target=preview verified per
KNOWN_ISSUES #13): all three services build (explicit `framework` fields required — nested
roots make auto-detection ambiguous), routing works, connector's cross-root import of
catalog/auth.ts bundles fine, one real eve turn and one complete connector Workflow run
(sleep/resume smoke test) executed on world-vercel. Preview env vars are provisioned
(7 vars incl. CRON_SECRET). NOT yet verifiable on preview: cron REGISTRATION (Vercel crons
fire only on production) and KNOWN_ISSUES #7's wake-race re-verification (needs a
market-hours cloud E2E).

**Infra events of 2026-07-14**: the Upstash free tier (500k commands/month) died ~2h into
the first live market session — reads dominated (768k; the observe/observatory 2s polls ×
N+1 registry fan-out). Philipp upgraded the db to a paid plan; task #33 then cut the burn
~10×. Deployment-protection posture REVISED (Philipp): previews stay SSO-walled (use
`vercel curl ... --deployment` bypass), only the production observatory is public; preview
wake loopbacks need VERCEL_AUTOMATION_BYPASS_SECRET. All dead registry rows were deleted
with Philipp's approval (fenced script; registry holds only live rows).

## Operational invariants (the expensive lessons — unchanged, see git history for detail)

1. Any main-tree file edit hot-reloads the live dev server; build in a worktree; during a
   rollout window, docs are written BEFORE restart; after the re-arm turn, no main-tree
   edits at all.
2. `pnpm test` needs the server DOWN; a restart costs campaign-5 ONE re-arm turn (POST
   /catalog/chat — the body key is `conversationId`, NOT `conversation`; the wrong key
   creates a stray conversation-less session).
3. Don't purge `.workflow-data` on a plain restart.
4. Codex gates: `--write`, findings-file VERDICT protocol, watch the file not the process.
5. `vercel env pull` (server down) refreshes OIDC ~12h; AI Gateway auth rides it.

## First thing on resume: check the campaign is alive

`GET /catalog/subscriptions` — expect armed rows for campaign-5 (TSM $400/$445 crossings,
MU crossing pair, TSM filing watch, plus whatever it armed since; the agent re-arms a
market-open clock wake each day). LangSmith Threads `thread_id=campaign-5` shows turns.
If the server died: restart, purge nothing, ONE re-arm turn, note the gap honestly.

## Next work, in order

1. **Production deploy** (Philipp gate — production deploys always stop for him): promote
   env vars to production scope (same 7 as preview; WATCHER_HOST=connector is MANDATORY),
   deploy, verify cron REGISTRATION (the market-open schedule must appear in the project's
   cron list and fire at 13:30Z weekdays), re-verify KNOWN_ISSUES #7 on world-vercel.
2. **Cloud E2E ×2 during market hours**: subscribe → park → real cross → wake → autonomous
   trade → fill wake → visible on the public observatory. Task #27's fallback makes the
   test feed usable if needed.
3. **Launch the standing campaign in the cloud**, observe ONE full unattended market day
   (guardrails hold, feed populates, no human intervention), THEN the link goes to Pranay.
4. Backlog: #21 (idempotent subscribe_event), unsubscribe tool, marker-aware test stubs,
   workflow run-cancellation path, winter-DST schedule gap, ai-elements lint (on upgrade).

## Decisions locked (do not re-litigate)

Everything previously locked (topology, DeepSeek V4-Pro, one perpetual conversation, paper
only, turn cap fail-open, ai-elements UI base, inception-equity P&L baseline), plus:
**routing table** (explicit eve service; /catalog + /eve/v1 → eve; 11 explicit connector
paths; observatory catch-all) · **connector auth = CRON_SECRET convention, fail-closed** ·
**previews stay SSO-walled; production observatory public** · **cursor writes serialize per
symbol; whole replays serialize; regression rejected at the fenced write** · **Upstash paid
plan** (Philipp, 2026-07-14) · **stream proxy maxDuration=800; reconnect absorbs the
ceiling**.

## Team state

Stood down permanently (no-reactivation protocol; any message = resume; reactivation only
via literal "REACTIVATE <name>"): phase1-builder, phase3-builder, harness-builder,
fix-builder, phase4-builder, phase5-builder, and **phase6-builder** (stood down at Phase 6
prep close, this session). One writer per worktree. The `../event-catalogue-phase6`
worktree is merged and removable (carries untracked gate findings + env copies —
intentionally uncommitted). Codex runtime healthy; narrow passes; `--write`; findings-file
protocol.
