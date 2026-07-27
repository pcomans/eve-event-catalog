"use client";

import { useEffect, useRef, useState } from "react";

import type { EventFeedResponse, HistoryEntry } from "./catalog-types.ts";
import { mergeEventFeedWindow } from "./event-feed-window.ts";

const POLL_MS = 2000;

// Cursor-polling companion to usePolling (use-polling.ts), specific to the
// delta feed (GET /api/event-feed — catalog/event-feed.ts). Self-chaining
// and abort-safe for the same reason usePolling is: the next fetch is only
// scheduled once the previous one settles, so a hung/slow proxy can't stack
// concurrent requests. Two differences from usePolling: it threads a
// `?after=<cursor>` cursor between polls instead of re-fetching everything
// (mergeEventFeedWindow folds each response into a local rolling window —
// event-feed-window.ts), and it skips the fetch entirely while the tab is
// hidden — an open-but-backgrounded observatory tab is exactly the
// bandwidth waste this migration exists to fix.
export function useEventFeed() {
  const [events, setEvents] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const cursorRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    async function poll() {
      if (document.hidden) {
        if (!cancelled) timer = setTimeout(poll, POLL_MS);
        return;
      }
      try {
        const after = cursorRef.current;
        const query = after !== null ? `?after=${encodeURIComponent(after)}` : "";
        const res = await fetch(`/api/event-feed${query}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`/api/event-feed -> ${res.status}`);
        const feed = (await res.json()) as EventFeedResponse;
        if (!cancelled) {
          cursorRef.current = feed.cursor;
          setEvents((prev) => mergeEventFeedWindow(prev, feed));
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(poll, POLL_MS);
        }
      }
    }

    poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, []);

  return { events, error, loading };
}
