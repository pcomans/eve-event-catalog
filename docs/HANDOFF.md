# HANDOFF — read this first (rewritten 2026-07-14 ~03:10Z, Phases 1–5 complete)

Entry point for the next session. Read `AGENTS.md` (hard rules incl. rule 9 heartbeat
discipline), `METHOD.md` (how the lead/builder/Codex team operates, two postmortems),
`KNOWN_ISSUES.md` (#16–#18 are new: nested-workspace lockfile landmine, eve reducer
whitespace gap, ai-elements lint) before touching anything. Plan:
`docs/plan-vercel-production.md`. Project memory:
`~/.claude/projects/-Users-philipp-code-event-catalogue/memory/`.

## Where we are (big picture)

**Phases 1–5 of the production plan are BUILT, Codex-gated, MERGED on `main` (3aa43fd), and
pushed.** Phase 5 added: the `catalog/observe-page.ts` message.appended coalescing fix
(task #28 — DeepSeek's delta flood + phantom-empty-bubble class, gates p5a→p5c), and the
**public observatory** — a read-only Next.js workspace service in `observatory/` with four
pages: `/subscriptions` (live lifecycle table), `/events` (feed with elapsed times),
`/decisions` (session transcript replayed through eve's `defaultMessageReducer` over an
NDJSON stream proxy — replay + live tail in one path — with catalog events interleaved
chronologically into the timeline), `/campaign` (equity curve per the dataviz method,
positions, realized P&L baselined on `CAMPAIGN_INITIAL_EQUITY`, default 100k). Suite on
main: **334/334** (300 pre-existing + 34 observatory pure tests; serialized,
`--test-concurrency=1`).

Phase 5 went through ELEVEN gate passes (p5a–p5k, gpt-5.6-sol xhigh, narrow, file-append
verdicts): every FAIL triaged by the lead, fixed by phase5-builder, re-gated. Load-bearing
outcomes: the public API surface is field-whitelisted DTOs (Alpaca's raw account object —
id/account_number/margin fields — never reaches the wire); Alpaca keys are `server-only`,
paper host hardcoded, GETs only; every wire number passes `parseWireNumber` once at the
boundary (malformed data renders an em dash, never `$NaN`); client abort propagates
browser→proxy→eve (verified against Next 16.2.10 internals + fetch/streams specs).

**The standing campaign (campaign-5) is LIVE on Philipp's machine, running Phase 5 code**
after this session's rollout window (~03:00–03:20Z): server restarted on main@3aa43fd, ONE
re-arm turn sent (the perpetual-conversation procedure), campaign re-subscribed itself.
`GET /catalog/subscriptions` is the authoritative live view of the armed set — expect a
clock wake for **2026-07-14T13:30Z** plus whatever price/filing watches the agent chose to
re-arm. The pre-rollout armed batch became corpse rows (no unsubscribe tool — backlog);
ALL dead rows (two generations now) await Philipp's deletion approval — the auto-classifier
blocks registry-delete scripts; ask, don't assume.

**The cloud is still empty by design**: no preview deployments; only the inert accidental
pre-cron production shell at event-catalogue.vercel.app (Philipp 2026-07-13: leave it until
Phase 6 replaces it).

## Operational invariants while the campaign runs locally (the expensive lessons)

1. **Any file edit in this worktree hot-reloads the dev server** (KNOWN_ISSUES #2) and can
   orphan the parked campaign session (#1). Build ANYTHING nontrivial in a separate git
   worktree on a branch; merge + controlled rollout after gates. Corollary learned this
   session: docs edits count too — during a rollout window, write ALL docs while the server
   is down, BEFORE the restart + re-arm turn; after the re-arm turn, no main-tree edits at
   all until the next brokered window.
2. **`pnpm test` requires the dev server DOWN** (#11) — and stopping/restarting the server
   kills the campaign's in-process timers and stream watchers. After any restart: send
   campaign-5 ONE re-arm turn via POST /catalog/chat. Its old armed rows become permanent
   corpses; deletion is Philipp-approval-gated.
3. **Purge `.workflow-data` only when channel/instrumentation/agent files changed** since
   the parked session was created — purging costs the conversation its MEMORY, so don't
   purge on a plain restart. (This rollout did NOT purge; the re-arm turn behaved normally.)
4. **Codex gates need `--write`** on the companion CLI, scoped in the prompt to the findings
   file. Run worktree gates from that worktree's cwd. Watch the FINDINGS FILE for the
   VERDICT line, not the process — local wrappers/watchers can be reaped while the broker
   survives (happened this session; the file-append protocol saved the run).
5. **`vercel env pull` refreshes OIDC (~12h)** — server down first, always. AI Gateway auth
   locally rides VERCEL_OIDC_TOKEN. Pulled this session at ~03:05Z.

## First thing on resume: check the campaign is alive

If resuming after 2026-07-14 13:30Z: verify the market-open wake actually fired (observe
page event feed, `GET /catalog/subscriptions` — the clock row should be `fired`; LangSmith
Threads `thread_id=campaign-5` shows the turn; the observatory `/decisions` page should
show the fired wake marker immediately preceding the woken turn — that adjacency is the
one M2 display property not yet live-verified). If the laptop slept or the server died, the
campaign dead-ended SILENTLY — restart, purge nothing, send the one re-arm turn (invariant
2), note the gap honestly. Silence is a failure signal (AGENTS.md rule 9).

## Next work, in order

1. **Phase 6 — deploy + cloud E2E + campaign launch** (plan lines ~277+). Mandatory env on
   the deployed eve app: `WATCHER_HOST=connector` (fail-closed on typos),
   `CATALOG_API_SECRET`, `CAMPAIGN_CONVERSATION_ID` (market-open schedule reads it).
   `CATALOG_BASE_URL` auto-derives from VERCEL_URL. NEW since Phase 5 — the observatory
   deploys as its own service and needs: `CATALOG_API_BASE_URL` (the deployed eve app's
   URL), `ALPACA_API_KEY_ID`/`ALPACA_API_SECRET_KEY` (paper), optionally
   `CAMPAIGN_CONVERSATION_ID` + `CAMPAIGN_INITIAL_EQUITY` (defaults: campaign-5 / 100000).
   All var names in `.env.example`. Task #27 BEFORE the cloud E2E if it uses the test feed.
   KNOWN_ISSUES #7 re-verification on world-vercel. Preview deploys: verify target via
   `vercel inspect`, ALWAYS (#13). Cloud E2E ×2 in market hours, one unattended market day,
   THEN the link goes to Pranay.
2. Backlog: #21 (idempotent subscribe_event), #27 (gate-C deferrals — due before Phase 6
   cloud E2E), marker-aware stubs to restore test parallelism, workflow run-cancellation
   path, an unsubscribe tool (the corpse-row problem keeps growing — two generations now),
   Deployment Protection toggle (Philipp), winter-DST schedule gap (agent/schedules/
   market-open.ts).

## Decisions locked (do not re-litigate; full list in plan + memory)

Three-service topology · durable sleep for timers · chain-claim + supervisor-cron (#15) ·
DeepSeek V4-Pro + Gateway parallelSearch · ONE perpetual campaign conversation · Deployment
Protection OFF · buy + position-bounded sell, paper only · turn cap only (fail-OPEN) ·
oversell REJECTED · production shell stays until Phase 6 · **UI base: fresh Next.js +
ai-elements CLI components — NO vercel/chatbot fork (repo license is non-MIT NOASSERTION;
the published package is Apache-2.0)** · **eve pinned exactly everywhere; the observatory's
eve dependency matches the root pin — never bump one without the other** · **realized P&L
baselined on inception equity (CAMPAIGN_INITIAL_EQUITY), never portfolio-history's
window-relative base_value** · **eve 0.22.5 reducer whitespace gap accepted ship-as-is
(KNOWN_ISSUES #17), not patched around**.

## Team state

ALL builders are STOOD DOWN permanently with the explicit no-reactivation protocol:
phase1-builder, phase3-builder, harness-builder, fix-builder, phase4-builder, and now
**phase5-builder** (stood down at Phase 5 close, this session). A message to any of them
RESUMES it — never message them; reactivation requires the literal phrase
"REACTIVATE <name>", which only Philipp or the lead should ever decide to use. One writer
per worktree, ever. The `../event-catalogue-phase5` worktree is merged and redundant — safe
to `git worktree remove` (it carries untracked .codex-gate-p5* scratch findings files and a
test-run .env.local copy; both intentionally uncommitted). Codex runtime: healthy; narrow
passes; file-append verdicts; `--write` required (invariant 4).
