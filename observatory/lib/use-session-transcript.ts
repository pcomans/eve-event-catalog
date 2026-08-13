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
// shape: 0.3–0.6s connections), which also has to have delivered events —
// see createReconnectPolicy for why either test alone fails. MAX_ATTEMPTS is
// NOT a give-up: after ~2 minutes the ladder simply sits at the 60s ceiling
// and the hook says on screen that it is still retrying. Retiring here was
// tried and reverted — a failed fetch rejects in ~0ms, so a routine wifi drop
// burns every attempt in about two minutes and would strand the transcript
// for the life of the tab.
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
  | { readonly kind: "closed"; readonly published: boolean }
  /** The request or the read failed. */
  | { readonly kind: "failed"; readonly message: string; readonly published: boolean };
// `published` = this connection actually delivered events. It is half of the
// "was that connection healthy?" test the reconnect policy applies; see
// createReconnectPolicy for why duration alone and delivery alone are each
// insufficient.

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
  let published = false;

  try {
    const res = await fetchStream(`/api/sessions/${encodeURIComponent(sessionId)}/stream`, { signal });
    if (!res.ok || !res.body) return { kind: "failed", message: `stream ${res.status}`, published };
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
        published = true;
        onMessages(data.messages.map((message) => ({ message, at: firstSeenAt.get(message.id) ?? "" })));
      }
    }
  } catch (err) {
    // Terminality survives a late read error. The upstream closes immediately
    // after a terminal event, so a hiccup on that last chunk is a real (if
    // narrow) window — and forgetting we saw session.failed there would
    // reconnect into exactly the storm this module exists to prevent.
    if (terminal) return { kind: "terminal" };
    return { kind: "failed", message: err instanceof Error ? err.message : String(err), published };
  }

  return terminal ? { kind: "terminal" } : { kind: "closed", published };
}

/** Decides how long to wait before the next reconnect. */
export interface ReconnectPolicy {
  /**
   * Records a connection that ended without the session being over; returns
   * the delay before the next attempt, and whether the ladder is exhausted
   * (i.e. we are now trickling at the cap rather than genuinely retrying).
   */
  next(outcome: { heldMs: number; published: boolean }): { delayMs: number; exhausted: boolean };
}

/**
 * Never gives up, and that is deliberate. An earlier version returned `null`
 * after MAX_ATTEMPTS to retire the loop — but a failed fetch rejects in ~0ms,
 * so a routine wifi drop, lid close, or eve redeploy burns all seven
 * connections in ~2 minutes and the transcript would then stay dead for the
 * life of the tab, on a dashboard meant to be left open unattended. The old
 * code self-healed in 2s. Flooring at MAX_RETRY_MS keeps ~96% of the win
 * (~120 invocations/hour against the storm's ~3,000) and leaves `null`
 * meaning exactly one thing: the session is over.
 *
 * Health takes BOTH a long-enough connection and delivered events. Neither
 * alone works: duration alone lets an upstream that accepts, stalls 30s and
 * closes empty reset the ladder forever; delivery alone is worse still, since
 * the incident shape — replay the full history, close in 0.4s — publishes
 * every time and would reset the ladder into an unbounded 2s loop.
 */
export function createReconnectPolicy(): ReconnectPolicy {
  let attempts = 0;
  return {
    next({ heldMs, published }) {
      // Held open AND delivering: not a flap, most likely the proxy route's
      // own maxDuration cutting a live stream. Start the ladder over rather
      // than punishing a healthy page.
      if (heldMs >= HEALTHY_MS && published) attempts = 0;
      attempts += 1;
      return {
        delayMs: Math.min(FIRST_RETRY_MS * 2 ** (attempts - 1), MAX_RETRY_MS),
        exhausted: attempts > MAX_ATTEMPTS,
      };
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
 * So now: a terminal end — and ONLY a terminal end — retires the loop for
 * good; anything else backs off exponentially and then trickles at the 60s
 * ceiling (createReconnectPolicy), so a page that lost its connection still
 * heals itself; and the loop itself is poll-loop.ts's, which means a hidden
 * tab holds no timer and reconnects nothing until someone looks at it again.
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
    // outcome. `null` retires the loop, and now means ONLY "the session is
    // over" — every other ending keeps a delay. Assigned on every path
    // through the run before the getter is consulted (the getter runs in the
    // loop's finally, strictly after the awaited run resolves).
    let nextDelayMs: number | null;

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
      const { delayMs, exhausted } = policy.next({ heldMs: Date.now() - startedAt, published: end.published });
      nextDelayMs = delayMs;
      if (exhausted) {
        setError(`${reason} — still retrying every ${Math.round(MAX_RETRY_MS / 1000)}s; reload for an immediate retry`);
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
