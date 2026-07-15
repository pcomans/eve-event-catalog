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

/**
 * Resolves a conversationId to its ConversationRecord, or null ONLY for
 * eve's own genuine "no conversation record exists yet" 404 — used by
 * decisions-view.tsx (task #35) to render the pre-launch empty state
 * instead of a raw error.
 *
 * p6k gate (LOW): a bare `res.status === 404 -> null` treated EVERY 404 as
 * that one healthy semantic — a wrong CATALOG_API_BASE_URL, a misrouted or
 * stale eve deployment with no /catalog/conversations route at all, or any
 * other platform/framework 404 would ALSO answer 404 and be silently
 * presented as "the campaign just hasn't started yet" instead of the real
 * infrastructure problem it is. eve's own route
 * (agent/channels/catalog.ts, GET /catalog/conversations/:conversationId)
 * has exactly one 404 body, quoted directly from its source:
 *   `Response.json({ error: "unknown conversationId" }, { status: 404 })`
 * Only a 404 whose body matches that EXACT machine-readable shape is
 * treated as "unknown conversation" -> null; any other 404 (a different
 * body, no body, non-JSON) becomes a thrown error instead, same as any
 * other non-2xx status already does below.
 */
export async function fetchConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<ConversationRecord | null> {
  const res = await fetch(`${CATALOG_BASE_URL}/catalog/conversations/${encodeURIComponent(conversationId)}`, {
    cache: "no-store",
    signal,
  });
  if (res.status === 404) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(`/catalog/conversations/${conversationId} -> 404 with a non-JSON body (not eve's own unknown-conversationId response)`);
    }
    // p6l gate (LOW): a `body.error === "unknown conversationId"` check
    // ALONE would still normalize a superset body — e.g.
    // `{ error: "unknown conversationId", detail: "misrouted/stale
    // handler" }` — to the same "healthy no-conversation" null, even
    // though that's not eve's own route response verbatim. Require the
    // EXACT one-field shape: a non-array object whose ONLY own key is
    // `error`, with exactly that string value.
    const isKnownUnknownConversationShape =
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      Object.keys(body).length === 1 &&
      (body as Record<string, unknown>).error === "unknown conversationId";
    if (!isKnownUnknownConversationShape) {
      throw new Error(
        `/catalog/conversations/${conversationId} -> 404 with an unrecognized body (not eve's own unknown-conversationId response): ${JSON.stringify(body)}`,
      );
    }
    return null;
  }
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
