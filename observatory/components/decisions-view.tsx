"use client";

import { useEffect, useState } from "react";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { DecisionMessage } from "@/components/decision-message";
import { StatusBadge } from "@/components/status-badge";
import type { ConversationRecord, HistoryEntry } from "@/lib/catalog-types";
import { interleaveTimeline } from "@/lib/interleave-timeline";
import { usePolling } from "@/lib/use-polling";
import { useSessionTranscript } from "@/lib/use-session-transcript";

// Deliberately smaller/quieter than a Message bubble — this is context
// between the agent's turns (e.g. the wake that wound the clock right
// before a turn starts), not content competing with them for attention.
function TimelineEvent({ event }: { event: HistoryEntry }) {
  return (
    <div className="flex w-fit items-center gap-2 self-center rounded-md border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
      <span className="font-mono">{event.timestamp.slice(11, 19)}</span>
      <span>
        {event.action} — {event.provider}·{event.event}
      </span>
      <StatusBadge status={event.status} />
    </div>
  );
}

// The caller (app/decisions/page.tsx) renders this keyed on conversationId
// — `<DecisionsView key={conversationId} .../>` — so a conversationId
// change remounts the component with fresh state instead of this effect
// needing to reset conversation/resolveError/resolving by hand. A manual
// reset would need a synchronous setState at the top of the effect body,
// which trades one extra render for the same result the key already gives
// for free (and trips react-hooks/set-state-in-effect).
export function DecisionsView({ conversationId }: { conversationId: string }) {
  const [conversation, setConversation] = useState<ConversationRecord | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  // A 404 here means "no conversation record exists yet" — the pre-launch
  // state (the campaign's first turn hasn't happened) and a typo'd/nonexistent
  // ?conversation= override are the SAME semantic (per task #35): neither is
  // a genuine failure, so it's tracked separately from resolveError (network
  // errors, 500s, ...) rather than lumped into one generic message.
  const [conversationNotFound, setConversationNotFound] = useState(false);
  const [resolving, setResolving] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, { signal: controller.signal })
      .then((res) => {
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`conversations/${conversationId} -> ${res.status}`);
        return res.json() as Promise<ConversationRecord>;
      })
      .then((record) => {
        if (!cancelled) {
          if (record === null) {
            setConversationNotFound(true);
          } else {
            setConversation(record);
          }
          setResolving(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setResolveError(err instanceof Error ? err.message : String(err));
          setResolving(false);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [conversationId]);

  const { messages, error: streamError } = useSessionTranscript(conversation?.sessionId ?? null);
  // Reuses the same self-chaining/abort-safe poll as the Event Feed page —
  // no separate fetch logic needed for the catalog-event half of the timeline.
  const { data: allEvents } = usePolling<HistoryEntry[]>("/api/events", []);
  const events = allEvents.filter((e) => e.conversationId === conversationId);
  const timeline = interleaveTimeline(messages, events);

  const error = resolveError ?? streamError;

  return (
    <div className="p-6">
      <h1 className="mb-4 text-lg font-semibold">Decisions</h1>
      {error && <p className="mb-4 text-sm text-destructive">Failed to load: {error}</p>}
      <Conversation className="h-[75vh] rounded-md border">
        <ConversationContent>
          {resolving && <p className="text-center text-sm text-muted-foreground">Loading…</p>}
          {!resolving && conversationNotFound && (
            <ConversationEmptyState
              description="The campaign's first turn happens at the next market open (13:30 UTC, weekdays)."
              title="No turns yet"
            />
          )}
          {!resolving && !conversationNotFound && timeline.length === 0 && !error && (
            <ConversationEmptyState
              description={`Waiting for ${conversationId} to start its next turn.`}
              title="No messages yet"
            />
          )}
          {timeline.map((item) =>
            item.kind === "message" ? (
              <DecisionMessage key={item.message.id} message={item.message} />
            ) : (
              <TimelineEvent key={`${item.event.subscriptionId}:${item.event.action}:${item.at}`} event={item.event} />
            ),
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
    </div>
  );
}
