import { fetchConversation } from "@/lib/catalog-source";

// Same proxy shape as /api/subscriptions/route.ts — see that file's comment.
// Resolves a conversationId to its {sessionId}, the address the transcript
// stream proxy (/api/sessions/[sessionId]/stream) needs.
export async function GET(request: Request, { params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  const record = await fetchConversation(conversationId, request.signal);
  if (!record) return Response.json({ error: "unknown conversationId" }, { status: 404 });
  return Response.json(record);
}
