import { CampaignView } from "@/components/campaign-view";
import { parseWireNumber } from "@/lib/parse-wire-number";

// This paper account's opening equity — the baseline computeRealizedPnl
// derives realized P&L from (see lib/portfolio-metrics.ts), read
// server-side and passed down rather than exposed as NEXT_PUBLIC_ (same
// "config, not a secret, but still server-resolved" precedent as
// CAMPAIGN_CONVERSATION_ID on the Decisions page).
const DEFAULT_INITIAL_EQUITY = 100_000;

function readInitialEquity(): number {
  // parseWireNumber, not parseFloat: "250000USD" must fall back to the
  // default (parseFloat would silently accept the numeric prefix), and a
  // non-finite result ("Infinity") must not slip through — both bypassed a
  // plain `Number.parseFloat(...) || DEFAULT_INITIAL_EQUITY` check, since
  // both parse to a truthy number. A parsed value also has to be a
  // sane positive figure to count as configured; anything else (unset,
  // "0", negative, garbage) falls back to the default.
  const parsed = parseWireNumber(process.env.CAMPAIGN_INITIAL_EQUITY ?? "");
  return parsed !== null && parsed > 0 ? parsed : DEFAULT_INITIAL_EQUITY;
}

export default function CampaignPage() {
  return <CampaignView initialEquity={readInitialEquity()} />;
}
