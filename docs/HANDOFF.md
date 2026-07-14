# HANDOFF — read this first (rewritten 2026-07-14 ~00:45Z, Phases 1–4 complete)

Entry point for the next session. Read `AGENTS.md` (hard rules incl. rule 9 heartbeat
discipline), `METHOD.md` (how the lead/builder/Codex team operates, two postmortems),
`KNOWN_ISSUES.md` (#2 and #14 have 2026-07-13 addenda; #15 is the retry-fork bug) before
touching anything. Plan: `docs/plan-vercel-production.md`. Project memory:
`~/.claude/projects/-Users-philipp-code-event-catalogue/memory/`.

## Where we are (big picture)

**Phases 1–4 of the production plan are BUILT, Codex-gated, MERGED on `main` (5528136), and
pushed.** That includes: the delivery backbone, clock provider, the connector runtime with
run-forever chains and EDGAR/expiry/recovery sweeps (pnpm workspace), the demo-day observatory
page (post-demo gate round: 8 findings fixed), and Phase 4's mandate agent — DeepSeek V4-Pro
via AI Gateway, position-bounded sell tool, per-day turn cap, rewritten instructions,
market-open schedule. Suite on main: **300/300** (serialized, `--test-concurrency=1`).

**The standing campaign (campaign-5) is LIVE on Philipp's machine, running Phase 4 code**:
dev server on :2000, caffeinate tied to the server PID, one perpetual conversation (locked
decision), session parked on: a clock wake for **2026-07-14T13:30Z** (Tue 9:30 ET open), TSM
exit-stop $400 / partial-profit $445 crossings, and a formTypes-filtered TSM filing watch.
Account holds 9.335 TSM shares (campaign-2's buy) + ~$96k cash; the agent plans to evaluate
adding TSM and a Micron starter at the open, ~$5–10k sizing. Live view:
`localhost:2000/catalog/observe?conversation=campaign-5` — reasoning bubbles verified live on
DeepSeek (its reasoning stream renders in-place, the page's headline feature works).

**The cloud is still empty by design**: no preview deployments; only the inert accidental
pre-cron production shell at event-catalogue.vercel.app (Philipp decided 2026-07-13: leave it
until Phase 6 replaces it).

## Operational invariants while the campaign runs locally (the expensive lessons)

1. **Any file edit in this worktree hot-reloads the dev server** (KNOWN_ISSUES #2) and can
   orphan the parked campaign session (#1). Build ANYTHING nontrivial in a separate git
   worktree on a branch (Phase 2/3 used `../event-catalogue-phase2`, Phase 4 used
   `../event-catalogue-phase4`); merge + controlled rollout after gates.
2. **`pnpm test` requires the dev server DOWN** (#11) — and stopping/restarting the server
   kills the campaign's IN-PROCESS timers and stream watchers (clock wakes, crossings, EDGAR
   poll). After any restart: send campaign-5 ONE re-arm turn via POST /catalog/chat ("watchers
   reset by restart — re-subscribe to what you still want, including your next market-open
   wake"). Its old armed rows become permanent corpses (no unsubscribe tool — backlog); their
   deletion is Philipp-approval-gated (the auto-classifier blocks registry-delete scripts;
   he has approved this class twice — ask, don't assume).
3. **Purge `.workflow-data` only when channel/instrumentation/agent files changed** since the
   parked session was created (that's what orphans it) — purging costs the conversation its
   MEMORY (the perpetual-conversation continuity), so don't purge on a plain restart.
4. **Codex gates need `--write`** on the companion CLI, scoped in the prompt to the findings
   file — the default read-only sandbox silently blocks the file-append verdict protocol
   (learned in gate pass A). Run worktree gates from that worktree's cwd (own broker tree).
5. **`vercel env pull` refreshes OIDC (~12h)** — server down first, always. AI Gateway auth
   locally rides VERCEL_OIDC_TOKEN (no AI_GATEWAY_API_KEY provisioned; probe-verified).

## First thing on resume: check the campaign is alive

If resuming after 2026-07-14 13:30Z: verify the market-open wake actually fired (observe page
event feed, or GET /catalog/subscriptions — the clock row should be `fired`; LangSmith Threads
`thread_id=campaign-5` shows the turn). If the laptop slept or the server died, the campaign
dead-ended SILENTLY — restart the server, purge nothing, send the one re-arm turn (invariant
2), and note the gap honestly in the campaign record. Silence is a failure signal (AGENTS.md
rule 9) — this applies to the campaign itself, not just builders.

## Next work, in order

1. **Phase 5 — public observatory** (plan lines ~264-275). Task #28 FIRST (DeepSeek's
   message.appended deltas flood the transcript with empty type-label blocks —
   catalog/observe-page.ts, safe leaf file, coalesce in-place like the reasoning fix or skip).
   Then the real pages: campaign view (equity curve/positions/P&L — load the dataviz skill),
   subscriptions table, event feed, decision view threading transcripts into the timeline.
   UI base: evaluate vercel/chatbot ONLY via a time-boxed spike if it reduces work (Philipp's
   directive; likely value is message-rendering components, not the skeleton). Audience is a
   Vercel engineer — presentation quality matters.
2. **Phase 6 — deploy + cloud E2E + campaign launch** (plan lines ~277+). Mandatory env on the
   deployed eve app: WATCHER_HOST=connector (now fail-closed on typos), CATALOG_API_SECRET,
   CAMPAIGN_CONVERSATION_ID (the market-open schedule reads it; schedule cron never fires in
   eve dev, so its cadence is rollout-verified here). CATALOG_BASE_URL auto-derives from
   VERCEL_URL since p4c. Task #27 BEFORE the cloud E2E if it uses the test feed. KNOWN_ISSUES
   #7 re-verification on world-vercel. Preview deploys: verify target via `vercel inspect`,
   ALWAYS (#13). Cloud E2E ×2 in market hours, one unattended market day, THEN the link goes
   to Pranay.
3. Backlog: #21 (idempotent subscribe_event), #27 (gate-C deferrals), #28 (if not done in
   Phase 5 kickoff), marker-aware stubs to restore test parallelism, workflow run-cancellation
   path, an unsubscribe tool (corpse-row problem), Deployment Protection toggle (Philipp),
   winter-DST schedule gap (fires 8:30 ET after the November time change — documented in
   agent/schedules/market-open.ts).

## Decisions locked (do not re-litigate; full list in plan + memory)

Three-service Vercel Services topology · durable sleep for timers · chain-claim +
supervisor-cron (#15) · DeepSeek V4-Pro (`deepseek/deepseek-v4-pro`, legacy aliases deprecate
2026-07-24) + Gateway parallelSearch (auto-wired by eve for Gateway models — no override code;
escalation path: gpt-5.6-terra + native webSearch) · ONE perpetual campaign conversation ·
Deployment Protection OFF · buy + position-bounded sell, no shorting/margin, paper only ·
guardrails = turn cap only (MAX_TURNS_PER_DAY=200, fail-OPEN on cap-store errors — lead
decision, p4b) · oversell REJECTED not clamped · production shell stays until Phase 6.

## Team state

ALL prior builders are STOOD DOWN permanently with the explicit no-reactivation protocol:
phase1-builder, phase3-builder, harness-builder, fix-builder, phase4-builder. A message to any
of them RESUMES it (METHOD.md postmortem) — never message them; reactivation requires the
literal phrase "REACTIVATE <name>", which only Philipp or the lead should ever decide to use.
One writer per worktree, ever. The `../event-catalogue-phase2` and `../event-catalogue-phase4`
worktrees are merged and redundant — safe to `git worktree remove` (phase4's has untracked
.codex-gate-p4* scratch files; the equivalent demo-round files sit untracked in the main tree
too — session scratch by convention, never committed, content summarized here and in commits).
Codex runtime: healthy; narrow passes; file-append verdicts; `--write` required (invariant 4).
