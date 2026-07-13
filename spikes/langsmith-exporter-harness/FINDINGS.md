# LangSmith exporter offline harness — findings

Incident: zero spans reached LangSmith from ~2026-07-13T16:17Z despite agent turns running
(docs/HANDOFF.md, demo-day item 2). LangSmith's side ruled out beforehand (paid plan active,
direct ingest probe 202). Harness built 2026-07-13 post-demo by a builder subagent, server
never started, agent/instrumentation.ts never touched; this summary authored by the lead from
the builder's report (docs are lead-owned, METHOD.md).

Scripts: `lib/shared.mjs` (incl. `waitForRunByName()` — LangSmith-side arrival verified via the
langsmith SDK's `Client.listRuns({projectName})`, polled by exact run name) and `step0`–`step6`.
All runs used an in-process `LANGSMITH_PROJECT=eve-events-harness` override so nothing polluted
the real project. Run any step with
`node --env-file=.env.local spikes/langsmith-exporter-harness/<script>` from the repo root.

## Bottom line

**The committed pipeline works.** The exact demo-day code (FilteringSpanExporter +
ThreadMetadataSpanProcessor + registerOTel, wired as agent/instrumentation.ts does) exports
correctly against the current .env.local: steps 1, 2, 4, 5 all landed in LangSmith with correct
parent/child relationships and thread_id/session_id metadata. The production incident was
environmental, not a code defect. Definitive closure requires one real turn against a booted
server (post-demo checklist step 4's final clause) — scheduled into the fix round's live check.

## The failure signature, reproduced (step 0)

With `LANGSMITH_TRACING` unset/falsy, `LangSmithOTLPTraceExporter.export()` reports
`{code: 0}` (SUCCESS) to the OTel pipeline while sending **nothing** over the wire — verified by
LangSmith poll (run not found). Indistinguishable from "working" unless you independently check
LangSmith. Exact match for the demo symptom; KNOWN_ISSUES #6's mechanism, empirically confirmed.

## Leading incident explanation (step 6) — verified mechanism, not proven-for-16:17Z

eve's dev env loader (`node_modules/eve/dist/src/cli/dev/environment.js`) doesn't just add
values on reload: `reload()` **actively deletes from process.env** any key it set on a previous
reload that is absent from the new file read — and it stays deleted until a later reload sees a
complete file, or the process restarts. Logic copied verbatim into
`step6-env-reload-deletion.mjs` and reproduced: one reload against a version of .env.local
missing `LANGSMITH_TRACING` kills tracing silently and permanently (per step 0), from one point
in time onward. That is exactly the observed shape.

Caveat (weakens, doesn't kill): the watcher (`dev-authored-source-watcher.js`) uses chokidar
`awaitWriteFinish {pollInterval: 50, stabilityThreshold: 160}`, which defends against reading a
torn single-writer write. The plausible trigger is two writers overlapping on .env.local (e.g.
`vercel env pull` racing a manual edit — already forbidden by KNOWN_ISSUES #2) or a
truncate-then-refill writer. No server logs from 16:17Z survive (and the demo-era .env.local was
overwritten by the post-demo `vercel env pull`), so this is recorded as "a real, verified,
load-bearing mechanism that would produce exactly this symptom," not the proven cause.

## Hypotheses ruled out

- **Code fundamentally can't export** — ruled out (steps 1, 2, 4, 5 all land).
- **`spanProcessors` without "auto" drops the traceExporter wiring** — ruled out both statically
  (installed @vercel/otel 2.1.3: traceExporter is unconditionally appended as its own
  BatchSpanProcessor regardless of "auto") and empirically (step 4 landed). The instrumentation.ts
  comment is correct for the traceExporter path. NOTE the related-but-different real finding from
  Codex gate pass B: omitting "auto" DOES drop the default BatchSpanProcessor(
  VercelRuntimeSpanExporter) — the Vercel platform drain, not the LangSmith path. Fixed in the
  post-demo fix round.
- **Quoted `LANGSMITH_TRACING="true"` read as literal quotes** — ruled out end-to-end: node's
  --env-file loader resolves it to the bare 4-char string `true` (byte-for-byte check), and eve's
  own loader parses with node:util's `parseEnv()` — the same parser — confirmed independently by
  both the builder and the lead reading environment.js.
- **LangSmith quota** — ruled out pre-harness (paid plan, 202 probe).

## New bug found (real; NOT the incident cause) — fixed in the post-demo fix round

`FilteringSpanExporter` forwards an EMPTY array to the inner exporter when a whole batch is
noise (routine: the observatory polls GET /catalog/observe every 2s). LangSmith's OTLP ingest
rejects it with HTTP 400 ("trace_ids must be specified for batch requests"). On eve's real
periodic-timer export path this is caught by OTel's default globalErrorHandler (diag log only;
BatchSpanProcessor's _isExporting resets in a .finally(); eve@0.22.5 calls forceFlush() zero
times — grepped) — so it wastes requests but does NOT wedge the pipeline.

**Phase 6 landmine**: provider-level `TracerProvider.forceFlush()` (unlike the SpanProcessor
path) DOES propagate the rejection — it crashed the harness process when awaited without a
catch. Serverless deploys typically add an explicit flush-before-suspend; if that lands later
without a catch, an empty batch WILL crash that invocation. The fix-round change (short-circuit
`resultCallback({code: 0})` on an empty filtered array) removes the whole class.

## Explicitly NOT verified

- The live eve process's actual process.env at 16:17Z (unknowable; file since overwritten).
- LangSmith-side health immediately after a forceFlush-triggered crash in the same process.
- A real turn through a booted server (deferred to the fix round's live check, by design).
