import { fetchEvents } from "@/lib/catalog-source";

// Same proxy shape as /api/subscriptions/route.ts — see that file's comment.
export async function GET(request: Request) {
  const events = await fetchEvents(request.signal);
  return Response.json(events);
}
