// Verbatim copies of the three pieces added to agent/instrumentation.ts in commit 031fb2b
// (git show 031fb2b -- agent/instrumentation.ts). Copied, not imported, per the harness brief —
// agent/instrumentation.ts must not be touched or live-iterated on (KNOWN_ISSUES risk: editing
// it orphans parked eve sessions). Divergence risk: if instrumentation.ts changes after this
// spike, this copy goes stale silently. Diffed against instrumentation.ts by eye on 2026-07-13.

import { propagation } from "@opentelemetry/api";

function isNoiseSpan(span) {
  const name = span.name;
  if (/^GET \/(catalog\/|eve\/v1\/health)/.test(name)) return true;
  const url = span.attributes["http.url"] ?? span.attributes["url.full"];
  if (typeof url === "string" && url.includes("upstash.io")) return true;
  return false;
}

class FilteringSpanExporter {
  constructor(inner) {
    this.inner = inner;
  }
  export(spans, resultCallback) {
    this.inner.export(
      spans.filter((span) => !isNoiseSpan(span)),
      resultCallback,
    );
  }
  shutdown() {
    return this.inner.shutdown();
  }
  forceFlush() {
    return this.inner.forceFlush ? this.inner.forceFlush() : Promise.resolve();
  }
}

const CONVERSATION_BAGGAGE_KEY = "conversation_id";

class ThreadMetadataSpanProcessor {
  onStart(span, parentContext) {
    const conversationId = propagation.getBaggage(parentContext)?.getEntry(CONVERSATION_BAGGAGE_KEY)?.value;
    if (!conversationId) return;
    span.setAttribute("ai.telemetry.metadata.session_id", conversationId);
    span.setAttribute("ai.telemetry.metadata.thread_id", conversationId);
  }
  onEnd() {}
  shutdown() {
    return Promise.resolve();
  }
  forceFlush() {
    return Promise.resolve();
  }
}

// --- Harness-only helpers below (not part of the copied instrumentation.ts pieces) ---

// Force every harness run into its own LangSmith project so nothing pollutes the real
// eve-events project, per the brief. Must run BEFORE any LangSmithOTLPTraceExporter is
// constructed, since it reads LANGSMITH_PROJECT at construction time.
export function pinHarnessProject(name = "eve-events-harness") {
  process.env.LANGSMITH_PROJECT = name;
}

export { isNoiseSpan, FilteringSpanExporter, ThreadMetadataSpanProcessor, CONVERSATION_BAGGAGE_KEY };

// Poll the LangSmith runs API for a run by exact name inside our pinned harness project.
// Returns the run object once found, or null after timing out. Uses the langsmith SDK's
// Client.listRuns (async generator) rather than a raw fetch, since the SDK already knows the
// auth header shape and API URL resolution (including LANGSMITH_ENDPOINT override).
export async function waitForRunByName(runName, { timeoutMs = 30000, pollMs = 2000, projectName } = {}) {
  const { Client } = await import("langsmith");
  const client = new Client();
  const project = projectName ?? process.env.LANGSMITH_PROJECT;
  const deadline = Date.now() + timeoutMs;
  let lastAttemptError;
  while (Date.now() < deadline) {
    try {
      for await (const run of client.listRuns({ projectName: project, limit: 50 })) {
        if (run.name === runName) return run;
      }
    } catch (err) {
      lastAttemptError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  if (lastAttemptError) {
    console.error(`  (last listRuns error while polling for "${runName}":`, lastAttemptError.message, ")");
  }
  return null;
}
