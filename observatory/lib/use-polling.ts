"use client";

import { useEffect, useState } from "react";

const DEFAULT_POLL_MS = 2000;

// Self-chaining poll, not a fixed setInterval: the next fetch is only
// scheduled once the previous one settles (success or failure), so a
// hung/slow proxy or eve upstream can never stack concurrent requests or
// let a late response overwrite newer data. Unmount aborts whatever fetch
// is in flight via the shared AbortController instead of only suppressing
// its eventual state update — the /api/* route handlers forward this
// request's signal into their own eve fetch (lib/catalog-source.ts), so the
// abort propagates through the proxy and cancels the proxy-to-eve request
// too, not just the browser-to-proxy leg.
export function usePolling<T>(path: string, initial: T, intervalMs: number = DEFAULT_POLL_MS) {
  const [data, setData] = useState<T>(initial);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    async function poll() {
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
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(poll, intervalMs);
        }
      }
    }

    poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [path, intervalMs]);

  return { data, error, loading };
}
