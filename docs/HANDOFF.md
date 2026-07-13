# HANDOFF — read this first (rewritten 2026-07-13, mid-demo-day)

Entry point for the next session. Read `AGENTS.md` (hard rules incl. NEW rule 9), `METHOD.md`
(how the team works — updated with two postmortems), `KNOWN_ISSUES.md` (#11–#15 are recent and
load-bearing) before touching anything. Plan: `docs/plan-vercel-production.md`. Project memory:
`~/.claude/projects/-Users-philipp-code-event-catalogue/memory/`.

## Where we are (big picture)

- **Phases 1–3 of the production plan are BUILT and Codex-gated.** Phase 1 + clock provider are
  merged on `main`. Phases 2–3 (connector service, gap replay, fencing, chain-guard +
  supervisor, EDGAR/expiry/recovery sweep workflows, pnpm workspace) live on branch
  **`phase2-connector`** (pushed), built in the worktree `../event-catalogue-phase2`. Its own
  handoff — `HANDOFF-PHASE3.md` at that worktree's root, on the branch — is the authoritative
  module-by-module state; read it before touching that code.
- **A live demo is (or was) running on Philipp's machine**: dev server on :2000, conversation
  **campaign-4** (the standing-mandate trading agent, buy-only), 5 armed subscriptions
  (TSM crossings + filing, CVX crossings), live view at `localhost:2000/catalog/observe`.
  The Alpaca paper account holds at least one position bought by campaign-2 (position
  survives conversation resets — it lives in the account).
- **The cloud is empty by design right now**: all preview deployments were deleted (with
  Philipp's approval) to stop their sweep chains from touching the shared Redis during the
  demo. Only an inert, pre-cron production shell serves event-catalogue.vercel.app (frozen for
  incident review — see below). Redeploying the connector is one `vercel deploy
  --target=preview` from the worktree (verify target via `vercel inspect`, ALWAYS).

## Demo-day emergency work (on main, typechecked + live-verified, SUITE RUN + CODEX GATE OWED)

Committed under demo pressure with explicit process exceptions; the post-demo gate MUST review:
1. **`/catalog/observe`** — live observatory page (subscriptions/event feed/streaming
   transcript), `catalog/observe-page.ts` + routes in `agent/channels/catalog.ts` (incl. new
   public `GET /catalog/conversations/:id`). Lead-authored fixes inside it: incremental stream
   reader (a `.text()` on the never-closing stream hung forever), `reasoning.appended`
   rendering, stable sort by createdAt.
2. **LangSmith trace filter + Threads metadata** (`agent/instrumentation.ts` + baggage wrapper
   in the channel): ThreadMetadataSpanProcessor (OTEL baggage → `ai.telemetry.metadata.
   session_id/thread_id`, PROVEN working — runs landed with `thread_id: campaign-2`) and a
   noise filter. **THE EXPORTER IS CURRENTLY BROKEN — zero spans reach LangSmith since ~16:17Z
   despite turns running.** Root-cause OFFLINE in a harness (console exporter side-by-side),
   NOT by live iteration: each agent/instrumentation edit + restart orphans parked sessions.
   Known findings so far: dropping parent spans (HTTP roots, engine flow-POSTs) makes LangSmith
   discard the orphaned children — eve's model/tool spans live UNDER engine-internal spans;
   only true leaves (GET-route server spans, upstash client fetches) are safely filterable.
3. **WATCHER_HOST switch** in `catalog/providers/alpaca.ts` (+ test) — from the p2v round;
   `connector` value is MANDATORY on any deployed eve app (plan Phase 6 checklist).

## Sharp edges learned today (beyond KNOWN_ISSUES — fold in during the gate)

- **Editing channel or instrumentation files orphans ALL parked sessions** (unhandled-queue
  spam, unwakeable). Editing leaf files (e.g. `catalog/observe-page.ts`) is safe — proven both
  ways, twice each. Restart alone (no edit) is survivable; the conversation re-arms its
  watchers with one message ("restart = re-subscribe", one turn).
- **Purge `.workflow-data` after any session-orphaning event** — orphaned runs retry-loop
  forever, spamming logs and (when tracing works) LangSmith.
- **LangSmith monthly quota exhausted = silent trace loss** (KNOWN_ISSUES #6 addendum);
  Philipp upgraded the plan 2026-07-13, ingest verified 202.
- **The subscriptions registry returns Redis-set order** — anything rendering it must sort.

## Post-demo checklist (in order)

1. **Confirm with Philipp the demo is over** before touching the server or the tree.
2. Stop the dev server → run the FULL suite in BOTH trees (main expects 155+; worktree 265+ as
   of HANDOFF-PHASE3.md; server must be DOWN — KNOWN_ISSUES #11).
3. **Codex gate on the demo-day batch** (observe page + instrumentation + the lead's direct
   edits — narrow passes, file-append verdict protocol per METHOD.md).
4. **LangSmith exporter root-cause** in an offline harness; fix; verify with one real turn
   (expect: llm/tool runs landing, junk filtered, Threads grouping by conversationId).
5. **Merge `phase2-connector` into main** after its final suite run on the merged tree.
6. Relaunch the campaign (campaign-5 or reuse campaign-4 if still alive) — it should rediscover
   its position via get_account/positions.
7. Then the remaining plan: **Phase 4** (mandate agent: DeepSeek V4-Pro + gateway
   parallelSearch — DECIDED, probe-verified; sell tool; turn cap; instructions rewrite from the
   seed in the plan; market-open schedule), **Phase 5** (observatory — the observe page is the
   seed; vercel/chatbot only if it reduces work, time-boxed spike), **Phase 6** (deploy:
   WATCHER_HOST=connector, CATALOG_API_SECRET to prod, #7 re-verification hard gate, cloud E2E
   ×2 in market hours, one unattended day, THEN the link goes out).
8. Backlog (task list): idempotent subscribe_event (task #21, post-demo by Philipp's explicit
   call), restore test parallelism via marker-aware stubs, workflow run cancellation path
   (ops), Deployment Protection dashboard toggle (Philipp action, "open from day one").

## Open incidents for Philipp's review

- **Accidental production deploy** (2026-07-13 ~05:00Z): first-ever `vercel` deploy defaulted
  to production (KNOWN_ISSUES #13); an inert 404 connector shell holds event-catalogue.
  vercel.app. Decide: leave until Phase 6 replaces it, or delete.
- **LangSmith traces**: paid plan now active; the local exporter break (above) is ours, not
  LangSmith's.

## Decisions locked (do not re-litigate; full list in plan + memory)

Three-service Vercel Services topology · durable sleep for timers (smoke-verified; #634 did not
reproduce) · chain-claim + supervisor-cron for run-forever (retry-fork SDK bug is real,
KNOWN_ISSUES #15) · DeepSeek V4-Pro + gateway parallelSearch (terra+native = escalation) · ONE
perpetual campaign conversation · Deployment Protection OFF · LangSmith upgrade done · buy-only
until Phase 4's sell tool · demo-first prioritization (hardening queued behind the working demo).

## Team state

phase1-builder: STOOD DOWN permanently (do not resume — see METHOD.md postmortem).
phase3-builder: holding; knows the worktree best; owes nothing. One writer per worktree, ever.
Codex runtime: healthy; use file-append verdicts; cancel stale jobs via
`codex-companion.mjs cancel <job-id>`.
