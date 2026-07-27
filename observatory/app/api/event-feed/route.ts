import { isTestFixtureConversationId } from "@/lib/is-test-fixture-conversation";
import { fetchEventFeed } from "@/lib/catalog-source";

// Cursor-polling companion to /api/events/route.ts — same test-fixture
// filter, but the upstream cursor and reset flag MUST pass through
// unchanged, even when every delta row gets filtered out below. The cursor
// is what lets the browser stop re-requesting rows it's already seen; if a
// filtered-to-empty response also reset the cursor, the client would never
// advance past those rows and would re-fetch them forever.
export async function GET(request: Request) {
  const after = new URL(request.url).searchParams.get("after");
  const feed = await fetchEventFeed(after, request.signal);
  const events = feed.events.filter((event) => !isTestFixtureConversationId(event.conversationId));
  return Response.json({ ...feed, events });
}
