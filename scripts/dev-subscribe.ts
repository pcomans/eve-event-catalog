// Dev-only helper for exercising the catalog lifecycle, and (now that task
// #4's alpaca provider exists) for driving a real arm against it too.
// Hand-inserts a "pending" subscription directly into the registry
// (bypassing catalog.subscribe(), the model/tools, AND the catalog's
// "planned" gate — deliberately, since this script's whole job is
// exercising pending -> armed -> {fired,expired} wiring without going
// through a chat turn), so a running dev server can be used to verify:
// pending -> armed on turn completion, and (with a short --expires-in) the
// expiry wake, or a real provider fire when EVENT/RESOURCE/THRESHOLD target
// something that will actually cross.
//
// Usage: node scripts/dev-subscribe.ts <conversationId> [expiresInSeconds]
// Optional env overrides (defaults reproduce the original NVDA/never-crosses
// behavior above): EVENT=price.crossesBelow|price.crossesAbove RESOURCE=NVDA
// THRESHOLD=1
import { createSubscription } from "../catalog/registry.ts";

const [conversationId, expiresInSecondsArg] = process.argv.slice(2);

if (!conversationId) {
  console.error("Usage: node scripts/dev-subscribe.ts <conversationId> [expiresInSeconds]");
  process.exit(1);
}

const expiresInSeconds = expiresInSecondsArg ? Number(expiresInSecondsArg) : undefined;
const expiresAt = expiresInSeconds
  ? new Date(Date.now() + expiresInSeconds * 1000).toISOString()
  : null;

const event = process.env.EVENT ?? "price.crossesBelow";
const resource = process.env.RESOURCE ?? "NVDA";
// $1 is never crossed by default — exercises expiry, not a real fire.
const threshold = process.env.THRESHOLD ? Number(process.env.THRESHOLD) : 1;

const sub = await createSubscription({
  conversationId,
  provider: "alpaca",
  event,
  resource,
  params: { threshold },
  expiresAt,
});

console.log(JSON.stringify(sub, null, 2));
