import { defineConfig } from "nitro/config";

// serverDir defaults to `false` in Nitro v3 (no automatic routes/ or
// plugins/ directory scanning) — see KNOWN_ISSUES.md #13 in the main app
// and spikes/vercel-queue-smoke/nitro.config.ts, which hit the exact same
// silent-404 trap. "./" turns on scanning at the project root.
//
// The `workflow/nitro` module (not `@workflow/nitro` directly — that's the
// underlying npm package the `workflow` package re-exports at this
// subpath) wires up the "use workflow" / "use step" directive transform.
export default defineConfig({
  serverDir: "./",
  modules: ["workflow/nitro"],
  // Workflow steps run inside this service's own Vercel Fluid function —
  // Workflows' own event/step ceilings are separate from that function's
  // wall-clock limit (docs/architecture.md, gate 7). Without this, the
  // function defaults to Vercel's much shorter standard ceiling, so a
  // socket-holding step (SESSION_DURATION_MS, connector/workflows/
  // market-data-session.ts) would be killed mid-session regardless of how
  // conservatively that duration is budgeted. 800s is the documented Fluid
  // GA ceiling (Codex gate finding, docs/plan-vercel-production.md).
  vercel: {
    functions: {
      maxDuration: 800,
    },
  },
});
