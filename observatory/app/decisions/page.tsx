import { DecisionsView } from "@/components/decisions-view";

// campaign-5 is the one live campaign this observatory watches by default —
// resolved server-side (env var, then ?conversation= override, then this
// fallback) rather than a picker, because there's exactly one running
// campaign day-to-day and this page has no composer to start another.
const DEFAULT_CONVERSATION_ID = "campaign-5";

export default async function DecisionsPage({
  searchParams,
}: {
  searchParams: Promise<{ conversation?: string | string[] }>;
}) {
  const params = await searchParams;
  // Next 16's searchParams type allows string[] for a repeated query key
  // (?conversation=a&conversation=b) — take the first value rather than
  // let it flow through as "a,b" and fail every conversationId match.
  const conversationParam = Array.isArray(params.conversation) ? params.conversation[0] : params.conversation;
  const conversationId = conversationParam || process.env.CAMPAIGN_CONVERSATION_ID || DEFAULT_CONVERSATION_ID;

  // Keyed on conversationId: a client-side ?conversation= navigation should
  // fully remount DecisionsView with fresh state, not carry over a prior
  // conversation's resolution/error/sessionId — see decisions-view.tsx.
  return <DecisionsView conversationId={conversationId} key={conversationId} />;
}
