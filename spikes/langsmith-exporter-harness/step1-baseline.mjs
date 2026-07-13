// Step 1 (harness spec, step 1): bare tracer provider + LangSmithOTLPTraceExporter ALONE
// (no FilteringSpanExporter, no ThreadMetadataSpanProcessor), one simple span. Does it land in
// LangSmith? A ConsoleSpanExporter runs side-by-side via SimpleSpanProcessor so we see locally
// what was attempted regardless of whether the network export succeeds.
//
// Run: node --env-file=/Users/philipp/code/event-catalogue/.env.local step1-baseline.mjs
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { LangSmithOTLPTraceExporter } from "langsmith/experimental/otel/exporter";
import { pinHarnessProject, waitForRunByName } from "./lib/shared.mjs";

pinHarnessProject();

console.log("LANGSMITH_TRACING raw env value:", JSON.stringify(process.env.LANGSMITH_TRACING));
console.log("LANGSMITH_PROJECT (pinned):", process.env.LANGSMITH_PROJECT);
console.log("LANGSMITH_API_KEY present:", Boolean(process.env.LANGSMITH_API_KEY));

const runName = `harness-step1-baseline-${Date.now()}`;

const langsmithExporter = new LangSmithOTLPTraceExporter();

const provider = new BasicTracerProvider({
  spanProcessors: [
    new SimpleSpanProcessor(new ConsoleSpanExporter()),
    new BatchSpanProcessor(langsmithExporter),
  ],
});
trace.setGlobalTracerProvider(provider);

const tracer = trace.getTracer("harness-step1");
console.log(`Starting span "${runName}"...`);
const span = tracer.startSpan(runName);
span.end();

console.log("Force-flushing provider...");
await provider.forceFlush();

console.log(`Polling LangSmith for run "${runName}" (project ${process.env.LANGSMITH_PROJECT})...`);
const run = await waitForRunByName(runName, { timeoutMs: 30000 });
console.log(run ? `FOUND: id=${run.id}` : "NOT FOUND after 30s timeout");

await provider.shutdown();
process.exit(run ? 0 : 1);
