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
export function isNoiseSpan(span: ReadableSpan): boolean {
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

export class FilteringSpanExporter implements SpanExporter {
  private readonly inner: SpanExporter;
  constructor(inner: SpanExporter) {
    this.inner = inner;
  }
  export(spans: ReadableSpan[], resultCallback: (result: { code: number; error?: Error }) => void): void {
    const kept = spans.filter((span) => !isNoiseSpan(span));
    // A whole batch filtered to nothing must complete locally: the installed
    // LangSmith/OTLP stack does not special-case an empty array — it still
    // serializes and sends the (zero-span) request, which the LangSmith
    // OTLP endpoint 400s on ("trace_ids must be specified").
    if (kept.length === 0) {
      resultCallback({ code: 0 /* ExportResultCode.SUCCESS — @opentelemetry/core isn't a direct dep */ });
      return;
    }
    this.inner.export(kept, resultCallback);
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
// `traceExporter` is ALWAYS wrapped in its own BatchSpanProcessor and
// appended by @vercel/otel's own SDK-registration layer, regardless of
// what `spanProcessors` resolves to — so the LangSmith export path above
// is safe either way. But `spanProcessors` itself is NOT additive by
// default: passing an explicit array (without "auto" in it) REPLACES
// @vercel/otel's own default processors, including the Vercel-runtime
// trace drain (BatchSpanProcessor(VercelRuntimeSpanExporter)). "auto" is
// the literal @vercel/otel's SpanProcessorOrName type uses to mean
// "include the default processors too" (@vercel/otel/dist/types/types.d.ts)
// — it must stay in this array or the platform trace drain silently stops.
export default defineInstrumentation({
  setup: ({ agentName }) =>
    registerOTel({
      serviceName: agentName,
      traceExporter: new FilteringSpanExporter(new LangSmithOTLPTraceExporter()),
      spanProcessors: [new ThreadMetadataSpanProcessor(), "auto"],
    }),
});
