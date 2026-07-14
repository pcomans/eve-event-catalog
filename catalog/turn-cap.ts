import { Redis } from "@upstash/redis";

// Pure runaway/loop protection (AGENTS.md rule 1; plan Phase 4, "Campaign
// guardrails — minimal") — NOT a cost cap, deliberately small and
// env-configurable, no other guardrail layered on top (no notional caps, no
// max-trades — see docs/plan-vercel-production.md lines 214-222, DECIDED).
// A per-UTC-day ceiling on turns started, shared across both places a turn
// begins: POST /catalog/chat and POST /catalog/wake (agent/channels/
// catalog.ts). Counting lives here, in catalog/, rather than in the channel
// file itself, so the decision logic is independently testable — see
// turn-cap.test.ts.
const redis = Redis.fromEnv();

// The narrow slice of the Redis client incrementAndCheckTurnCap actually
// uses — a DI seam so turn-cap.test.ts can inject a client that throws,
// proving the fail-open policy below without needing to knock over the
// real (shared, live-campaign) Redis instance to test it.
interface TurnCapRedisClient {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number | boolean>;
}

const DEFAULT_MAX_TURNS_PER_DAY = 200;
// Comfortably outlives the UTC day a counter key is for, so a day's key
// self-expires instead of accumulating forever — no separate cleanup job.
const KEY_TTL_SECONDS = 2 * 24 * 60 * 60;

function turnCountKey(utcDate: string, scope: string): string {
  return `${scope}:turns:${utcDate}`;
}

/** YYYY-MM-DD in UTC — the day boundary the cap resets on. Pure. */
export function utcDateString(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Reads MAX_TURNS_PER_DAY from env, falling back to a sane default when
 * unset or not a positive number. Pure — env is passed in so this is
 * testable without touching process.env.
 */
export function readMaxTurnsPerDay(env: Record<string, string | undefined> = process.env): number {
  const raw = env.MAX_TURNS_PER_DAY;
  if (!raw) return DEFAULT_MAX_TURNS_PER_DAY;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TURNS_PER_DAY;
}

/** The entire cap decision, isolated so it's testable without Redis. Pure. */
export function isWithinTurnCap(count: number, limit: number): boolean {
  return count <= limit;
}

export interface TurnCapResult {
  allowed: boolean;
  count: number;
  limit: number;
  /**
   * Set only when the cap STORE itself failed and this result is the
   * fail-open fallback below — `count` is not a real count in that case
   * (there is no real count; the store never answered). Never set on the
   * normal path, so existing equality checks against
   * `{allowed, count, limit}` are unaffected.
   */
  degraded?: true;
}

/**
 * Atomically increments today's (UTC) turn counter and reports whether this
 * turn is still within the daily cap. Call this BEFORE starting a turn
 * (send()) at a catalog entry point — a turn that would exceed the cap must
 * never reach send() at all, so the counter doubles as "turns actually
 * started today," not "turns attempted."
 *
 * `scope`/`limit`/`redisClient` are test seams (default "catalog" /
 * env-configured / the real Upstash client) — see turn-cap.test.ts, which
 * uses a randomly-scoped key so tests never touch the real "catalog" counter
 * a live campaign is counting against.
 *
 * FAIL-OPEN POLICY (lead decision, p4b fix round, 2026-07-13 — deliberate,
 * not an oversight; Philipp decided the minimal-guardrails posture this
 * lives within, the fail-open failure mode itself was the lead's triage
 * call): if the cap store itself errors (INCR/EXPIRE both live
 * inside this one try), the turn is allowed to proceed anyway, loudly
 * logged. This cap is runaway PROTECTION, not correctness — the delivery
 * machinery it protects (catalog/wake.ts, the recovery sweep) already fails
 * visibly on its own if Redis is genuinely down, so a cap-store blip must
 * never silently block every turn and stop the campaign. The accepted cost
 * is an unbounded runaway window for the duration of the outage; that
 * trade — campaign continuity over loop protection — is intentional.
 */
export async function incrementAndCheckTurnCap(
  options: { now?: Date; scope?: string; limit?: number; redisClient?: TurnCapRedisClient } = {},
): Promise<TurnCapResult> {
  const now = options.now ?? new Date();
  const scope = options.scope ?? "catalog";
  const key = turnCountKey(utcDateString(now), scope);
  const client = options.redisClient ?? redis;
  const limit = options.limit ?? readMaxTurnsPerDay();

  try {
    const count = await client.incr(key);
    // Unconditional, not gated on count === 1: a crash (or an exhausted
    // retry) between an earlier call's INCR and ITS expire would otherwise
    // leave the key TTL-less forever, since every later call sees count > 1
    // and used to skip expire entirely. Re-asserting the TTL on every call
    // is idempotent and self-repairing — at most MAX_TURNS_PER_DAY extra
    // round trips/day, keeping the "this key always self-expires" contract
    // actually true rather than true-only-when-nothing-crashed.
    await client.expire(key, KEY_TTL_SECONDS);
    return { allowed: isWithinTurnCap(count, limit), count, limit };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[turn-cap] cap check failed (${message}) — failing OPEN, turn proceeds`);
    return { allowed: true, count: -1, limit, degraded: true };
  }
}
