// Step 5 (harness spec): realistic span shapes — an HTTP-root-like parent span (mimicking eve's
// engine-internal workflow.route POST) with a child ai.* span underneath it (mimicking an LLM
// call), and a leaf noise span (mimicking a GET /catalog/observe poll) as a sibling. Baggage
// carries conversation_id the same way agent/channels/catalog.ts's withConversationBaggage does,
// so ThreadMetadataSpanProcessor should stamp ai.telemetry.metadata.thread_id/session_id on
// every span in the tree. Confirms: (a) the parent+child both land, (b) the parent is NOT
// dropped as noise (isNoiseSpan only matches known leaf shapes), (c) LangSmith actually
// assembles thread_id metadata on the runs, (d) the noise leaf is correctly filtered and does
// NOT orphan its (non-existent, in this case) children.
//
// Run: node --env-file=/Users/philipp/code/event-catalogue/.env.local step5-realistic-turn-shape.mjs
import { registerOTel } from "@vercel/otel";
import { trace, context, propagation } from "@opentelemetry/api";
import { LangSmithOTLPTraceExporter } from "langsmith/experimental/otel/exporter";
import {
  pinHarnessProject,
  waitForRunByName,
  FilteringSpanExporter,
  ThreadMetadataSpanProcessor,
  CONVERSATION_BAGGAGE_KEY,
} from "./lib/shared.mjs";

pinHarnessProject();

const stamp = Date.now();
const conversationId = `harness-conv-${stamp}`;
const parentName = `POST /.well-known/workflow/v1/flow-${stamp}`; // mimics eve's engine-internal route (NOT filtered: not a GET, not /catalog or /eve/v1/health)
const childName = `ai.generateText.doGenerate-${stamp}`; // mimics an AI SDK llm span
const noiseChildName = `GET /catalog/observe-${stamp}`; // mimics the observatory poll, should be filtered as a leaf

registerOTel({
  serviceName: "langsmith-harness-step5",
  traceExporter: new FilteringSpanExporter(new LangSmithOTLPTraceExporter()),
  spanProcessors: [new ThreadMetadataSpanProcessor()],
});

const tracer = trace.getTracer("harness-step5");

const baggage = propagation.createBaggage({ [CONVERSATION_BAGGAGE_KEY]: { value: conversationId } });
const baggageCtx = propagation.setBaggage(context.active(), baggage);

context.with(baggageCtx, () => {
  console.log(`Parent span: "${parentName}" (conversation_id=${conversationId} via baggage)`);
  const parentSpan = tracer.startSpan(parentName);
  const parentCtx = trace.setSpan(context.active(), parentSpan);

  context.with(parentCtx, () => {
    console.log(`  Child (real work): "${childName}"`);
    const childSpan = tracer.startSpan(childName);
    childSpan.setAttribute("ai.operationId", "ai.generateText.doGenerate");
    childSpan.setAttribute("ai.response.text", "harness stub response");
    childSpan.end();

    console.log(`  Child (noise leaf): "${noiseChildName}"`);
    const noiseSpan = tracer.startSpan(noiseChildName);
    noiseSpan.end();
  });

  parentSpan.end();
});

console.log("Waiting 7s for the natural BatchSpanProcessor timer (no forceFlush, matching eve)...");
await new Promise((r) => setTimeout(r, 7000));

console.log(`Polling for parent run "${parentName}"...`);
const parentRun = await waitForRunByName(parentName, { timeoutMs: 25000 });
console.log(parentRun ? `PARENT FOUND: id=${parentRun.id}` : "PARENT NOT FOUND");
if (parentRun) {
  console.log("  parentRun.extra?.metadata:", JSON.stringify(parentRun.extra?.metadata ?? parentRun.extra, null, 2)?.slice(0, 500));
}

console.log(`Polling for child run "${childName}"...`);
const childRun = await waitForRunByName(childName, { timeoutMs: 15000 });
console.log(childRun ? `CHILD FOUND: id=${childRun.id}, parent_run_id=${childRun.parent_run_id}` : "CHILD NOT FOUND");
if (childRun) {
  console.log("  childRun.extra?.metadata:", JSON.stringify(childRun.extra?.metadata ?? childRun.extra, null, 2)?.slice(0, 500));
  const thread = childRun.extra?.metadata?.thread_id ?? childRun.extra?.metadata?.["thread_id"];
  console.log("  thread_id present on child run:", thread ?? "(not found under extra.metadata.thread_id — see raw dump above)");
}

console.log(`Confirming noise leaf "${noiseChildName}" did NOT land (10s short poll)...`);
const noiseRun = await waitForRunByName(noiseChildName, { timeoutMs: 10000, pollMs: 3000 });
console.log(noiseRun ? `UNEXPECTED: noise leaf landed anyway: id=${noiseRun.id}` : "confirmed absent (as expected, isNoiseSpan filtered it)");

const ok = Boolean(parentRun) && Boolean(childRun) && !noiseRun;
console.log(ok ? "STEP 5: OK" : "STEP 5: SOMETHING DID NOT MATCH EXPECTATIONS -- see above");
process.exit(ok ? 0 : 1);
