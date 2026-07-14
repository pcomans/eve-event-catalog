import { fetchSubscriptions } from "@/lib/catalog-source";

// Thin server-side proxy to the eve app's GET /catalog/subscriptions: the
// browser only ever calls same-origin /api/*, so this page never depends on
// the eve app sending CORS headers for a third-party origin, and never
// needs Redis credentials in this workspace at all — see the M1 report for
// the direct-Redis alternative this was chosen over.
export async function GET(request: Request) {
  const subscriptions = await fetchSubscriptions(request.signal);
  return Response.json(subscriptions);
}
