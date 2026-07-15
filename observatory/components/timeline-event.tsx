"use client";

import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { StatusBadge } from "@/components/status-badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatEtTime } from "@/lib/et-time";
import { resolveSubscriptionSectionState, type SubscriptionSectionState } from "@/lib/subscription-section-state";
import type { HistoryEntry, Subscription } from "@/lib/catalog-types";

// HistoryEntry's fixed fields are already shown (in the trigger, or as a
// labeled Field below) — everything else on the record (reason, error,
// snapshot, ...) is genuinely extra per-event data, worth surfacing when
// expanded but not known ahead of time (HistoryEntry's own `[key: string]:
// unknown` index signature is exactly this: a provider/action-specific
// grab bag).
const HISTORY_ENTRY_KNOWN_FIELDS = new Set([
  "action",
  "timestamp",
  "subscriptionId",
  "conversationId",
  "provider",
  "event",
  "status",
]);

function extraHistoryFields(event: HistoryEntry): [string, unknown][] {
  return Object.entries(event).filter(([key]) => !HISTORY_ENTRY_KNOWN_FIELDS.has(key));
}

function fmtExtra(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono text-foreground">{value}</dd>
    </div>
  );
}

// p6p gate finding (MED): four independent `state.kind === "..."` checks
// silently render nothing if a fifth SubscriptionSectionState variant is
// ever added (none of the four conditions match, no branch fires, no
// typecheck error either). An exhaustive switch with this `never` fallback
// makes that a COMPILE failure instead — the switch itself won't typecheck
// once `state` still has a variant left over at the `default` case.
function assertNever(value: never): never {
  throw new Error(`unreachable SubscriptionSectionState: ${JSON.stringify(value)}`);
}

function SubscriptionSection({ state }: { state: SubscriptionSectionState }) {
  switch (state.kind) {
    case "loading":
      return <p>Loading subscription…</p>;
    case "error":
      return <p>Subscription details unavailable.</p>;
    case "removed":
      return <p>Subscription no longer in registry.</p>;
    case "found":
      return (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <Field label="Provider / Event" value={`${state.subscription.provider} / ${state.subscription.event}`} />
          <Field label="Resource" value={state.subscription.resource} />
          <Field label="Params" value={JSON.stringify(state.subscription.params)} />
          <Field label="Status" value={<StatusBadge status={state.subscription.status} />} />
          <Field label="Created" value={formatEtTime(state.subscription.createdAt)} />
          <Field label="Armed" value={state.subscription.armedAt ? formatEtTime(state.subscription.armedAt) : "—"} />
          <Field label="Fired" value={state.subscription.firedAt ? formatEtTime(state.subscription.firedAt) : "—"} />
          <Field label="Expires" value={state.subscription.expiresAt ? formatEtTime(state.subscription.expiresAt) : "—"} />
        </dl>
      );
    default:
      return assertNever(state);
  }
}

// Deliberately smaller/quieter than a Message bubble — this is context
// between the agent's turns (e.g. the wake that wound the clock right
// before a turn starts), not content competing with them for attention.
// Expandable (task #39): the collapsed trigger stays the same compact
// summary; expanding shows the full HistoryEntry plus the linked
// subscription's own attributes, same Collapsible pattern as a tool card
// (components/ai-elements/tool.tsx).
export function TimelineEvent({
  event,
  subscription,
  subscriptionsLoading,
  subscriptionsError,
}: {
  event: HistoryEntry;
  subscription: Subscription | undefined;
  subscriptionsLoading: boolean;
  subscriptionsError: string | null;
}) {
  const extra = extraHistoryFields(event);
  const subscriptionState = resolveSubscriptionSectionState(subscription, subscriptionsLoading, subscriptionsError);

  return (
    <Collapsible className="group w-fit self-center rounded-md border bg-muted/30 text-xs text-muted-foreground">
      <CollapsibleTrigger className="flex items-center gap-2 px-3 py-1.5">
        <span className="font-mono">{formatEtTime(event.timestamp)}</span>
        <span>
          {event.action}: {event.provider}·{event.event}
        </span>
        <StatusBadge status={event.status} />
        <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="w-80 space-y-3 border-t px-3 py-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2">
        <div>
          <div className="mb-1.5 text-xs font-medium text-foreground">Event</div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            <Field label="Subscription" value={event.subscriptionId} />
            <Field label="Conversation" value={event.conversationId} />
            <Field label="Provider / Event" value={`${event.provider} / ${event.event}`} />
            <Field label="Status" value={event.status} />
            {extra.map(([key, value]) => (
              <Field key={key} label={key} value={fmtExtra(value)} />
            ))}
          </dl>
        </div>

        <div className="border-t pt-2">
          <div className="mb-1.5 text-xs font-medium text-foreground">Subscription</div>
          <SubscriptionSection state={subscriptionState} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
