import { defineSchedule } from "eve/schedules";

import { isMarketWeekday } from "#catalog/market-day.ts";
import { CATALOG_BASE_URL } from "#catalog/wake.ts";

function log(line: string) {
  console.log(`[market-open] ${line}`);
}

// Opens each market day: wakes the standing campaign conversation with a
// "market's open, review and act" turn — the event catalog handles the
// intraday waking (price crossings, filings) on its own; this is the one
// thing nothing else triggers, since a quiet morning has no event to fire.
//
// Fires at 13:30 UTC (9:30am US/Eastern DAYLIGHT time — correct today). Does
// NOT shift for the DST boundary: in WINTER (US/Eastern STANDARD time,
// UTC-5), this same 13:30 UTC cron fires at 8:30 ET — an hour BEFORE the
// 9:30 open, waking the agent pre-open rather than late. Known, accepted gap
// at this project's scale (AGENTS.md rule 1); if it needs closing, the fix
// is either a second winter-specific cron at 14:30 UTC or a small DST/
// market-calendar check in the handler — neither exists yet. Also doesn't
// account for market holidays (isMarketWeekday's own comment covers that
// same call). The cron's own "1-5" day-of-week field already restricts
// this to weekdays; isMarketWeekday is a second, defense-in-depth check
// inside the handler, and doubles as the pure, unit-testable piece of this
// schedule (catalog/market-day.test.ts) — cron wiring itself only fires on
// Vercel (eve dev never runs schedules on their cadence; see eve's
// docs/schedules.mdx), so it's verified at rollout, not here.
//
// Deliberately does NOT use the schedule's `receive()` cross-channel
// handoff: that starts a session on ANOTHER channel, but continuing this
// SPECIFIC standing campaign conversation is exactly what POST /catalog/chat
// already does via its continuationToken (agent/channels/catalog.ts). This
// self-POSTs the same way catalog/wake.ts's deliverWake loops back into
// POST /catalog/wake — same base URL, same bearer-secret auth — so a schedule
// run is authenticated and turn-capped (catalog/turn-cap.ts) exactly like
// any other call into that route, with no separate mechanism to keep in sync.
//
// NOT THE OPERATIVE TRANSPORT IN PRODUCTION (verified 2026-07-14): on
// Vercel Services mode, this defineSchedule's auto-generated cron does not
// register — `vercel crons ls` shows only the top-level ensure-* supervisor
// entries from root vercel.json, and eve's own emitted `/eve/v1/cron/<hash>`
// route 404s from eve's own production router. Services mode appears to
// drop per-service build-output crons entirely; root-caused no further
// than that (eve's own transport here is opaque from outside the
// framework). The connector now owns this mechanism instead of chasing it:
// connector/routes/market-open-turn.get.ts ports this file's own `run()`
// body faithfully (same guards, same message, same base-URL resolution)
// behind requireCronSecret, wired via an explicit root vercel.json `crons`
// entry + rewrite — same "own the mechanism" pattern as the ensure-*
// supervisors right alongside it. THIS file is left in place, unchanged in
// behavior, for an eve-native (non-services) environment where its own
// cron DOES register; it is not currently what fires the 13:30 UTC
// campaign turn on the deployed system.
export default defineSchedule({
  cron: "30 13 * * 1-5",
  async run() {
    if (!isMarketWeekday(new Date())) {
      log("skipped — not a market weekday");
      return;
    }

    const conversationId = process.env.CAMPAIGN_CONVERSATION_ID;
    if (!conversationId) {
      log("skipped — CAMPAIGN_CONVERSATION_ID is unset, nothing to wake");
      return;
    }

    const res = await fetch(`${CATALOG_BASE_URL}/catalog/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.CATALOG_API_SECRET}`,
      },
      body: JSON.stringify({
        conversationId,
        message:
          "[market-open] The US market is open. Review your positions and watches, and act if you have a reason to.",
      }),
    });

    if (!res.ok) {
      log(`FAILED conv=${conversationId} status=${res.status} body=${await res.text()}`);
      return;
    }
    log(`OK conv=${conversationId}`);
  },
});
