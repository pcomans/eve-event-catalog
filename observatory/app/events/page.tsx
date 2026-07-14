"use client";

import { useEffect, useState } from "react";

import { usePolling } from "@/lib/use-polling";
import { relativeTime } from "@/lib/relative-time";
import { StatusBadge } from "@/components/status-badge";
import type { HistoryEntry } from "@/lib/catalog-types";

export default function EventsPage() {
  const { data: events, error, loading } = usePolling<HistoryEntry[]>("/api/events", []);

  // Ticks once a second purely to re-render the "Xs ago" column — the data
  // itself only refreshes on the 2s poll in usePolling.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(tick);
  }, []);

  return (
    <div className="p-6">
      <h1 className="mb-4 text-lg font-semibold">Event Feed</h1>
      {error && <p className="mb-4 text-sm text-destructive">Failed to load: {error}</p>}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Time</th>
              <th className="px-3 py-2 text-left">Elapsed</th>
              <th className="px-3 py-2 text-left">Action</th>
              <th className="px-3 py-2 text-left">Provider / Event</th>
              <th className="px-3 py-2 text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && events.length === 0 && !error && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                  No events yet.
                </td>
              </tr>
            )}
            {events.map((evt, i) => (
              <tr key={`${evt.subscriptionId}-${evt.timestamp}-${i}`} className="border-t">
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                  {evt.timestamp.slice(11, 19)}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                  {relativeTime(evt.timestamp, now)}
                </td>
                <td className="px-3 py-2">{evt.action}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {evt.provider} / {evt.event}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={evt.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
