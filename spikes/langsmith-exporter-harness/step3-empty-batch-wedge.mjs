// Step 3 (harness spec): send a batch where ALL spans match isNoiseSpan (so the filtered array
// passed to the inner exporter is EMPTY), then send a normal batch afterward IN THE SAME
// PROCESS. Question: does an empty/noise-only export wedge the pipeline so later real batches
// stop landing?
//
// To force two distinct BatchSpanProcessor export() calls (rather than one batch containing
// everything), we forceFlush() between the noise-only span and the real span.
//
// Run: node --env-file=/Users/philipp/code/event-catalogue/.env.local step3-empty-batch-wedge.mjs
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { LangSmithOTLPTraceExporter } from "langsmith/experimental/otel/exporter";
import { pinHarnessProject, waitForRunByName, FilteringSpanExporter } from "./lib/shared.mjs";

pinHarnessProject();

const stamp = Date.now();
const noiseName = `GET /catalog/noise-probe-${stamp}`; // matches isNoiseSpan's leaf-route regex
const realName = `harness-step3-after-noise-${stamp}`;

const filteringExporter = new FilteringSpanExporter(new LangSmithOTLPTraceExporter());

const provider = new BasicTracerProvider({
  spanProcessors: [
    new SimpleSpanProcessor(new ConsoleSpanExporter()),
    new BatchSpanProcessor(filteringExporter),
  ],
});
trace.setGlobalTracerProvider(provider);

const tracer = trace.getTracer("harness-step3");

console.log(`Batch 1 (noise-only, will filter to empty array): "${noiseName}"`);
const noiseSpan = tracer.startSpan(noiseName);
noiseSpan.end();
console.log("Force-flushing batch 1 (empty after filter)...");
await provider.forceFlush();
console.log("Batch 1 flush returned without throwing.");

console.log(`Batch 2 (real span): "${realName}"`);
const realSpan = tracer.startSpan(realName);
realSpan.end();
console.log("Force-flushing batch 2...");
await provider.forceFlush();
console.log("Batch 2 flush returned without throwing.");

console.log(`Polling LangSmith for run "${realName}" (proves batch 2 survived batch 1's empty export)...`);
const run = await waitForRunByName(realName, { timeoutMs: 30000 });
console.log(run ? `FOUND: id=${run.id}` : "NOT FOUND after 30s timeout");

// Also confirm the noise span correctly did NOT land (sanity check on the filter itself).
console.log(`Confirming noise span "${noiseName}" did NOT land (5s short poll)...`);
const noiseRun = await waitForRunByName(noiseName, { timeoutMs: 5000, pollMs: 2500 });
console.log(noiseRun ? `UNEXPECTED: noise span landed anyway: id=${noiseRun.id}` : "confirmed absent (as expected)");

await provider.shutdown();
process.exit(run ? 0 : 1);
