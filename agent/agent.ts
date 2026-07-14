import { defineAgent } from "eve";

// Phase 4 (Philipp, 2026-07-12, DECIDED — see docs/plan-vercel-production.md
// lines 200-262): the standing mandate campaign runs on DeepSeek V4-Pro via
// Vercel AI Gateway. Use the explicit "deepseek-v4-pro" id, never the legacy
// "deepseek-chat"/"deepseek-reasoner" aliases — those deprecate 2026-07-24.
//
// No agent/tools/web_search.ts override is needed for the plan's
// gateway-parallelSearch requirement: eve's harness resolves the built-in
// web_search tool per model at step time
// (node_modules/eve/.../dist/src/harness/provider-tools.js,
// resolveWebSearchBackend/resolveWebSearchProviderTool) and its own doc
// comment states the rule directly — "All AI Gateway models: Parallel search
// via gateway" (direct/BYO OpenAI, Anthropic, Google get their native search
// instead; other BYO models get none). Any AI-Gateway-routed model id
// (unset `source` on the resolved model reference) already gets
// `gateway.tools.parallelSearch()` automatically. Verified two ways: (1)
// this source read of the actual compiled harness logic, not just the docs;
// (2) an SDK-level probe (spikes/phase4-deepseek-probe/probe.mjs) confirming
// parallelSearch itself returns cited results through deepseek-v4-pro. Not
// verified via a live eve dev server on this model, deliberately — a second
// dev server against the same shared Redis risks the same class of
// interference KNOWN_ISSUES #11 describes for `pnpm test` (its recovery
// sweep could steal the live campaign's delivery leases), generalized to any
// second long-running server, not just the test runner.
export default defineAgent({
  model: "deepseek/deepseek-v4-pro",
});
