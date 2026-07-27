// Mirrors the shapes the eve app's public, read-only GETs already return
// (catalog/types.ts's Subscription, catalog/history.ts's HistoryEntry) —
// the observatory is a separate pnpm package with no import path into the
// main app's catalog/ module, so these are hand-kept in sync rather than
// shared. Both source interfaces are small and change rarely; if that stops
// being true, promoting catalog/types.ts into a shared workspace package is
// the fix, not duplicating harder.

export type SubscriptionStatus = "pending" | "armed" | "delivering" | "fired" | "expired" | "failed";

export interface Subscription {
  id: string;
  conversationId: string;
  provider: string;
  event: string;
  resource: string;
  params: Record<string, unknown>;
  expiresAt: string | null;
  status: SubscriptionStatus;
  createdAt: string;
  armedAt: string | null;
  firedAt: string | null;
  lastError: string | null;
  // Crash-recovery state: the terminal transition a "delivering" subscription
  // is mid-way through, and its matching snapshot. Neither page renders
  // these; kept for completeness so this mirror doesn't silently drop fields
  // a future consumer might reasonably expect to be here.
  deliverReason: "fired" | "expired" | null;
  deliverSnapshot: Record<string, unknown> | null;
}

export interface HistoryEntry {
  // Per-occurrence identifier (crypto.randomUUID(), minted by recordEvent on
  // every write) — see catalog/history.ts's own HistoryEntry.id comment for
  // why this exists (a true per-occurrence content-hash cursor) and the
  // accepted duplicate-retry semantics it deliberately leaves in place.
  id: string;
  action: string;
  timestamp: string;
  subscriptionId: string;
  conversationId: string;
  provider: string;
  event: string;
  status: string;
  [key: string]: unknown;
}

// Mirrors catalog/event-feed.ts's EventFeedResponse — the cursor-polling
// wire shape for GET /catalog/event-feed and its proxy, GET /api/event-feed.
export interface EventFeedResponse {
  cursor: string | null;
  reset: boolean;
  events: HistoryEntry[];
}

// Mirrors catalog/registry.ts's ConversationRecord (the conversationId ->
// sessionId link GET /catalog/conversations/:conversationId returns).
export interface ConversationRecord {
  conversationId: string;
  sessionId: string;
  startedAt: string;
}
