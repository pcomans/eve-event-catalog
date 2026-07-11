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
const CONV_KEY = (conversationId: string) => `catalog:conv:${conversationId}`;

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
}

export interface NewSubscriptionInput {
  conversationId: string;
  provider: string;
  event: string;
  resource: string;
  params: Record<string, unknown>;
  once: boolean;
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
    once: input.once,
    expiresAt: input.expiresAt,
    status: "pending",
    createdAt: new Date().toISOString(),
    armedAt: null,
    firedAt: null,
    lastError: null,
  };
  await writeSubscription(sub);
  return sub;
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

export async function listSubscriptions(): Promise<Subscription[]> {
  const ids = await redis.smembers(SUB_INDEX_KEY);
  if (ids.length === 0) return [];
  const subs = await Promise.all(ids.map((id) => redis.get<Subscription>(SUB_KEY(id))));
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
  const record: ConversationRecord = {
    conversationId,
    sessionId,
    startedAt: existing?.startedAt ?? new Date().toISOString(),
  };
  await redis.set(CONV_KEY(conversationId), record);
  return record;
}

export async function getConversation(conversationId: string): Promise<ConversationRecord | null> {
  return redis.get<ConversationRecord>(CONV_KEY(conversationId));
}
