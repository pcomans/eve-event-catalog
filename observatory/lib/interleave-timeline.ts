import type { EveMessage } from "eve/client";

import type { HistoryEntry } from "./catalog-types.ts";

// A projected assistant/user message, timestamped by the first raw stream
// event that produced it (see use-session-transcript.ts — EveMessage itself
// carries no timestamp; defaultMessageReducer's projection drops it).
export interface TimelineMessage {
  readonly at: string;
  readonly message: EveMessage;
}

export type TimelineItem =
  | { readonly kind: "message"; readonly at: string; readonly message: EveMessage }
  | { readonly kind: "event"; readonly at: string; readonly event: HistoryEntry };

function timelineItemSortKey(item: TimelineItem): string {
  // Deterministic tiebreak for equal timestamps: message before event (a
  // message "at" is when it started, so it reads first if a catalog event
  // landed at the exact same instant), then by a stable per-kind identity.
  const kindRank = item.kind === "message" ? "0" : "1";
  const identity = item.kind === "message" ? item.message.id : `${item.event.subscriptionId}:${item.event.action}`;
  return `${item.at}:${kindRank}:${identity}`;
}

/**
 * Merges a conversation's projected messages with its catalog events
 * (already filtered to that conversationId by the caller) into one
 * chronologically-sorted timeline. Pure: no fetching, no reducer, just sort.
 */
export function interleaveTimeline(messages: readonly TimelineMessage[], events: readonly HistoryEntry[]): TimelineItem[] {
  const items: TimelineItem[] = [
    ...messages.map((m): TimelineItem => ({ kind: "message", at: m.at, message: m.message })),
    ...events.map((e): TimelineItem => ({ kind: "event", at: e.timestamp, event: e })),
  ];
  return items.sort((a, b) => timelineItemSortKey(a).localeCompare(timelineItemSortKey(b)));
}
