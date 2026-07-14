"use client";

import { useEffect, useState } from "react";
import { defaultMessageReducer, type HandleMessageStreamEvent } from "eve/client";

import type { TimelineMessage } from "./interleave-timeline.ts";

const RETRY_MS = 2000;

// Stateless (pure initial()/reduce() functions) — one shared instance is
// fine across every hook instance, no need to recreate it per mount.
const reducer = defaultMessageReducer();

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
 * The upstream stream never closes for a live/parked session (see
 * catalog-source.ts's fetchSessionStream), so this reads it incrementally
 * line-by-line (same NDJSON framing as the eve app's own inline observe
 * page) rather than awaiting a full body. If the read loop ends or errors —
 * a genuinely closed/terminal session, or a dropped connection — it
 * reconnects after a short delay; the upstream stream replays full history
 * from index 0 on every (re)connect, so a fresh reducer run from `initial()`
 * on reconnect reproduces the same projection, not a duplicate.
 */
export function useSessionTranscript(sessionId: string | null) {
  const [messages, setMessages] = useState<readonly TimelineMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    async function pump() {
      let data = reducer.initial();
      const firstSeenAt = new Map<string, string>();
      setMessages([]);
      setError(null);
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId!)}/stream`, {
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? ""; // partial tail — kept for the next chunk
          // One React state publish per CHUNK, not per line: a durable
          // replay can be hundreds/thousands of events, and reader.read()
          // gives no guarantee they arrive as one chunk — publishing inside
          // the line loop would re-render and re-sort the timeline that many
          // times per reconnect. All the pure reducer/map work above still
          // runs per line; only the state update (and the re-render/sort it
          // triggers in the timeline) is batched to once per chunk.
          for (const line of lines) {
            if (!line.trim()) continue;
            let event: HandleMessageStreamEvent;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }
            data = reducer.reduce(data, event);
            const at = event.meta?.at;
            if (at) {
              for (const message of data.messages) {
                if (!firstSeenAt.has(message.id)) firstSeenAt.set(message.id, at);
              }
            }
          }
          if (!cancelled && lines.length > 0) {
            setMessages(data.messages.map((message) => ({ message, at: firstSeenAt.get(message.id) ?? "" })));
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) retryTimer = setTimeout(pump, RETRY_MS);
      }
    }

    pump();
    return () => {
      cancelled = true;
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [sessionId]);

  return { messages, error };
}
