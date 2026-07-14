// M1 probe: verify (a) deepseek/deepseek-v4-pro resolves through AI Gateway
// with this worktree's local env (OIDC auth, no AI_GATEWAY_API_KEY), and
// (b) gateway.tools.parallelSearch() returns cited results through it.
// Throwaway script — not wired into the app, deleted or left inert after
// M1 is confirmed. Run: node --env-file-if-exists=.env.local spikes/phase4-deepseek-probe/probe.mjs
import { generateText, gateway } from "ai";

const MODEL_ID = "deepseek/deepseek-v4-pro";

console.log(`[probe] auth: AI_GATEWAY_API_KEY=${process.env.AI_GATEWAY_API_KEY ? "set" : "unset"} VERCEL_OIDC_TOKEN=${process.env.VERCEL_OIDC_TOKEN ? "set" : "unset"}`);

console.log(`[probe] (a) plain call through ${MODEL_ID}...`);
const plain = await generateText({
  model: MODEL_ID,
  prompt: "Reply with exactly the word: pong",
});
console.log("[probe] (a) OK, text:", JSON.stringify(plain.text));

console.log("[probe] (b) parallelSearch tool call...");
const searched = await generateText({
  model: MODEL_ID,
  prompt: "What was the S&P 500 closing value on the most recent trading day? Use the search tool and cite your source.",
  tools: { web_search: gateway.tools.parallelSearch() },
  toolChoice: "required",
  stopWhen: ({ steps }) => steps.length >= 3,
});
const searchCalls = searched.steps.flatMap((s) => s.toolCalls ?? []).filter((c) => c.toolName === "web_search");
console.log("[probe] (b) tool calls made:", searchCalls.length);
console.log("[probe] (b) final text:", searched.text);
if (searchCalls.length === 0) throw new Error("parallelSearch was never invoked — tool wiring or toolChoice is wrong");

console.log("[probe] PASS: both (a) and (b) succeeded.");
