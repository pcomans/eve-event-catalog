import { isTestFixtureConversationId } from "@/lib/is-test-fixture-conversation";
import { fetchEvents } from "@/lib/catalog-source";

// Same proxy shape as /api/subscriptions/route.ts — see that file's comment,
// including the task #36 test-fixture filter.
export async function GET(request: Request) {
  const events = await fetchEvents(request.signal);
  const curated = events.filter((event) => !isTestFixtureConversationId(event.conversationId));
  return Response.json(curated);
}
