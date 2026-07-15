import { createError, defineEventHandler } from "nitro/h3";

import { requireCronSecret } from "../lib/auth.ts";
import { resolveMarketOpenBaseUrl, runMarketOpenTurn } from "../lib/market-open-turn.ts";

// Owns the market-open transport that agent/schedules/market-open.ts's
// `defineSchedule` cron was SUPPOSED to provide — verified in production
// 2026-07-14 that it doesn't: `vercel crons ls` shows only the four
// top-level ensure-* supervisor entries, and eve's own `/eve/v1/cron/<hash>`
// route 404s from eve's own router. Services mode appears to drop
// per-service build-output crons entirely (this file's own existence is
// the fix, not a workaround pending eve support — same "own the mechanism"
// pattern as the ensure-* supervisors alongside it, wired the SAME way:
// requireCronSecret + a root vercel.json top-level `crons` entry +
// (`/market-open-turn` -> connector) explicit rewrite).
//
// This route is deliberately thin: the actual guard logic (weekday skip,
// unset-CAMPAIGN_CONVERSATION_ID skip) and the POST /catalog/chat itself
// live in lib/market-open-turn.ts's runMarketOpenTurn — ported faithfully
// from agent/schedules/market-open.ts's own `run()` body (same message
// string, same CATALOG_API_SECRET bearer). Base URL: resolveMarketOpenBaseUrl
// (lib/market-open-turn.ts) — same fallback shape as connector/lib/
// deliver-wake.ts's own CATALOG_BASE_URL every other self-POST into eve
// uses, plus a fail-loud check scoped to this route only (see that
// function's own doc comment for why it isn't in the shared constant).
// That schedule file stays in place for an eve-native (non-services)
// environment where its own cron DOES register; see its own comment for
// the production finding.
//
// p6f gate finding (MED): a failed /catalog/chat POST used to return here
// as a normal 200 with `{status: "failed"}` in the body — Vercel's cron
// dashboard would record SUCCESS while the campaign turn silently never
// happened, the exact silent-death class this whole project hunts. The
// ensure-* supervisors all throw on an operational failure (their own
// route's own defineEventHandler catches it into a non-2xx); this route
// now matches that convention instead of being the one exception.
export default defineEventHandler(async (event) => {
  requireCronSecret(event);
  const baseUrl = resolveMarketOpenBaseUrl(process.env);
  const result = await runMarketOpenTurn(new Date(), process.env, baseUrl);

  if (result.status === "failed") {
    throw createError({
      statusCode: 502,
      statusMessage: `market-open-turn: upstream /catalog/chat POST failed with status ${result.httpStatus}`,
    });
  }

  return result;
});
