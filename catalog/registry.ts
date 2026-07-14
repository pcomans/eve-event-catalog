import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";

import type { Subscription, SubscriptionStatus } from "./types.ts";

// Redis is the durable store for both the subscription registry and the
// conversation map. eve's dev server hot-reloads (and wipes in-process
// module state) on every .env.local write, and a laptop dev process can
// restart at any time — an in-memory Map would lose armed subscriptions and
// the conversationId -> sessionId link that wakes depend on. Redis (Upstash,
// via the Vercel Marketplace) survives both.
const redis = Redis.fromEnv();

const SUB_KEY = (id: string) => `catalog:sub:${id}`;
const SUB_INDEX_KEY = "catalog:subs";
// Phase 3's expiry migration (docs/plan-vercel-production.md): a Redis
// sorted set, score = expiresAt as epoch ms, member = subscription id — the
// durable side's own "which subscriptions are due" query
// (readDueExpirySubscriptionIds below), independent of any in-process timer.
// Dual-written inside writeSubscription (below) rather than requiring every
// caller to remember to index separately: any write that leaves a
// subscription "armed" with a non-null expiresAt adds/keeps it in the set;
// any write that doesn't (disarmed, terminal, or armed-with-no-expiry)
// removes it. This keeps the set an accurate, real-time reflection of
// "currently armed with this expiry" with no dedicated arm/disarm call
// sites to remember — wake.ts's own scheduleExpiry (the in-process timer,
// kept for local dev) needs ZERO code changes to also participate, since it
// already arms via updateSubscription like everything else.
const EXPIRY_INDEX_KEY = "catalog:expiry-index";
const CONV_KEY = (conversationId: string) => `catalog:conv:${conversationId}`;
// Reverse index: a tool's ctx.session.id is the eve sessionId, not the
// conversationId subscriptions are keyed by (eve's ToolContext exposes no
// continuationToken accessor — see getConversationBySessionId below).
const CONV_BY_SESSION_KEY = (sessionId: string) => `catalog:conv-by-session:${sessionId}`;

export interface ConversationRecord {
  conversationId: string;
  sessionId: string;
  startedAt: string;
}

// @upstash/redis serializes/deserializes JSON-compatible values automatically
// (see its README), so subscriptions and conversation records are stored as
// plain objects rather than hand-rolled JSON strings.
async function readSubscription(id: string): Promise<Subscription | null> {
  return redis.get<Subscription>(SUB_KEY(id));
}

async function writeSubscription(sub: Subscription): Promise<void> {
  await redis.set(SUB_KEY(sub.id), sub);
  await redis.sadd(SUB_INDEX_KEY, sub.id);
  if (sub.status === "armed" && sub.expiresAt) {
    await redis.zadd(EXPIRY_INDEX_KEY, { score: new Date(sub.expiresAt).getTime(), member: sub.id });
  } else {
    await redis.zrem(EXPIRY_INDEX_KEY, sub.id);
  }
}

/**
 * Every subscription id currently armed with `expiresAt <= nowMs` — the
 * durable expiry sweep's own read side (connector/workflows/expiry-sweep.ts).
 * A hit here means "was armed-with-this-expiry as of the last write," not a
 * guarantee the subscription is STILL armed at read time — a subscription
 * that fired/expired/failed moments earlier can still appear until its own
 * terminal write clears the index entry (same "diffing aid, not a delivery
 * lock" tolerance as edgar-redis.ts's seen-set: the real safety net is
 * registry.ts's own tryTransitionToDelivering CAS, which safely no-ops a
 * caller trying to expire an already-terminal subscription).
 */
export async function readDueExpirySubscriptionIds(nowMs: number): Promise<string[]> {
  return redis.zrange<string[]>(EXPIRY_INDEX_KEY, "-inf", nowMs, { byScore: true });
}

export interface NewSubscriptionInput {
  conversationId: string;
  provider: string;
  event: string;
  resource: string;
  params: Record<string, unknown>;
  expiresAt: string | null;
}

export async function createSubscription(input: NewSubscriptionInput): Promise<Subscription> {
  const sub: Subscription = {
    id: randomUUID(),
    conversationId: input.conversationId,
    provider: input.provider,
    event: input.event,
    resource: input.resource,
    params: input.params,
    expiresAt: input.expiresAt,
    status: "pending",
    createdAt: new Date().toISOString(),
    armedAt: null,
    firedAt: null,
    lastError: null,
    deliverReason: null,
    deliverSnapshot: null,
  };
  await writeSubscription(sub);
  return sub;
}

/** Test-hygiene helper: removes a subscription and its index entries. Not used by product code. */
export async function deleteSubscription(id: string): Promise<void> {
  await redis.del(SUB_KEY(id));
  await redis.srem(SUB_INDEX_KEY, id);
  await redis.zrem(EXPIRY_INDEX_KEY, id);
}

/** Test-hygiene helper: removes a conversation record and its reverse sessionId index. Not used by product code. */
export async function deleteConversation(conversationId: string): Promise<void> {
  const existing = await getConversation(conversationId);
  await redis.del(CONV_KEY(conversationId));
  if (existing) await redis.del(CONV_BY_SESSION_KEY(existing.sessionId));
}

export async function getSubscription(id: string): Promise<Subscription | null> {
  return readSubscription(id);
}

/** Merges a patch onto the stored subscription and persists the result. */
export async function updateSubscription(
  id: string,
  patch: Partial<Omit<Subscription, "id" | "conversationId">>,
): Promise<Subscription> {
  const current = await readSubscription(id);
  if (!current) throw new Error(`unknown subscription: ${id}`);
  const updated: Subscription = { ...current, ...patch };
  await writeSubscription(updated);
  return updated;
}

// updateSubscription's read-then-write is NOT atomic — fine for most patches
// (single writer per field in practice), but wrong for the armed/pending ->
// delivering step: two callers racing on the same subscription (e.g. an
// expiry timer and a provider tick) could both read a pre-transition
// snapshot, and a delayed second write built from that stale read can
// regress an already-terminal status back to "delivering", or silently
// replace the deliverReason the first caller already established.
//
// tryTransitionToDelivering makes "is this still transitionable?" and
// "transition it" atomic via raw-string compare-and-swap, NOT by decoding
// and mutating the record inside Lua (an earlier version did that; see git
// history) — Lua's cjson has two independent, confirmed-live corruption
// modes on Upstash's actual sandbox that a decode/mutate/encode round trip
// can't avoid: it decodes `{}` and `[]` to the identical empty table and
// re-encodes an empty table as a JSON array (silently turning an empty
// params/deliverSnapshot object into `[]`), and `cjson.null` isn't a real
// sentinel there (assigning it to a table field deletes the key, same as
// nil), which previously needed a string-marker workaround that itself
// corrupted any real data value equal to the marker token. CAS sidesteps
// cjson for the data entirely: the guard checks and the new record are
// built in plain TypeScript (where `{}` and `null` behave exactly as
// expected), and the Lua script's only job is a byte-exact string swap.
//
// This needs the RAW stored string (not the parsed object) for two things:
// the CAS comparison must match byte-for-byte, and re-serializing a parsed
// object would risk key-order/whitespace drift that could make an
// unconditionally-correct write look like a CAS mismatch. `rawRedis` is a
// second client instance (same credentials, `automaticDeserialization:
// false`) purely so `.get()` returns the exact stored string instead of an
// auto-parsed object.
const rawRedis = Redis.fromEnv({ automaticDeserialization: false });

const TERMINAL_STATUSES_FOR_TRANSITION = new Set<SubscriptionStatus>(["fired", "expired", "failed"]);

// `if GET == ARGV[1] then SET ARGV[2] end` — the entire atomicity guarantee.
// No cjson, no data touches Lua at all; ARGV[1]/ARGV[2] are opaque strings.
const CAS_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("SET", KEYS[1], ARGV[2])
  return 1
else
  return 0
end
`;

/**
 * Atomically transitions a subscription to "delivering", establishing
 * `deliverReason`/`deliverSnapshot` — but only if it isn't already terminal
 * and no earlier caller has already established a deliverReason. Returns
 * the updated subscription if THIS call won the transition, or `null` if it
 * lost (already terminal, or another caller already claimed the delivering
 * intent first) — see the module comment above for why a plain
 * updateSubscription() read-then-write isn't safe for this specific step.
 *
 * Reads raw, checks the guards in TS, builds the new record in TS, then
 * swaps with a CAS keyed on the exact raw string just read. A CAS miss
 * means someone else wrote the record between our read and our swap — the
 * guards are re-checked against a fresh read (bounded to a few retries;
 * realistic contention here is 2-3 callers at worst, never more).
 */
export async function tryTransitionToDelivering(
  id: string,
  reason: "fired" | "expired",
  snapshot: Record<string, unknown> | null,
): Promise<Subscription | null> {
  const key = SUB_KEY(id);
  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const raw = await rawRedis.get<string>(key);
    if (raw === null) return null; // subscription doesn't exist

    const current = JSON.parse(raw) as Subscription;
    if (TERMINAL_STATUSES_FOR_TRANSITION.has(current.status)) return null;
    if (current.status === "delivering" && current.deliverReason) return null;

    const updated: Subscription = {
      ...current,
      status: "delivering",
      deliverReason: reason,
      deliverSnapshot: snapshot,
    };
    const newRaw = JSON.stringify(updated);

    const swapped = await redis.eval<[string, string], number>(CAS_SCRIPT, [key], [raw, newRaw]);
    if (swapped === 1) return updated;
    // CAS miss: retry with a fresh read — falls through to the next iteration.
  }

  return null; // exhausted retries under real contention; treat as lost, same as any other race loss
}

/**
 * Batched read of multiple subscriptions by id — one MGET, not one GET per
 * id (task #33, Redis command-burn reduction). Order-preserving: result[i]
 * corresponds to ids[i], `null` for an id with no record (same per-key
 * semantics a bare `redis.get` has for a missing key). Empty input
 * short-circuits without a Redis call — MGET with zero keys is a
 * wire-protocol error, not just a harmless no-op.
 */
export async function getSubscriptions(ids: string[]): Promise<(Subscription | null)[]> {
  if (ids.length === 0) return [];
  return redis.mget<(Subscription | null)[]>(ids.map(SUB_KEY));
}

// Used to be smembers + one GET per id (N+1 round trips — the dominant cost
// behind the 768k-read quota hit). Now smembers + one MGET via
// getSubscriptions above.
export async function listSubscriptions(): Promise<Subscription[]> {
  const ids = await redis.smembers(SUB_INDEX_KEY);
  if (ids.length === 0) return [];
  const subs = await getSubscriptions(ids);
  return subs.filter((sub): sub is Subscription => sub !== null);
}

export async function listSubscriptionsByStatus(
  conversationId: string,
  status: SubscriptionStatus,
): Promise<Subscription[]> {
  const all = await listSubscriptions();
  return all.filter((sub) => sub.conversationId === conversationId && sub.status === status);
}

/**
 * Records that `conversationId` maps to `sessionId`, the wake address for
 * /catalog/wake. Preserves the original `startedAt` if the conversation was
 * already recorded (e.g. a repeated /catalog/chat call for the same id).
 */
export async function recordConversation(
  conversationId: string,
  sessionId: string,
): Promise<ConversationRecord> {
  const existing = await getConversation(conversationId);
  // A resumed conversation can move to a new eve sessionId (e.g. after a
  // hot-reload orphans the old one). Drop the old sessionId's reverse-index
  // entry so it doesn't keep resolving to this conversation's now-current
  // (and by then mismatched) record.
  if (existing && existing.sessionId !== sessionId) {
    await redis.del(CONV_BY_SESSION_KEY(existing.sessionId));
  }
  const record: ConversationRecord = {
    conversationId,
    sessionId,
    startedAt: existing?.startedAt ?? new Date().toISOString(),
  };
  await redis.set(CONV_KEY(conversationId), record);
  await redis.set(CONV_BY_SESSION_KEY(sessionId), conversationId);
  return record;
}

export async function getConversation(conversationId: string): Promise<ConversationRecord | null> {
  return redis.get<ConversationRecord>(CONV_KEY(conversationId));
}

/**
 * Recovers the conversation record from an eve sessionId (ctx.session.id in
 * a tool), the only session handle authored tool code receives. Subscriptions
 * are keyed by conversationId, so a tool that wants to call catalog.subscribe
 * goes through this reverse index rather than threading conversationId
 * through some other channel.
 */
export async function getConversationBySessionId(
  sessionId: string,
): Promise<ConversationRecord | null> {
  const conversationId = await redis.get<string>(CONV_BY_SESSION_KEY(sessionId));
  if (!conversationId) return null;
  return getConversation(conversationId);
}
