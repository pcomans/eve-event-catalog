# METHOD — how this project is built

How the AI team working on this repo organizes itself: who does what, how work flows, how it
gets reviewed, and where the human decides. Written from practice (Phase 1 + the clock
provider went through every part of this, including the failure modes), not aspiration.
Companion to `AGENTS.md` (the hard rules) — this describes the *process* those rules produce.

## Roles

- **The lead** (one Claude session) orchestrates: decomposes work into tasks, briefs builders,
  reviews every diff, runs the Codex gates, triages findings into fix rounds, writes ALL
  documentation and commits. The lead writes no product code. One brain owns the merge.
- **Builders** (Sonnet subagents, usually one at a time) implement: TDD red-green with
  node:test, run the suites and manual regressions, and report. Builders never commit — they
  leave the working tree for review. A builder's report is a claim, not a fact.
- **Codex** (gpt-5.6-sol, xhigh reasoning) is the independent reviewer. Every coding step gets
  a Codex gate before anything depends on it. Codex has no memory of the builder's intentions —
  that independence is the value.
- **Philipp** decides: architecture forks, external services, secret-store writes, scope.
  Everything else proceeds autonomously within the plan he approved.

## The loop

Every unit of work runs the same cycle:

```
plan task → brief builder → builder implements (red-green) → builder reports
   → lead reads the actual diff → Codex gate (narrow pass) → triage findings
   → fix round(s) back to the builder → re-gate → lead runs the suite ITSELF
   → commit + push → next task
```

Two properties matter more than the sequence:

1. **Acceptance criteria are authored before the build** (tests-before-build applies to
   checklists too — see AT-10…AT-14, written before Phase 1 started).
2. **Nothing is believed twice.** The builder says the tests pass → the lead runs `pnpm test`
   itself before committing. The builder says it's done → the lead reads the diff. Codex says
   FAIL → the lead re-derives each finding against the code before dispatching fixes, because
   review findings can be wrong, over-scoped, or already handled.

## Working with builders

- **Briefs are contracts.** A builder brief names the scope (files in/out of bounds), the
  binding criteria (which AT items), the process rules that apply (server down for tests, no
  commits, no doc edits), and what the report must contain (test counts, regression outcomes,
  design decisions the lead should scrutinize, what was NOT done).
- **Builders are told to report honestly, and honest reporting is rewarded with trust, not
  punished with rework.** The best moments in this project were builder-caught problems: the
  wake route that would have 401'd itself, the module-multi-instance bug that only a live check
  could reveal, the test flakiness reported as "needs your eyes, I could not fully resolve it"
  instead of being papered over.
- **Live checks are mandatory, not optional.** Unit tests all passed while a real agent
  subscription accepted a date 12 days in the past. The rule: after the suite is green, drive
  the actual feature through the running system once.
- **Messages cross constantly.** Agent-to-agent messaging is not ordered chat; every
  significant exchange in this project arrived at least once out of order or duplicated. The
  protocol that works: every directive is self-contained (restates what it supersedes), the
  lead explicitly labels which message is operative when confusion is possible, and both sides
  confirm receipt of *content*, not just "got it".
- **Permission boundaries are hard.** When a builder is denied a permission (e.g. writing to
  the Vercel secret store), the lead does not run the denied command on its behalf — that's
  permission laundering. The lead surfaces the decision to Philipp and acts only on his
  explicit answer. A builder flagging the denial (rather than routing around it) is doing it
  right.
- **One writer per worktree, and retirement is permanent.** Sending any message to an idle
  agent RESUMES it — so a directive that crosses with an agent's wind-down report can
  reactivate an agent the lead believes retired. Learned the hard way (2026-07-13): a resumed
  "retired" builder and its freshly-spawned successor built the same feature concurrently in
  one worktree. Rules since: exactly one agent may write to a worktree at any time; a
  stood-down agent is told explicitly that future messages do NOT reactivate it without an
  explicit reactivation phrase; when handing off, the lead confirms the predecessor is inert
  BEFORE the successor starts. Both agents behaved correctly in the collision — stop-and-report
  on discovering foreign files is the right move, and adjudication is the lead's job.

## Working with Codex

- **Narrow passes, always.** One concern per review (delivery semantics; auth surface; one new
  provider). Broad multi-part reviews at xhigh hang while composing long verdicts — two runs
  died exactly there.
- **The file-append protocol (load-bearing).** Codex is instructed to append each finding to a
  scratch file via `echo >>` AS IT FINDS IT, ending with a `VERDICT: PASS|FAIL` line, and to
  keep its final chat message to one line. When the process crashes mid-verdict (it does), the
  findings survive on disk. The lead watches the file for the VERDICT line, not the process.
- **Broker hygiene.** ≥3 minutes of output silence → kill the repo's broker tree (only ours —
  check cwd; other projects and the IDE extension run their own) and retry narrower. Stale
  jobs that block new ones are cleared with `codex-companion.mjs cancel <job-id>`.
- **Triage is the lead's job, not Codex's.** Every finding gets sorted: fix now (correctness in
  scope), fix structurally (when two findings share a root cause, kill the class — the CAS
  rewrite replaced a workaround instead of patching it twice), defer with documentation (real
  but out of phase — the sweep's setInterval durability), or accept explicitly (see below).
- **Declare the stop.** Distributed-systems review can produce asymptotically smaller windows
  forever. The lead bounds the loop by declaring accepted limits in writing ("send() > 300s
  can duplicate, logged; receiver-side idempotency is out of scope") and instructing the next
  gate pass that those are not findings. Exactly-once across a send boundary is a theorem, not
  a code-review finding.
- **Feed Codex the pointed questions.** The best verdicts came from passes primed with
  specific suspicions (setTimeout's 2^31-1 cap, timezone semantics of offset-less ISO strings,
  "audit the blast radius of the multi-instance discovery"). Codex confirmed all three and
  found more. A gate is a dialogue, not a lottery.

## Verification discipline

- `git log` before believing any "done"; the diff before believing any description of it.
- The lead re-runs `pnpm test` + `pnpm typecheck` itself immediately before every commit.
- Tests run with the dev server DOWN (KNOWN_ISSUES #11 — a running server's recovery sweep
  corrupts test state from outside the test process; this masqueraded as Redis flakiness for
  hours and was found by Codex, not by retrying harder).
- Dry-run `git add` on new directories before committing them (the Queues spike carries a
  gitignored `.env` with a real token — verify the ignore actually holds).
- Red tests are proven red: for structural fixes, the builder reverts the fix and re-runs to
  show the new tests genuinely fail against the old code.

## Documentation ownership

- The lead writes and commits all docs: plan, HANDOFF, acceptance tests, architecture,
  KNOWN_ISSUES, README, this file. Builders report findings in messages; the lead folds them
  in. (Exception by explicit grant only — e.g. "add this one KNOWN_ISSUES entry".)
- Decisions get recorded where the next session will look, at the moment they're made, with
  who/when ("Philipp, 2026-07-12") — the plan and HANDOFF are the durable memory between
  sessions; chat is not.
- Sharp edges go to KNOWN_ISSUES the day they're found, phrased so the next person recognizes
  the symptom before rediscovering the cause.

## Escalation to Philipp — always, and only, for:

- Architecture forks (new ones; decided forks are recorded and not re-litigated)
- Non-Vercel components (AGENTS.md rule 2)
- Secret-store and other externally-visible writes a permission gate flags
- Scope changes and anything that changes what the demo *is*

Everything else: proceed, record the decision, and make it easy to reverse.
