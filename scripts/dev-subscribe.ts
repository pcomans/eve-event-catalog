// Dev-only helper for exercising the catalog lifecycle before task #4's
// alpaca provider exists to arm anything for real. Hand-inserts a "pending"
// subscription directly into the registry (bypassing catalog.subscribe(),
// the model/tools, AND the catalog's "planned" gate — deliberately, since
// this script's whole job is exercising pending -> armed -> expired
// wiring before any provider is registered), so a running dev server can be
// used to verify: pending -> armed on turn completion, and (with a short
// --expires-in) the expiry wake.
//
// Usage: node scripts/dev-subscribe.ts <conversationId> [expiresInSeconds]
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

const sub = await createSubscription({
  conversationId,
  provider: "alpaca",
  event: "price.crossesBelow",
  resource: "NVDA",
  params: { threshold: 1 }, // $1 is never crossed — exercises expiry, not a real fire
  expiresAt,
});

console.log(JSON.stringify(sub, null, 2));
