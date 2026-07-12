import { defineInstrumentation } from "eve/instrumentation";
import { registerOTel } from "@vercel/otel";
import { LangSmithOTLPTraceExporter } from "langsmith/experimental/otel/exporter";

// LangSmithOTLPTraceExporter reads LANGSMITH_API_KEY / LANGSMITH_PROJECT /
// LANGSMITH_ENDPOINT from the environment itself (see .env.example) and
// defaults the OTLP endpoint to `${LANGSMITH_ENDPOINT}/otel/v1/traces`.
export default defineInstrumentation({
  setup: ({ agentName }) =>
    registerOTel({
      serviceName: agentName,
      traceExporter: new LangSmithOTLPTraceExporter(),
    }),
});
