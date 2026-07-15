// task #36: the test suite runs against the SAME shared Upstash Redis the
// observatory reads from, and history is append-only (no cleanup path for
// it) — so a suite run leaves behind subscriptions/history rows whose
// conversationId follows this codebase's test-fixture convention:
// `test:<uuid>` (most catalog/providers/*.test.ts fixtures — e.g.
// clock-sweep.test.ts's own testConversationId()) or `test-<label>-<uuid>`
// (a handful of older/differently-shaped fixtures — e.g.
// alpaca-watcher-host.test.ts's "test-watcher-host-symbol-<uuid>").
//
// The raw eve API (GET /catalog/subscriptions, GET /catalog/events) stays
// honest, unfiltered infrastructure state on purpose — this filter lives
// only in the observatory's own proxy routes, which are the curated public
// story, not a second source of truth.
//
// p6k gate (LOW): a plain `startsWith("test:") || startsWith("test-")`
// would ALSO swallow a genuine production conversationId that happens to
// start the same way — production reserves neither prefix (POST
// /catalog/chat accepts an unchecked caller-chosen conversationId,
// agent/channels/catalog.ts, and CAMPAIGN_CONVERSATION_ID has no naming
// convention enforced either), so a real campaign named e.g. "test-drive"
// would be silently removed from the curated views. Anchored to the ACTUAL
// fixture shape instead — every real fixture id ends in a genuine
// randomUUID() — so a prefix match alone is never enough; the tail must be
// a well-formed UUID too.
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const TEST_FIXTURE_CONVERSATION_ID = new RegExp(`^(test:${UUID}|test-.+-${UUID})$`);

export function isTestFixtureConversationId(conversationId: string): boolean {
  return TEST_FIXTURE_CONVERSATION_ID.test(conversationId);
}
