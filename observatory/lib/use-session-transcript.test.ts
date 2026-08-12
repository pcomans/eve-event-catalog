import assert from "node:assert/strict";
import { test } from "node:test";

import { createReconnectPolicy, drainSessionStream } from "./use-session-transcript.ts";

// One NDJSON body, delivered as the given chunks — `reader.read()` gives no
// guarantee that a line arrives whole, so tests split lines on purpose.
function ndjsonResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

function line(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

// A minimal but real assistant turn, in the exact shapes eve's own
// defaultMessageReducer consumes (node_modules/eve/dist/src/protocol/message.d.ts).
const TURN = "turn-1";
const userMessage = {
  type: "message.received",
  data: { message: "hello", sequence: 1, turnId: TURN },
  meta: { at: "2026-08-12T10:00:00.000Z" },
};
const assistantMessage = {
  type: "message.completed",
  data: { message: "hi there", sequence: 2, stepIndex: 0, turnId: TURN },
  meta: { at: "2026-08-12T10:00:01.000Z" },
};
const sessionFailed = {
  type: "session.failed",
  data: { code: "MODEL_CALL_FAILED", message: "A positive credit balance is required", sessionId: "s1" },
  meta: { at: "2026-08-12T10:00:02.000Z" },
};
const sessionCompleted = { type: "session.completed", meta: { at: "2026-08-12T10:00:02.000Z" } };
const sessionWaiting = {
  type: "session.waiting",
  data: { wait: "next-user-message" },
  meta: { at: "2026-08-12T10:00:02.000Z" },
};

function collector() {
  const published: (readonly { at: string; message: { id: string } }[])[] = [];
  return {
    published,
    onMessages: (messages: readonly { at: string; message: { id: string } }[]) => {
      published.push(messages);
    },
  };
}

test("drainSessionStream: a session.failed tail ends the stream terminally — never reconnect", async () => {
  const sink = collector();
  const end = await drainSessionStream({
    sessionId: "s1",
    onMessages: sink.onMessages,
    fetchStream: async () => ndjsonResponse([line(userMessage), line(assistantMessage), line(sessionFailed)]),
  });

  // The whole production incident: this session is over. The upstream will
  // hand back the same 5.6KB history for as long as anything keeps asking.
  assert.deepEqual(end, { kind: "terminal" });
});

test("drainSessionStream: session.completed is terminal too", async () => {
  const sink = collector();
  const end = await drainSessionStream({
    sessionId: "s1",
    onMessages: sink.onMessages,
    fetchStream: async () => ndjsonResponse([line(userMessage), line(sessionCompleted)]),
  });

  assert.deepEqual(end, { kind: "terminal" });
});

test("drainSessionStream: session.waiting is a PARKED session, not a terminal one", async () => {
  const sink = collector();
  const end = await drainSessionStream({
    sessionId: "s1",
    onMessages: sink.onMessages,
    fetchStream: async () => ndjsonResponse([line(userMessage), line(assistantMessage), line(sessionWaiting)]),
  });

  // A parked session accepts future turns, so an ended connection here is a
  // dropped/cut connection, not the end of the session — reconnecting is right.
  assert.deepEqual(end, { kind: "closed" });
});

test("drainSessionStream: a clean end with no terminal marker is 'closed', not terminal", async () => {
  const sink = collector();
  const end = await drainSessionStream({
    sessionId: "s1",
    onMessages: sink.onMessages,
    fetchStream: async () => ndjsonResponse([line(userMessage)]),
  });

  assert.deepEqual(end, { kind: "closed" });
});

test("drainSessionStream: projects messages across chunk boundaries, timestamped by first sighting", async () => {
  const sink = collector();
  const whole = line(userMessage) + line(assistantMessage) + line(sessionFailed);
  const split = Math.floor(whole.length / 2);
  const end = await drainSessionStream({
    sessionId: "s1",
    onMessages: sink.onMessages,
    fetchStream: async () => ndjsonResponse([whole.slice(0, split), whole.slice(split)]),
  });

  assert.deepEqual(end, { kind: "terminal" });
  const final = sink.published.at(-1);
  assert.ok(final, "the drain must publish at least once");
  assert.deepEqual(
    final.map((m) => [m.message.id, m.at]),
    [
      [`${TURN}:user`, "2026-08-12T10:00:00.000Z"],
      [`${TURN}:assistant`, "2026-08-12T10:00:01.000Z"],
    ],
  );
});

test("drainSessionStream: passes the session id through to the stream route", async () => {
  const seen: string[] = [];
  const sink = collector();
  await drainSessionStream({
    sessionId: "session/with space",
    onMessages: sink.onMessages,
    fetchStream: async (url) => {
      seen.push(String(url));
      return ndjsonResponse([line(sessionCompleted)]);
    },
  });

  assert.deepEqual(seen, ["/api/sessions/session%2Fwith%20space/stream"]);
});

test("drainSessionStream: a non-ok response is a failure, not a clean end", async () => {
  const sink = collector();
  const end = await drainSessionStream({
    sessionId: "s1",
    onMessages: sink.onMessages,
    fetchStream: async () => new Response("nope", { status: 502 }),
  });

  assert.deepEqual(end, { kind: "failed", message: "stream 502" });
});

test("drainSessionStream: a mid-body read error is a failure", async () => {
  const sink = collector();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(line(userMessage)));
      controller.error(new Error("network error"));
    },
  });
  const end = await drainSessionStream({
    sessionId: "s1",
    onMessages: sink.onMessages,
    fetchStream: async () => new Response(body, { status: 200 }),
  });

  assert.deepEqual(end, { kind: "failed", message: "network error" });
});

test("createReconnectPolicy: backs off exponentially from 2s and caps at 60s", () => {
  const policy = createReconnectPolicy();
  const delays = [0, 0, 0, 0, 0, 0].map(() => policy.next(300));

  assert.deepEqual(delays, [2_000, 4_000, 8_000, 16_000, 32_000, 60_000]);
});

test("createReconnectPolicy: gives up rather than retrying at a fixed rate forever", () => {
  const policy = createReconnectPolicy();
  for (let i = 0; i < 6; i += 1) policy.next(300);

  assert.equal(policy.next(300), null, "a stream that only ever flaps must stop costing invocations");
});

test("createReconnectPolicy: a connection that held open resets the backoff", () => {
  const policy = createReconnectPolicy();
  policy.next(300);
  policy.next(300);
  policy.next(300);

  // The legitimate reconnect: the proxy's own maxDuration cut a genuinely
  // live stream after it had been delivering for a long time. That is not a
  // flap, so the next attempt starts from the bottom of the ladder again.
  assert.equal(policy.next(700_000), 2_000);
});
