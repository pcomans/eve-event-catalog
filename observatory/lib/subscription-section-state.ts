import type { Subscription } from "./catalog-types.ts";

// A subscription absent from the poll's current data means one of three
// different things — still loading, this poll failed, or it's genuinely
// gone — and TimelineEvent (task #39) must say a different thing for each.
// "removed" is the only state that asserts the subscription no longer
// exists, so it's the only branch gated on a successful, settled load.
export type SubscriptionSectionState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "found"; subscription: Subscription }
  | { kind: "removed" };

/**
 * Resolves what a timeline marker's expanded Subscription section should
 * say, given the subscriptions poll's own state. Pure: no fetching, just
 * the same three-way branch usePolling's {data, error, loading} always
 * needs when the "not found" case has a user-facing claim attached to it.
 */
export function resolveSubscriptionSectionState(
  subscription: Subscription | undefined,
  loading: boolean,
  error: string | null,
): SubscriptionSectionState {
  if (loading) return { kind: "loading" };
  if (error) return { kind: "error" };
  if (subscription) return { kind: "found", subscription };
  return { kind: "removed" };
}
