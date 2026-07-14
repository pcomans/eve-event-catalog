import type { ConversationRecord, HistoryEntry, Subscription } from "./catalog-types.ts";

// Server-only: the eve app's base URL for its public, unauthenticated GETs
// (GET /catalog/subscriptions, GET /catalog/events). Not a secret — it's
// just an address — so NEXT_PUBLIC_ isn't needed; the browser never calls
// this URL directly, only our own /api/* route handlers do (see the
// "why a proxy" note in app/api/subscriptions/route.ts).
const CATALOG_BASE_URL = process.env.CATALOG_API_BASE_URL ?? "http://localhost:2000";

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${CATALOG_BASE_URL}${path}`, { cache: "no-store", signal });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export function fetchSubscriptions(signal?: AbortSignal) {
  return getJson<Subscription[]>("/catalog/subscriptions", signal);
}

export function fetchEvents(signal?: AbortSignal) {
  return getJson<HistoryEntry[]>("/catalog/events", signal);
}

/** Resolves a conversationId to its ConversationRecord, or null on a 404 (unknown conversationId). */
export async function fetchConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<ConversationRecord | null> {
  const res = await fetch(`${CATALOG_BASE_URL}/catalog/conversations/${encodeURIComponent(conversationId)}`, {
    cache: "no-store",
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/catalog/conversations/${conversationId} -> ${res.status}`);
  return res.json() as Promise<ConversationRecord>;
}

/**
 * Raw pass-through fetch of a session's durable event stream — NOT JSON, so
 * this doesn't go through getJson. The stream never closes on its own for a
 * live/parked session (it stays open for future turns), so this only awaits
 * the response headers, never the body; the caller streams the body through
 * unread, same as the eve app's own observe page does against this same
 * upstream route.
 */
export function fetchSessionStream(sessionId: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${CATALOG_BASE_URL}/catalog/sessions/${encodeURIComponent(sessionId)}/stream`, { signal });
}
