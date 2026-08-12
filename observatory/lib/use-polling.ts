"use client";

import { useEffect, useState } from "react";

import { startPollLoop } from "./poll-loop.ts";

const DEFAULT_POLL_MS = 2000;

// Re-fetches `path` on the shared poll loop (poll-loop.ts): one request at a
// time, and nothing at all — not even a timer — while the tab is hidden.
// Unmount aborts whatever fetch is in flight via the shared AbortController
// instead of only suppressing its eventual state update — the /api/* route
// handlers forward this request's signal into their own eve fetch
// (lib/catalog-source.ts), so the abort propagates through the proxy and
// cancels the proxy-to-eve request too, not just the browser-to-proxy leg.
export function usePolling<T>(path: string, initial: T, intervalMs: number = DEFAULT_POLL_MS) {
  const [data, setData] = useState<T>(initial);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const stop = startPollLoop(async () => {
      try {
        const res = await fetch(path, { signal: controller.signal });
        if (!res.ok) throw new Error(`${path} -> ${res.status}`);
        const json = (await res.json()) as T;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, intervalMs);

    return () => {
      cancelled = true;
      controller.abort();
      stop();
    };
  }, [path, intervalMs]);

  return { data, error, loading };
}
