/** Honest, per-provider metadata so the model can pick a source for real reasons. */
export interface ProviderMetadata {
  freshness: string;
  latency: string;
  auth: string;
  cost: string;
  durability: string;
}

/** A hand-written JSON Schema (draft used by Ajv). Discovery documentation for the model AND the enforced validator. */
export type JsonSchema = Record<string, unknown>;

/**
 * A subscribable event type, declared in catalog/catalog.json (not code) so
 * the catalog stays a data file a non-engineer can read and edit.
 * `status: "planned"` means no provider is registered for it yet — it's
 * excluded from the boot honesty check and labeled as such in search
 * results, but the JSON entry (and its schema) still exists.
 */
export interface EventType {
  provider: string;
  event: string;
  status: "active" | "planned";
  /** Written for the model: what this event means and when it fires. */
  description: string;
  params: JsonSchema;
  tags: string[];
  metadata: ProviderMetadata;
}

/**
 * Lifecycle: pending (created mid-turn, not yet armed) -> armed (turn ended,
 * provider watching) -> delivering (wake in flight) -> fired | failed, or
 * armed -> expired if `expiresAt` passes first. Terminal states never
 * transition further.
 */
export type SubscriptionStatus =
  | "pending"
  | "armed"
  | "delivering"
  | "fired"
  | "expired"
  | "failed";

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
}

/** The stable envelope a woken session receives, folded into a channel message. */
export interface WakePayload {
  subscriptionId: string;
  provider: string;
  event: string;
  resource: string;
  snapshot?: Record<string, unknown>;
  firedAt: string;
  reason: "fired" | "expired";
}
