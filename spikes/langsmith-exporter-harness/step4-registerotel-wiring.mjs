// Step 4 (harness spec): does @vercel/otel's registerOTel({ traceExporter, spanProcessors })
// silently DROP the traceExporter's export wiring when spanProcessors is given WITHOUT "auto"
// in the array? instrumentation.ts's comment claims traceExporter is ALWAYS appended regardless.
//
// Static analysis of the installed @vercel/otel 2.1.3 (dist/node/index.js, function o2, the
// spanProcessors-resolution function) says: yes, traceExporter is unconditionally appended via
// `...(e.traceExporter && e.traceExporter!=="auto" ? [new BatchSpanProcessor(e.traceExporter)] : [])`
// regardless of what's in the spanProcessors array. This script proves it empirically by
// running registerOTel with EXACTLY the shape agent/instrumentation.ts uses (traceExporter +
// spanProcessors:[ThreadMetadataSpanProcessor], no "auto"), then confirming a span STILL lands
// in LangSmith through the traceExporter — since @vercel/otel's own MultiSpanProcessor.forceFlush
// swallows errors via globalErrorHandler (verified separately), we don't forceFlush here at all;
// we let the natural 5s BatchSpanProcessor timer fire, matching how eve itself actually runs
// (eve never calls forceFlush anywhere in its installed source — grepped, zero hits).
//
// Run: node --env-file=/Users/philipp/code/event-catalogue/.env.local step4-registerotel-wiring.mjs
import { registerOTel } from "@vercel/otel";
import { trace } from "@opentelemetry/api";
import { LangSmithOTLPTraceExporter } from "langsmith/experimental/otel/exporter";
import { pinHarnessProject, waitForRunByName, FilteringSpanExporter, ThreadMetadataSpanProcessor } from "./lib/shared.mjs";

pinHarnessProject();

const runName = `harness-step4-registerotel-${Date.now()}`;

console.log("Calling registerOTel with the EXACT shape agent/instrumentation.ts uses:");
console.log('  traceExporter: new FilteringSpanExporter(new LangSmithOTLPTraceExporter())');
console.log('  spanProcessors: [new ThreadMetadataSpanProcessor()]   <-- NOTE: no "auto" in this array');

registerOTel({
  serviceName: "langsmith-harness-step4",
  traceExporter: new FilteringSpanExporter(new LangSmithOTLPTraceExporter()),
  spanProcessors: [new ThreadMetadataSpanProcessor()],
});

const tracer = trace.getTracer("harness-step4");
console.log(`Starting span "${runName}"...`);
const span = tracer.startSpan(runName);
span.end();

console.log("NOT calling forceFlush (eve never does) — waiting 7s for the default 5s BatchSpanProcessor timer to fire on its own...");
await new Promise((r) => setTimeout(r, 7000));

console.log(`Polling LangSmith for run "${runName}"...`);
const run = await waitForRunByName(runName, { timeoutMs: 25000 });
console.log(run ? `FOUND: id=${run.id} -- traceExporter WAS appended despite spanProcessors lacking "auto"` : "NOT FOUND -- traceExporter wiring WAS dropped (root cause confirmed if so)");

process.exit(run ? 0 : 1);
