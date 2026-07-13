// Not in the original step numbering — added to directly compare the demo-day SYMPTOM ("zero
// spans reach LangSmith despite turns running, no error, no log") against what
// LANGSMITH_TRACING being unset/false actually looks like from the outside (KNOWN_ISSUES #6).
// Forces LANGSMITH_TRACING to an unset value INSIDE this process only (does not touch
// .env.local), exports a span, and shows that the SDK reports SUCCESS (code 0) to the caller
// while sending nothing over the wire — i.e. this failure mode is indistinguishable from
// "everything is fine" without checking LangSmith itself.
//
// Run: node --env-file=/Users/philipp/code/event-catalogue/.env.local step0-tracing-disabled-signature.mjs
import { LangSmithOTLPTraceExporter } from "langsmith/experimental/otel/exporter";
import { pinHarnessProject, waitForRunByName } from "./lib/shared.mjs";

pinHarnessProject();

console.log("Before override, LANGSMITH_TRACING =", JSON.stringify(process.env.LANGSMITH_TRACING));
delete process.env.LANGSMITH_TRACING;
delete process.env.LANGSMITH_TRACING_V2;
delete process.env.LANGCHAIN_TRACING;
delete process.env.LANGCHAIN_TRACING_V2;
console.log("After override (simulating the var being absent), LANGSMITH_TRACING =", JSON.stringify(process.env.LANGSMITH_TRACING));

const exporter = new LangSmithOTLPTraceExporter();
const runName = `harness-step0-tracing-disabled-${Date.now()}`;

// Build a minimal fake ReadableSpan by hand (bypassing the full SDK) since all we need is to
// call exporter.export() directly and observe the callback + whether it lands upstream.
const fakeSpan = {
  name: runName,
  attributes: {},
  resource: { attributes: {} },
  instrumentationScope: { name: "harness-step0" },
  spanContext: () => ({ traceId: "00000000000000000000000000000001", spanId: "0000000000000001", traceFlags: 1 }),
  parentSpanContext: undefined,
  kind: 0,
  startTime: [Math.floor(Date.now() / 1000), 0],
  endTime: [Math.floor(Date.now() / 1000), 0],
  duration: [0, 1],
  status: { code: 0 },
  events: [],
  links: [],
  droppedAttributesCount: 0,
  droppedEventsCount: 0,
  droppedLinksCount: 0,
  ended: true,
};

const result = await new Promise((resolve) => exporter.export([fakeSpan], resolve));
console.log("exporter.export() reported to caller:", result);
console.log(result.code === 0 ? "-> SDK-facing result: SUCCESS (indistinguishable from a real send)" : "-> SDK-facing result: FAILURE");

console.log(`Polling LangSmith (10s) for run "${runName}" — expect NOT FOUND, proving nothing was actually sent...`);
const run = await waitForRunByName(runName, { timeoutMs: 10000, pollMs: 3000 });
console.log(run ? `UNEXPECTED: found anyway (id=${run.id})` : "confirmed NOT FOUND — silent no-op reproduced");
process.exit(0);
