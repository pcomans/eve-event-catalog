import { filterEventFeed } from "@/lib/filter-event-feed";
import { fetchEventFeed } from "@/lib/catalog-source";

// Cursor-polling companion to /api/events/route.ts — same test-fixture
// filter, but the upstream cursor and reset flag MUST pass through
// unchanged, even when every delta row gets filtered out below. The
// filter+envelope logic itself is the pure filterEventFeed (lib/
// filter-event-feed.ts, unit tested there) — this route is just the thin
// I/O wrapper around it.
export async function GET(request: Request) {
  const after = new URL(request.url).searchParams.get("after");
  const feed = await fetchEventFeed(after, request.signal);
  return Response.json(filterEventFeed(feed));
}
