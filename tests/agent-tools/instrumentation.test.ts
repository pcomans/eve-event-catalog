import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

import { FilteringSpanExporter, isNoiseSpan } from "../../agent/instrumentation.ts";

// Minimal ReadableSpan stubs — only the fields isNoiseSpan() reads.
function noiseSpan(name: string): ReadableSpan {
  return { name, attributes: {} } as unknown as ReadableSpan;
}
function realSpan(name: string): ReadableSpan {
  return { name, attributes: {} } as unknown as ReadableSpan;
}

function fakeInner() {
  const calls: ReadableSpan[][] = [];
  const inner: SpanExporter = {
    export(spans, resultCallback) {
      calls.push(spans);
      resultCallback({ code: 0 });
    },
    shutdown() {
      return Promise.resolve();
    },
  };
  return { inner, calls };
}

// Sanity check on the noise predicate the two tests below build batches from.
test("isNoiseSpan: GET /catalog/* and health routes are noise, everything else isn't", () => {
  assert.equal(isNoiseSpan(noiseSpan("GET /catalog/subscriptions")), true);
  assert.equal(isNoiseSpan(realSpan("ai.generateText")), false);
});

// Finding 4 (LOW): a whole batch filtered to nothing must complete locally
// (resultCallback SUCCESS) instead of forwarding an empty array to the inner
// LangSmith exporter — the installed LangSmith/OTLP stack 400s on an empty
// OTLP export ("trace_ids must be specified").
test("FilteringSpanExporter: an all-noise batch completes locally, never touches the inner exporter", () => {
  const { inner, calls } = fakeInner();
  const exporter = new FilteringSpanExporter(inner);
  const spans = [noiseSpan("GET /catalog/subscriptions"), noiseSpan("GET /eve/v1/health")];

  let result: { code: number; error?: Error } | undefined;
  exporter.export(spans, (r) => {
    result = r;
  });

  assert.equal(calls.length, 0, "inner.export must never be called for an all-noise batch");
  assert.deepEqual(result, { code: 0 });
});

test("FilteringSpanExporter: a mixed batch forwards only the kept (non-noise) spans", () => {
  const { inner, calls } = fakeInner();
  const exporter = new FilteringSpanExporter(inner);
  const noise = noiseSpan("GET /catalog/subscriptions");
  const real = realSpan("ai.generateText");

  let result: { code: number; error?: Error } | undefined;
  exporter.export([noise, real], (r) => {
    result = r;
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [real]);
  assert.deepEqual(result, { code: 0 });
});
