import type { Subscription } from "./types.ts";

// One line per catalog action, always naming the conversation and the
// subscription involved, so a newcomer reading only the console can
// reconstruct the story: what was subscribed, when it armed, and how it
// resolved.
export function logCatalog(
  action: string,
  sub: Pick<Subscription, "conversationId" | "id" | "provider" | "event" | "status">,
  extra: Record<string, unknown> = {},
) {
  const fields = {
    conversationId: sub.conversationId,
    subscriptionId: sub.id,
    provider: sub.provider,
    event: sub.event,
    status: sub.status,
    ...extra,
  };
  const line = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.log(`[catalog] ${action} ${line}`);
}
