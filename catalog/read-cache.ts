// Task #33 (Redis command-burn reduction, quota postmortem): a single-slot,
// TTL-bounded in-process cache for a public GET route polled every ~2s by N
// concurrent viewers (observatory pages, catalog/observe-page.ts) — without
// this, N viewers cost N upstream reads every poll tick; with it, N viewers
// inside the same TTL window share ONE. Deliberately dead simple: no locks,
// no stampede guard. Two requests landing in the narrow gap between "cache
// found stale" and "cache overwritten" can both call `fetchFresh` — both
// write the same-shaped result, so this is harmless, and a dashboard
// tolerating up to `ttlMs` of staleness already accepts data this fresh-ish
// by design (client polling cadence is untouched by this file).
export function createCachedReader<T>(
  fetchFresh: () => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now,
): () => Promise<T> {
  let cached: { data: T; fetchedAt: number } | null = null;

  return async function read(): Promise<T> {
    if (cached && now() - cached.fetchedAt < ttlMs) return cached.data;
    const data = await fetchFresh();
    cached = { data, fetchedAt: now() };
    return data;
  };
}
