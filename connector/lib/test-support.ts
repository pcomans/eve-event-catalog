// Re-exports nitro/h3's mockEvent for tests OUTSIDE this workspace package
// (tests/connector-routes/*.test.ts, moved out of connector/routes/ per the
// p6g gate's own Nitro-route-scanner finding) to construct an H3Event
// without needing "nitro" as a root-level dependency: pnpm's workspace
// layout only installs `nitro` under connector/node_modules (this
// package's own dependency), so a bare `import ... from "nitro/h3"` from a
// file living outside connector/ can't resolve it — module resolution for
// a bare specifier walks up from the IMPORTING file's own directory, not
// the process cwd. This thin re-export lives inside connector/lib/ (never
// scanned as a route — nitro.config.ts's serverDir only scans routes/ and
// plugins/), where that resolution already works; the outer test file just
// imports this file by relative path instead of reaching for "nitro/h3"
// directly.
export { mockEvent } from "nitro/h3";
