// Step 2 (harness spec): add FilteringSpanExporter wrapper around LangSmithOTLPTraceExporter.
// Single span with a name that does NOT match isNoiseSpan (no leading "GET /catalog" etc, no
// upstash.io url attribute). Does it still land?
//
// Run: node --env-file=/Users/philipp/code/event-catalogue/.env.local step2-filtering-exporter.mjs
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { LangSmithOTLPTraceExporter } from "langsmith/experimental/otel/exporter";
import { pinHarnessProject, waitForRunByName, FilteringSpanExporter } from "./lib/shared.mjs";

pinHarnessProject();

const runName = `harness-step2-filtering-${Date.now()}`;

const filteringExporter = new FilteringSpanExporter(new LangSmithOTLPTraceExporter());

const provider = new BasicTracerProvider({
  spanProcessors: [
    new SimpleSpanProcessor(new ConsoleSpanExporter()),
    new BatchSpanProcessor(filteringExporter),
  ],
});
trace.setGlobalTracerProvider(provider);

const tracer = trace.getTracer("harness-step2");
console.log(`Starting non-noise span "${runName}"...`);
const span = tracer.startSpan(runName);
span.end();

await provider.forceFlush();

console.log(`Polling LangSmith for run "${runName}"...`);
const run = await waitForRunByName(runName, { timeoutMs: 30000 });
console.log(run ? `FOUND: id=${run.id}` : "NOT FOUND after 30s timeout");

await provider.shutdown();
process.exit(run ? 0 : 1);
