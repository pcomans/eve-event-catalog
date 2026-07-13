// Not in the original step numbering. Follow-up requested by the team lead: statically
// determine whether eve's OWN .env.local loader strips quotes the way node --env-file does.
//
// Answer found by reading node_modules/eve@0.22.5's dist/src/cli/dev/environment.js directly:
// eve calls node:util's built-in `parseEnv()` to read each dev env file — the EXACT SAME
// parser that backs `node --env-file` (it's a native binding, not a reimplementation). Since
// step1-baseline.mjs already proved LANGSMITH_TRACING="true" resolves correctly to the 4-char
// string `true` under that parser, this closes the loop: eve's quote-handling is identical, and
// the "quotes leak through as literal characters" theory is definitively ruled out, not just
// "unverified".
//
// While reading environment.js, found something more interesting: `reload()` doesn't just ADD
// values found in a fresh file read — it ACTIVELY DELETES from process.env any key that WAS
// loaded on a previous reload but is ABSENT from the new read. This script reproduces that
// exact logic (copied verbatim from environment.js, which cannot be imported directly outside
// eve's own package.json `#*.js` import-map) against a fake read function, to prove the
// deletion behavior concretely rather than just asserting it from reading minified source.
//
// Run: node step6-env-reload-deletion.mjs   (no env file / LangSmith calls involved)

// --- Verbatim port of eve's createDevelopmentEnvironmentLoader from
// dist/src/cli/dev/environment.js (deminified variable names for readability; logic unchanged) ---
function createDevelopmentEnvironmentLoader(readValues) {
  const originalProcessEnvKeys = new Set(Object.keys(process.env));
  const previouslyLoaded = new Map(); // key -> value, from the last successful reload()
  return {
    reload() {
      const fresh = readValues(); // Map<key, value> -- a fresh parse of the env file(s)
      for (const [key, value] of previouslyLoaded) {
        if (!fresh.has(key) && !originalProcessEnvKeys.has(key)) {
          if (process.env[key] === value) delete process.env[key];
          previouslyLoaded.delete(key);
        }
      }
      for (const [key, value] of fresh) {
        if (!originalProcessEnvKeys.has(key)) {
          process.env[key] = value;
          previouslyLoaded.set(key, value);
        }
      }
    },
  };
}

console.log("Simulating eve's dev-server env reload lifecycle for LANGSMITH_TRACING.\n");

// Simulate process.env NOT already having LANGSMITH_TRACING before any .env.local load (matches
// a fresh `eve dev` boot where the var only exists in .env.local, not the shell environment).
delete process.env.LANGSMITH_TRACING;

let currentFileContents = new Map([
  ["LANGSMITH_API_KEY", "sk-fake"],
  ["LANGSMITH_PROJECT", "eve-events"],
  ["LANGSMITH_TRACING", "true"],
]);

const loader = createDevelopmentEnvironmentLoader(() => currentFileContents);

console.log("1) Initial load (boot, file has LANGSMITH_TRACING=true):");
loader.reload();
console.log("   process.env.LANGSMITH_TRACING =", JSON.stringify(process.env.LANGSMITH_TRACING));

console.log("\n2) A reload fires from a file-watch event where the FRESH read of .env.local");
console.log("   happens to be MISSING LANGSMITH_TRACING (e.g. a torn read mid-write, or a");
console.log("   `vercel env pull` racing a manual edit — both real risks per KNOWN_ISSUES #2,");
console.log("   which explicitly warns against running `vercel env pull` while the dev server");
console.log("   is up):");
currentFileContents = new Map([
  ["LANGSMITH_API_KEY", "sk-fake"],
  ["LANGSMITH_PROJECT", "eve-events"],
  // LANGSMITH_TRACING absent from this read
]);
loader.reload();
console.log("   process.env.LANGSMITH_TRACING =", JSON.stringify(process.env.LANGSMITH_TRACING));
console.log("   ->", process.env.LANGSMITH_TRACING === undefined ? "DELETED, exactly as isEnvTracingEnabled() would need to see it fail" : "still present (unexpected)");

console.log("\n3) A LATER reload fires with the file back to its correct, complete state:");
currentFileContents = new Map([
  ["LANGSMITH_API_KEY", "sk-fake"],
  ["LANGSMITH_PROJECT", "eve-events"],
  ["LANGSMITH_TRACING", "true"],
]);
loader.reload();
console.log("   process.env.LANGSMITH_TRACING =", JSON.stringify(process.env.LANGSMITH_TRACING));
console.log("   -> self-heals IF AND ONLY IF a subsequent env-file-touching reload actually fires.");
console.log("      If nothing touches .env.local again after step 2, the process stays broken");
console.log("      until a full restart -- matching 'zero spans forever, from one point in time'.");
