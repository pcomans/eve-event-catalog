import { createError, getHeader, type H3Event } from "nitro/h3";

import { isAuthorizedHeader } from "../../catalog/auth.ts";

/**
 * Fail-closed bearer-secret gate for every connector route (lead decision,
 * 2026-07-14, docs/plan-vercel-production.md's routing note): Vercel's own
 * CRON_SECRET convention (vercel.com/docs/cron-jobs/manage-cron-jobs) —
 * once CRON_SECRET is set as a project env var, Vercel automatically sends
 * it as `Authorization: Bearer $CRON_SECRET` on every route registered as a
 * Cron in the root vercel.json's own `crons` array; every other route here
 * (manual triggers, smoke tests) gets no such automatic header, so reaching
 * them requires a caller to supply the same header by hand. Deliberately
 * phrased by MECHANISM, not by a route count — vercel.json's own `crons`
 * array and this directory's own route list are each a growing, separately-
 * maintained source of truth; a hardcoded total here would just go stale
 * again the next time either one changes. One shared secret
 * for the whole service (not a second one alongside eve's own
 * CATALOG_API_SECRET) — reuses catalog/auth.ts's isAuthorizedHeader for the
 * actual comparison rather than re-implementing it.
 *
 * Throws an H3 error rather than returning a sentinel: every route here is
 * a thin `defineEventHandler` wrapper with no shared middleware layer (see
 * this repo's own KNOWN_ISSUES.md #13 on Nitro's directory-scanning
 * surprises — an auto-applied middleware convention wasn't trusted for a
 * security-relevant gate), so each route calls this first and lets
 * defineEventHandler's own error handling turn the throw into the response.
 * 503 if CRON_SECRET itself isn't configured (a deploy mistake, not a
 * caller's fault) vs 401 for a present-but-wrong/missing header (an actual
 * unauthorized caller) — distinguished on purpose so a misconfigured deploy
 * doesn't read as "someone's guessing wrong."
 */
export function requireCronSecret(event: H3Event): void {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    throw createError({ statusCode: 503, statusMessage: "CRON_SECRET not configured" });
  }
  if (!isAuthorizedHeader(getHeader(event, "authorization") ?? null, secret)) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }
}
