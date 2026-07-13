import { defineInstrumentation } from "eve/instrumentation";
import { registerOTel } from "@vercel/otel";
import { LangSmithOTLPTraceExporter } from "langsmith/experimental/otel/exporter";
import { propagation } from "@opentelemetry/api";
import type { Context, Span } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";

// --- Demo observatory fix, part 2: exporter filter (2026-07-13, timeboxed) ---
// LangSmith was drowning in non-agent noise: eve/workflow engine-internal
// spans (workflow.route.* + the HTTP POSTs that trigger them), plain HTTP
// server spans for this channel's own read-only GETs (including the new
// /catalog/observe page, which polls every 2s — pure demo plumbing, never
// agent reasoning), and raw client fetch spans to Upstash Redis. None of
// these are agent runs — dropping them is what makes the LangSmith project
// usable during the demo. Errs toward KEEPING anything that might be part
// of a real model/tool trace (ai.* spans, tool spans, agent/session
// spans) — a kept junk span is much cheaper than a dropped real one.
function isNoiseSpan(span: ReadableSpan): boolean {
  const name = span.name;
  // LESSON (verified live, twice, 2026-07-13): NEVER drop a span that can be
  // a PARENT of real work. eve executes steps via internal HTTP
  // (POST /.well-known/workflow/v1/flow) — the model/tool spans live UNDER
  // those "engine noise" spans, and LangSmith discards children whose
  // parents are missing. So only true LEAVES may be filtered; the clean
  // demo view comes from the Threads tab (thread_id metadata), not from
  // pruning the trace forest.
  // (a) leaf HTTP server spans for read-only polling routes + health.
  if (/^GET \/(catalog\/|eve\/v1\/health)/.test(name)) return true;
  // (b) leaf CLIENT fetch spans to Upstash Redis (registry chatter).
  const url = span.attributes["http.url"] ?? span.attributes["url.full"];
  if (typeof url === "string" && url.includes("upstash.io")) return true;
  return false;
}

class FilteringSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}
  export(spans: ReadableSpan[], resultCallback: (result: { code: number; error?: Error }) => void): void {
    this.inner.export(
      spans.filter((span) => !isNoiseSpan(span)),
      resultCallback,
    );
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush ? this.inner.forceFlush() : Promise.resolve();
  }
}

// --- Demo observatory fix, part 3: LangSmith Threads metadata ---
// LangSmith's Threads view groups runs by the "session_id" (or "thread_id")
// run-metadata key, which must be present on every run in the trace, not
// just the root. The LangSmith exporter (langsmith/experimental/otel/
// exporter.js:116-124) already translates any span attribute named
// `ai.telemetry.metadata.<key>` into that run's actual metadata — so
// stamping THAT attribute prefix here, on every span, is how a plain
// SpanProcessor can inject metadata the AI SDK itself was never told to
// add. The value is read from OTEL baggage set once per conversation turn
// in agent/channels/catalog.ts (see withConversationBaggage there) — every
// span created inside that turn's call stack inherits the SAME baggage via
// standard OTEL context propagation, so this needs no knowledge of eve's
// own internal span/attribute naming (which wasn't reliably determinable
// in the time available — see this session's report for what was tried).
const CONVERSATION_BAGGAGE_KEY = "conversation_id";

class ThreadMetadataSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const conversationId = propagation.getBaggage(parentContext)?.getEntry(CONVERSATION_BAGGAGE_KEY)?.value;
    if (!conversationId) return;
    span.setAttribute("ai.telemetry.metadata.session_id", conversationId);
    span.setAttribute("ai.telemetry.metadata.thread_id", conversationId);
  }
  onEnd(): void {}
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

// LangSmithOTLPTraceExporter reads LANGSMITH_API_KEY / LANGSMITH_PROJECT /
// LANGSMITH_ENDPOINT from the environment itself (see .env.example) and
// defaults the OTLP endpoint to `${LANGSMITH_ENDPOINT}/otel/v1/traces`.
//
// `spanProcessors` here does NOT replace the default export wiring: at
// @vercel/otel's own SDK-registration layer, `traceExporter` is ALWAYS
// wrapped in its own BatchSpanProcessor and appended after whatever
// `spanProcessors` resolves to, regardless of whether "auto" is included
// in that array (confirmed by reading @vercel/otel's own registration
// logic directly, not assumed) — so adding ThreadMetadataSpanProcessor
// here is additive, not a replacement of the exporter wiring.
export default defineInstrumentation({
  setup: ({ agentName }) =>
    registerOTel({
      serviceName: agentName,
      traceExporter: new FilteringSpanExporter(new LangSmithOTLPTraceExporter()),
      spanProcessors: [new ThreadMetadataSpanProcessor()],
    }),
});
