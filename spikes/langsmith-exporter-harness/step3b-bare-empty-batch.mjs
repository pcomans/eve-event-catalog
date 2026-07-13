// Follow-up to step3: does the BARE LangSmithOTLPTraceExporter (no FilteringSpanExporter
// wrapper at all) also crash on export([], cb)? This isolates whether the crash is inherent to
// the LangSmith/OTLP exporter itself receiving zero spans, or something FilteringSpanExporter's
// forwarding introduces. Wrapped in try/catch + a process-level unhandledRejection listener so
// THIS script can report the outcome instead of also crashing.
//
// Run: node --env-file=/Users/philipp/code/event-catalogue/.env.local step3b-bare-empty-batch.mjs
import { LangSmithOTLPTraceExporter } from "langsmith/experimental/otel/exporter";
import { pinHarnessProject } from "./lib/shared.mjs";

pinHarnessProject();

let sawUnhandledRejection = null;
process.on("unhandledRejection", (reason) => {
  sawUnhandledRejection = reason;
  console.log("CAUGHT (process-level) unhandledRejection:", reason?.message ?? reason);
});

const exporter = new LangSmithOTLPTraceExporter();

console.log("Calling bare LangSmithOTLPTraceExporter.export([], cb) directly...");
const result = await new Promise((resolve) => {
  try {
    exporter.export([], (res) => resolve({ callbackResult: res }));
  } catch (err) {
    resolve({ syncThrow: err });
  }
});
console.log("export() call returned control with:", result);

// Give any async rejection from inside export()'s fire-and-forget runExport() a chance to surface.
await new Promise((r) => setTimeout(r, 4000));

console.log("sawUnhandledRejection:", sawUnhandledRejection ? (sawUnhandledRejection.message ?? sawUnhandledRejection) : "none");
process.exit(0);
