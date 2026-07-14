import { fetchAlpacaAccount } from "@/lib/alpaca-source";
import { toAccountDto } from "@/lib/campaign-dto";

// Same proxy shape as /api/subscriptions/route.ts: the browser only ever
// calls same-origin /api/*, so ALPACA_API_KEY_ID/ALPACA_API_SECRET_KEY never
// reach the client — they're read server-side inside alpaca-source.ts only.
// toAccountDto whitelists the fields this page actually renders — Alpaca's
// raw /v2/account response also carries id, account_number, created_at, and
// other account-management data this public page has no business exposing.
export async function GET(request: Request) {
  const account = await fetchAlpacaAccount(request.signal);
  return Response.json(toAccountDto(account));
}
