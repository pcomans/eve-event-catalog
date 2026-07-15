import { isMarketWeekday } from "../../catalog/market-day.ts";

function log(line: string): void {
  console.log(`[market-open-turn] ${line}`);
}

export interface MarketOpenTurnEnv {
  CAMPAIGN_CONVERSATION_ID?: string;
  CATALOG_API_SECRET?: string;
}

export type MarketOpenTurnResult =
  | { status: "skipped-not-market-weekday" }
  | { status: "skipped-no-conversation-id" }
  | { status: "ok"; conversationId: string }
  | { status: "failed"; httpStatus: number };

/**
 * p6f gate finding (INFO, taken): resolves eve's base URL for THIS route's
 * own self-POST — same fallback shape as connector/lib/deliver-wake.ts's
 * own CATALOG_BASE_URL (duplicated per-module, same convention as
 * WATCHER_HOST/FEED elsewhere in this codebase — KNOWN_ISSUES #2), with
 * one addition scoped ONLY to this route: a silent localhost fallback in a
 * genuinely DEPLOYED context (the `VERCEL` env marker Vercel injects into
 * every deployed function) would mean CATALOG_BASE_URL going missing from
 * the provisioned env 404s every market-open turn into the void instead of
 * failing loudly — the exact silent-death class this whole task exists to
 * close. Deliberately NOT added to deliver-wake.ts's own shared constant,
 * which every OTHER delivery leg (price crossings, EDGAR, expiry,
 * recovery) already depends on and is already running successfully in
 * production — scoping this to the new route only avoids blast radius on
 * legs this task didn't touch. Called lazily, inside the route handler
 * (never at module load), so an unset CATALOG_BASE_URL in a deployed
 * context can never crash an unrelated bundle just by being imported —
 * same reasoning as alpaca-client.ts's own lazy Alpaca client Proxy.
 */
export function resolveMarketOpenBaseUrl(env: NodeJS.ProcessEnv): string {
  if (env.CATALOG_BASE_URL) return env.CATALOG_BASE_URL;
  if (env.VERCEL) {
    throw new Error(
      "CATALOG_BASE_URL is unset in a deployed (VERCEL) context — refusing to silently fall back to " +
        "http://localhost, which would 404 the market-open turn POST into the void instead of failing loudly.",
    );
  }
  return `http://localhost:${env.PORT ?? 2000}`;
}

// The testable core of routes/market-open-turn.get.ts — ported faithfully
// from agent/schedules/market-open.ts's own `run()` body (see that file's
// own comment for why this transport exists at all: eve's defineSchedule
// cron does not register on Vercel Services mode, verified in production
// 2026-07-14). Parameterized by `now`/`env`/`fetchImpl` rather than reading
// `new Date()`/`process.env`/global `fetch` directly, so the route's guard
// logic (weekday skip, unset-conversation-id skip) is deterministically
// testable without a real clock, real env, or a real network call — the
// route itself (requireCronSecret + wiring this to the real values) is the
// thin, untested wrapper, same split this codebase already uses elsewhere
// (catalog/providers/*.ts pure cores vs. thin route/channel callers).
export async function runMarketOpenTurn(
  now: Date,
  env: MarketOpenTurnEnv,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MarketOpenTurnResult> {
  if (!isMarketWeekday(now)) {
    log("skipped — not a market weekday");
    return { status: "skipped-not-market-weekday" };
  }

  const conversationId = env.CAMPAIGN_CONVERSATION_ID;
  if (!conversationId) {
    log("skipped — CAMPAIGN_CONVERSATION_ID is unset, nothing to wake");
    return { status: "skipped-no-conversation-id" };
  }

  const res = await fetchImpl(`${baseUrl}/catalog/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.CATALOG_API_SECRET}`,
    },
    body: JSON.stringify({
      conversationId,
      // Byte-identical to agent/schedules/market-open.ts's own message —
      // deliberately, so the campaign conversation sees the same prompt
      // regardless of which transport actually fired.
      message:
        "[market-open] The US market is open. Review your positions and watches, and act if you have a reason to.",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    log(`FAILED conv=${conversationId} status=${res.status} body=${body}`);
    return { status: "failed", httpStatus: res.status };
  }

  log(`OK conv=${conversationId}`);
  return { status: "ok", conversationId };
}
