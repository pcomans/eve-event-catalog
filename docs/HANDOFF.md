# HANDOFF — read this first (rewritten 2026-07-13, post-demo gate round complete)

Entry point for the next session. Read `AGENTS.md` (hard rules incl. rule 9 heartbeat
discipline), `METHOD.md` (how the team works, two postmortems), `KNOWN_ISSUES.md` (#11–#15
recent; #2 and #14 got load-bearing addenda 2026-07-13 evening) before touching anything.
Plan: `docs/plan-vercel-production.md`. Project memory:
`~/.claude/projects/-Users-philipp-code-event-catalogue/memory/`.

## Where we are (big picture)

- **Phases 1–3 of the production plan are BUILT and Codex-gated.** Phase 1 + clock provider +
  the demo-day batch (now gated too, see below) are on `main`. Phases 2–3 (connector service,
  gap replay, fencing, chain-guard + supervisor, EDGAR/expiry/recovery sweep workflows, pnpm
  workspace) live on branch **`phase2-connector`** (151f698, pushed), built in the worktree
  `../event-catalogue-phase2`. Its `HANDOFF-PHASE3.md` (worktree root, on the branch) is the
  authoritative module-by-module state — its "nothing committed" final section is stale (the
  branch commit happened after); everything else holds.
- **The demo is over.** Dev server DOWN. `.workflow-data` purged (twice, during live checks) —
  campaign-4's parked session is gone (orphaned by the gate round's instrumentation.ts edits,
  an accepted cost; KNOWN_ISSUES #1). Campaign-4's **5 armed subscriptions are still in Redis**
  (TSM/CVX crossings + TSM filing) with no session behind them — DELETE them before the next
  campaign boots, or their fires will 404 into `failed` rows and spam the logs.
  The Alpaca paper account still holds campaign-2's position (positions live in the account).
- **The cloud is still empty by design**: no preview deployments; only the inert pre-cron
  production shell at event-catalogue.vercel.app (open incident for Philipp below).

## Post-demo checklist — steps 1–4 DONE (2026-07-13 evening), evidence inline

1. **Demo confirmed over** (Philipp, in the resume prompt).
2. **Suites green in both trees, server down**: main 155/155 pre-fix-round (159/159 after),
   worktree 265/265 + root/connector typechecks + connector build (18 steps, 5 workflows).
3. **Codex gate on the demo-day batch (031fb2b) — DONE, three narrow passes + re-verify**
   (gpt-5.6-sol xhigh, file-append verdicts in `.codex-gate-demo-{a,b,c,rv,rv2}-findings.md`):
   - Pass A (observe page + new routes): FAIL — 3 MED (reasoning.appended read nonexistent
     fields; quadratic transcript rendering; leaked/overlapping stream readers). XSS, the
     baggage wrapper, and the conversations route were explicitly CLEARED.
   - Pass B (instrumentation): PASS — 2 LOW (empty filtered batch forwarded to the exporter —
     cross-confirmed empirically by the harness; missing "auto" drops @vercel/otel's default
     Vercel-runtime drain).
   - Pass C (WATCHER_HOST): FAIL — 1 MED fixed now (set-but-invalid value silently meant
     in-process → fail-closed `resolveWatcherHost`), 1 MED + 1 LOW deferred POST-MERGE as
     task #27 (connector-mode test-feed `get_latest_price` gap → KNOWN_ISSUES #14 extension;
     timing-based test assertion).
   - Re-verify over the fix round: caught 1 more MED (reasoning tracker cleared by mid-step
     tool calls → duplicate bubbles), fixed, focused re-check run on that delta.
   - **8 findings fixed** across `catalog/observe-page.ts`, `agent/instrumentation.ts`,
     `catalog/providers/alpaca.ts` (+ its test), `catalog/providers/clock.test.ts` (a latent
     22:00–23:59-UTC-only day-rollover bug in the +02:00 offset case), with a real red-green
     test for the exporter fix in `tests/agent-tools/instrumentation.test.ts`. Suite 159/159.
4. **LangSmith exporter incident — CLOSED (environmental, not code).** Full evidence:
   `spikes/langsmith-exporter-harness/FINDINGS.md`. The committed pipeline exports correctly
   (proven offline AND with two real turns: conversation `fixcheck-1`, runs landed with
   `thread_id`/`session_id` metadata). Failure signature reproduced: `LANGSMITH_TRACING` unset
   → exporter reports success, ships nothing (KNOWN_ISSUES #6). Leading mechanism for the
   16:17Z break: eve's env reload DELETES vars absent from a re-read (KNOWN_ISSUES #2 addendum,
   repro in the spike's step6) — unprovable for the specific incident (env file since
   overwritten), cleared by any fresh boot. Watch the Threads tab on the first campaign turns.

## Remaining checklist (in order)

5. ~~Merge~~ **DONE (bd99644, pushed): merged, one KNOWN_ISSUES conflict resolved (both
   addenda kept), merged tree 272/272 + both typechecks + connector build green, zero flakes
   under the branch's `--test-concurrency=1` (which closed the wake.test.ts cross-file class
   observed twice pre-merge).**
6. ~~Relaunch~~ **DONE (2026-07-13 ~23:05Z): campaign-5 LIVE and parked** (session
   `wrun_01KXEVN57ARCSWM6RC2KX4N8TN`), dev server up on :2000, `.workflow-data` purged
   pre-launch (a leftover fixcheck-1 session was retry-spamming). First turn: rediscovered the
   TSM position + $96k cash, researched (knows TSMC Q2 earnings land July 16), armed 4
   subscriptions (market-open clock wake 2026-07-14T13:30Z — correctly Tuesday; TSM
   crossings 412/432; TSM filing.new), placed no orders (market closed) — all verified in the
   browser on the observe page, LangSmith runs landing with `thread_id=campaign-5`.
   CAVEATS: (a) campaign-4's 5 stale armed rows are STILL in Redis — my deletion was
   permission-blocked; Philipp must delete them (or approve deletion) before any connector
   deploy, they're inert-but-visible until then; (b) the reasoning-bubble render is verified
   against eve's types but still never exercised live — the current model emits no reasoning
   events; close it out on Phase 4's model; (c) the laptop must stay awake for the campaign's
   clock wake (caffeinate or power settings — Philipp's machine, Philipp's call).
7. ~~Phase 4~~ **DONE (2026-07-14 ~00:05Z): built in worktree ../event-catalogue-phase4,
   branch phase4-mandate (23c905a), three Codex gates (p4a/p4b/p4c, all FAIL→fixed→verified),
   suite 300/300 lead-run, MERGED to main (fast-forward) and ROLLED OUT locally.** Campaign-5
   now runs DeepSeek V4-Pro (parallelSearch auto-wired by eve for Gateway models — no override
   code), has the position-bounded sell tool, per-day turn cap (MAX_TURNS_PER_DAY=200,
   fail-open), rewritten mandate instructions, and the market-open schedule (inert locally —
   eve dev never fires cron; the campaign's own clock re-subscription is the local wake).
   Live-verified post-rollout: DeepSeek turn completed and parked (session
   wrun_01KXEZ1Z3YK6BQ44W8AX1AF7RZ), re-armed 4 watches (open wake Tue 13:30Z; TSM exit-stop
   400 / partial-profit 445 — the new exit-discipline instructions visibly working; TSM
   filings with formTypes), LangSmith thread_id=campaign-5 landing, and the observe page's
   reasoning bubbles VERIFIED live on real DeepSeek reasoning (the last owed fix-round check).
   ROLLOUT LEFTOVERS: (a) schedule cron cadence + CAMPAIGN_CONVERSATION_ID env are Phase 6
   deploy items; (b) 4 dead pre-upgrade campaign-5 rows sit armed in Redis (watchers died with
   the restart; needs Philipp's deletion approval, same class as the campaign-4 cleanup);
   (c) observe page: message.appended label flood under DeepSeek (task #28, Phase 5 seed);
   (d) the agent's summary called Tue 7/14 "Monday" — label-only, armed timestamps correct.
   Then: **Phase 5** (observatory — observe page is the seed; task #28 first), **Phase 6**
   (deploy: WATCHER_HOST=connector — now fail-closed on typos — CATALOG_API_SECRET +
   CAMPAIGN_CONVERSATION_ID to prod, CATALOG_BASE_URL now auto-derives from VERCEL_URL, #7
   re-verification, task #27 BEFORE the cloud E2E if it uses the test feed, cloud E2E ×2 in
   market hours, one unattended day, THEN the link goes to Pranay).
8. Backlog: task #21 (idempotent subscribe_event), task #27 (post-merge gate-C deferrals),
   marker-aware stubs to restore test parallelism, workflow run cancellation path, Deployment
   Protection dashboard toggle (Philipp), Phase-6 note: any explicit forceFlush added for
   serverless suspend MUST catch rejections (see FINDINGS.md — provider-level forceFlush
   propagates; empty batches used to 400 pre-fix).

## Open incidents for Philipp's review

- **Accidental production deploy** (2026-07-13 ~05:00Z, KNOWN_ISSUES #13): inert 404 shell
  holds event-catalogue.vercel.app. Decide: leave until Phase 6 replaces it, or delete.

## Decisions locked (do not re-litigate; full list in plan + memory)

Three-service Vercel Services topology · durable sleep for timers · chain-claim +
supervisor-cron (KNOWN_ISSUES #15) · DeepSeek V4-Pro + gateway parallelSearch · ONE perpetual
campaign conversation · Deployment Protection OFF · LangSmith paid plan active · buy-only until
Phase 4's sell tool · WATCHER_HOST unset defaults to in-process (accepted deploy-checklist
risk; set-but-invalid now fails the boot).

## Team state

phase1-builder: STOOD DOWN permanently (do not resume — METHOD.md postmortem).
phase3-builder: holding; knows the worktree best; owes nothing. One writer per worktree, ever.
harness-builder + fix-builder (this session): both STOOD DOWN with explicit no-reactivation
protocol; reactivation requires the literal phrase "REACTIVATE <name>".
Codex runtime: healthy; gates run via the companion CLI with `--write` scoped to the findings
file (a read-only sandbox blocks the file-append protocol — learned pass A).
