"use client";

import { usePolling } from "@/lib/use-polling";
import { StatusBadge } from "@/components/status-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Subscription } from "@/lib/catalog-types";

function short(id: string) {
  return id.slice(0, 8);
}

function fmtTime(iso: string | null) {
  return iso ? iso.slice(11, 19) : "—";
}

function MonoTooltip({ full, children }: { full: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger className="font-mono text-xs">{children}</TooltipTrigger>
      <TooltipContent>{full}</TooltipContent>
    </Tooltip>
  );
}

export default function SubscriptionsPage() {
  const { data: subscriptions, error, loading } = usePolling<Subscription[]>("/api/subscriptions", []);

  // Same tiebreak as the eve app's inline observe page: the registry
  // returns Redis-set order, which shuffles every poll.
  const rows = [...subscriptions].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );

  return (
    <div className="p-6">
      <h1 className="mb-4 text-lg font-semibold">Subscriptions</h1>
      {error && <p className="mb-4 text-sm text-destructive">Failed to load: {error}</p>}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Id</th>
              <th className="px-3 py-2 text-left">Conversation</th>
              <th className="px-3 py-2 text-left">Provider / Event</th>
              <th className="px-3 py-2 text-left">Resource / Params</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Created</th>
              <th className="px-3 py-2 text-left">Armed</th>
              <th className="px-3 py-2 text-left">Fired</th>
              <th className="px-3 py-2 text-left">Expires</th>
              <th className="px-3 py-2 text-left">Last error</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && !error && (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-muted-foreground">
                  No subscriptions.
                </td>
              </tr>
            )}
            {rows.map((sub) => (
              <tr key={sub.id} className="border-t">
                <td className="px-3 py-2">
                  <MonoTooltip full={sub.id}>{short(sub.id)}</MonoTooltip>
                </td>
                <td className="px-3 py-2">
                  <MonoTooltip full={sub.conversationId}>{short(sub.conversationId)}</MonoTooltip>
                </td>
                <td className="px-3 py-2">
                  {sub.provider} / {sub.event}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                  {sub.resource} {JSON.stringify(sub.params ?? {})}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={sub.status} />
                </td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{fmtTime(sub.createdAt)}</td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{fmtTime(sub.armedAt)}</td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{fmtTime(sub.firedAt)}</td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{fmtTime(sub.expiresAt)}</td>
                <td className="px-3 py-2 max-w-[16rem] truncate text-xs text-destructive">
                  {sub.lastError ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
