"use client";

import { useEffect, useState } from "react";
import { defaultMessageReducer, type HandleMessageStreamEvent } from "eve/client";

import type { TimelineMessage } from "./interleave-timeline.ts";
import { startPollLoop } from "./poll-loop.ts";

// Reconnect ladder. 2s is the delay this hook always used, kept as the first
// step so a genuinely dropped connection still recovers about as fast as it
// used to; every step after it doubles, so no failure mode can sit at a fixed
// 2s forever. 60s is the ceiling — slower than that and a recovering stream
// would look broken to someone watching the page. HEALTHY_MS separates the two
// reasons a connection ends without the session being over: the proxy's own
// 800s maxDuration cutting a live stream (long-lived — not a flap, so the
// ladder resets), versus a stream that ends the moment it opens (the incident
// shape: 0.3–0.6s connections). MAX_ATTEMPTS bounds the total: 7 connections
// over ~2 minutes, then the loop retires and says so, instead of billing
// invocations at a fixed rate for as long as the tab stays open.
const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;
const HEALTHY_MS = 30_000;
const MAX_ATTEMPTS = 6;

// Stateless (pure initial()/reduce() functions) — one shared instance is
// fine across every hook instance, no need to recreate it per mount.
const reducer = defaultMessageReducer();

/** How one connection to the session stream ended. */
export type StreamEnd =
  /** The session itself is over — nothing will ever be appended again. */
  | { readonly kind: "terminal" }
  /** The body ended cleanly, but the session is still live or parked. */
  | { readonly kind: "closed" }
  /** The request or the read failed. */
  | { readonly kind: "failed"; readonly message: string };

/**
 * eve emits exactly two events that mean "this session's durable stream will
 * never produce another event": `session.completed` (a task-mode session
 * whose turn finished) and `session.failed` (the workflow loop hit an
 * unrecoverable error — e.g. the gateway credit exhaustion that made
 * campaign-6's session terminal). Verified against eve's own emission source,
 * node_modules/eve/dist/src/harness/emission.js: `emitTurnEpilogue` ends a
 * turn with `session.waiting` in conversation mode and `session.completed` in
 * task mode, `emitFailedStep` ends with `session.failed`, and
 * `emitRecoverableFailedTurn` ends with `session.waiting`.
 *
 * `session.waiting` is deliberately NOT terminal: it means the session parked
 * for the next user message, so the stream stays open for future turns and an
 * ended connection really is a dropped one.
 */
function isTerminalStreamEvent(event: HandleMessageStreamEvent): boolean {
  return event.type === "session.completed" || event.type === "session.failed";
}

/**
 * Reads one connection to a session's durable event stream to its end,
 * publishing the projected messages as they arrive, and reports HOW it ended
 * so the caller can tell "the session is over" from "the connection dropped".
 *
 * Separated from the hook (and given an injectable `fetchStream`) because
 * this is where every decision lives — a React hook can't be driven from
 * node:test, but this can (use-session-transcript.test.ts).
 */
export async function drainSessionStream(options: {
  sessionId: string;
  onMessages: (messages: readonly TimelineMessage[]) => void;
  signal?: AbortSignal;
  fetchStream?: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<StreamEnd> {
  const { sessionId, onMessages, signal, fetchStream = fetch } = options;
  let data = reducer.initial();
  const firstSeenAt = new Map<string, string>();
  let terminal = false;

  try {
    const res = await fetchStream(`/api/sessions/${encodeURIComponent(sessionId)}/stream`, { signal });
    if (!res.ok || !res.body) return { kind: "failed", message: `stream ${res.status}` };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? ""; // partial tail — kept for the next chunk
      // One publish per CHUNK, not per line: a durable replay can be
      // hundreds/thousands of events, and reader.read() gives no guarantee
      // they arrive as one chunk — publishing inside the line loop would
      // re-render and re-sort the timeline that many times per connect. All
      // the pure reducer/map work above still runs per line; only the state
      // update (and the re-render/sort it triggers) is batched per chunk.
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: HandleMessageStreamEvent;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        data = reducer.reduce(data, event);
        if (isTerminalStreamEvent(event)) terminal = true;
        const at = event.meta?.at;
        if (at) {
          for (const message of data.messages) {
            if (!firstSeenAt.has(message.id)) firstSeenAt.set(message.id, at);
          }
        }
      }
      if (lines.length > 0) {
        onMessages(data.messages.map((message) => ({ message, at: firstSeenAt.get(message.id) ?? "" })));
      }
    }
  } catch (err) {
    return { kind: "failed", message: err instanceof Error ? err.message : String(err) };
  }

  return terminal ? { kind: "terminal" } : { kind: "closed" };
}

/** Decides how long to wait before the next reconnect, or to stop trying. */
export interface ReconnectPolicy {
  /**
   * Records a connection that ended without the session being over, given how
   * long it was held; returns the delay before the next attempt, or `null`
   * once this hook should stop reconnecting altogether.
   */
  next(heldMs: number): number | null;
}

export function createReconnectPolicy(): ReconnectPolicy {
  let attempts = 0;
  return {
    next(heldMs) {
      // A connection that stayed open and delivering wasn't a flap — most
      // likely the proxy route's own maxDuration cut a live stream — so the
      // ladder starts over rather than punishing a healthy page.
      if (heldMs >= HEALTHY_MS) attempts = 0;
      attempts += 1;
      if (attempts > MAX_ATTEMPTS) return null;
      return Math.min(FIRST_RETRY_MS * 2 ** (attempts - 1), MAX_RETRY_MS);
    },
  };
}

/**
 * Replays a session's durable event stream through eve's own
 * defaultMessageReducer, projecting it into the same EveMessage[] shape
 * ai-elements' Message/Reasoning/Tool components render. Read-only: no
 * `send`, this never writes to the session.
 *
 * defaultMessageReducer verified against its source
 * (node_modules/eve/dist/src/client/message-reducer.js) before relying on
 * it — see the M2 report for the full findings. Two relevant to this hook:
 * parts are upserted by a `type:stepIndex` key, so consecutive
 * message.appended/reasoning.appended for the same step correctly update
 * one part in place (no hand-rolled coalescing needed here, unlike
 * observe-page.ts); and a null message.completed removes the text part
 * outright rather than leaving an empty one. EveMessage itself carries no
 * timestamp, so this hook tracks one separately: `firstSeenAt` records the
 * meta.at of the first raw event that produced each message id, giving
 * interleave-timeline.ts something to sort assistant/user messages by
 * alongside catalog events.
 *
 * Reconnect policy — this is what caused a production request storm
 * (2026-08-12) and it is the reason drainSessionStream reports an END KIND
 * rather than just returning. The old loop rescheduled unconditionally every
 * 2s, treating a clean end-of-stream exactly like a dropped connection. That
 * is fine while a session is live or parked (the upstream holds the
 * connection open for future turns, so an end really is a drop), and ruinous
 * once a session is terminal: the upstream hands back the full history and
 * closes at once, the endpoint has no cursor so every reconnect replays from
 * index 0, and each reconnect costs two function invocations (browser →
 * observatory proxy → eve). Measured against the terminal campaign-6 session:
 * ~2.4s per cycle, ~1,500 reconnects/hour/tab, ~3,000 invocations/hour/tab.
 * So now: a terminal end retires the loop for good, anything else backs off
 * exponentially (createReconnectPolicy) and gives up after MAX_ATTEMPTS, and
 * the loop itself is poll-loop.ts's — which means a hidden tab holds no timer
 * and reconnects nothing until someone looks at it again.
 *
 * The one thing this gives up: when the campaign's conversation moves on to a
 * NEW session, this page won't notice by itself. It never did — decisions-view
 * resolves conversation → sessionId once on mount — so a reload was always
 * required; the difference is that the page is now quiet while it waits
 * instead of re-downloading a dead session's history forever.
 */
export function useSessionTranscript(sessionId: string | null) {
  const [messages, setMessages] = useState<readonly TimelineMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    const id = sessionId;

    let cancelled = false;
    const controller = new AbortController();
    const policy = createReconnectPolicy();
    // Read by the interval getter below, written by each connection's
    // outcome. `null` retires the loop.
    let nextDelayMs: number | null = FIRST_RETRY_MS;

    let firstAttempt = true;

    const stop = startPollLoop(async () => {
      // Cleared once per session id, not once per reconnect: every connect
      // replays from index 0, so each publish already replaces the
      // projection wholesale — and with backoff, clearing per attempt would
      // blank the transcript for the whole (up to 60s) gap.
      if (firstAttempt) {
        firstAttempt = false;
        setMessages([]);
        setError(null);
      }
      const startedAt = Date.now();
      const end = await drainSessionStream({
        sessionId: id,
        signal: controller.signal,
        onMessages: (next) => {
          if (cancelled) return;
          setMessages(next);
          // A connection that is delivering events is healthy: drop whatever
          // error the previous attempt left on screen.
          setError(null);
        },
      });
      if (cancelled) return;
      if (end.kind === "terminal") {
        nextDelayMs = null;
        return;
      }
      const reason = end.kind === "failed" ? end.message : "stream closed without ending the session";
      nextDelayMs = policy.next(Date.now() - startedAt);
      if (nextDelayMs === null) {
        setError(`${reason} — gave up reconnecting after ${MAX_ATTEMPTS} attempts, reload to retry`);
      } else if (end.kind === "failed") {
        setError(reason);
      }
    }, () => nextDelayMs);

    return () => {
      cancelled = true;
      controller.abort();
      stop();
    };
  }, [sessionId]);

  return { messages, error };
}
