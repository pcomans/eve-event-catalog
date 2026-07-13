import { sleep } from "workflow";
import { start } from "workflow/api";

// THROWAWAY smoke test — not part of the real connector, not built for
// reuse. Verifies, on REAL Vercel infra via a preview deployment, the two
// things docs/plan-vercel-production.md flags as early-Phase-2 gates:
//
// 1. vercel/workflow issue #634 ("Steps Don't Run After Sleep" — resume
//    sometimes fails, reportedly worsening around the ~30-min mark).
//    Two-tier: a quick loop of short 30s sleeps (does the basic
//    sleep-then-resume path work at all?) AND one 35-minute sleep
//    (does it survive the reported trouble spot?).
// 2. The start(self, [state]) recursion shape gate 7 found is the ONLY
//    "run forever" primitive this SDK offers (no continueAsNew) — chains
//    exactly once here, then stops (a throwaway test must not actually run
//    forever).
export interface SmokeTestState {
  /** 0 = the original run, 1 = the chained (recursed) run. Stops after 1 — this is a bounded smoke test, not the real connector. */
  runIndex: number;
}

export async function sleepResumeSmokeTest(state: SmokeTestState): Promise<{ done: true; runIndex: number }> {
  "use workflow";

  await logResume(`run ${state.runIndex} starting`);

  for (let i = 0; i < 2; i++) {
    await sleep("5s"); // shortened for a quick re-verify of the start()-from-step fix only; the 6x30s+35m durations already separately confirmed sleep/resume survives past #634's trouble spot (KNOWN_ISSUES.md) — this pass is just proving the chained start() no longer throws
    await logResume(`run ${state.runIndex} quick-loop resume #${i + 1} (after a 5s sleep)`);
  }

  await sleep("5s");
  await logResume(`run ${state.runIndex} resumed after the second sleep`);

  if (state.runIndex === 0) {
    // Runtime-discovered gotcha, not in gate 7's own research: calling
    // start() directly in a "use workflow" body throws
    // ("The workflow environment doesn't allow this runtime usage of
    // start. Move this call to a step function...") — confirmed against
    // real infra (KNOWN_ISSUES.md). start() must be called from inside its
    // own "use step" wrapper, same as any other side-effecting call.
    const chained = await startChainedRun({ runIndex: 1 });
    await logResume(`run ${state.runIndex} chained a new run (${chained.runId}) via start(self) and is stopping`);
    return { done: true, runIndex: state.runIndex };
  }

  await logResume(`run ${state.runIndex} is the chained run — stopping here, no further chaining (bounded smoke test)`);
  return { done: true, runIndex: state.runIndex };
}

async function startChainedRun(nextState: SmokeTestState): Promise<{ runId: string }> {
  "use step";
  // A second runtime-discovered gotcha (KNOWN_ISSUES.md): a step's return
  // value must be JSON-serializable (it's persisted for replay/resume) —
  // returning the Run object start() resolves to fails serialization (its
  // `world` field holds live functions). Extract just the runId.
  //
  // Also observed: each of this step's 4 retries (chasing the serialization
  // failure below) actually called start() again, creating 4 DISTINCT
  // downstream runs — start() has no idempotency-key option (checked
  // StartOptions), so a step wrapping it is not safely retryable as-is.
  // Flagged for the real connector, not fixed here (throwaway test).
  const run = await start(sleepResumeSmokeTest, [nextState]);
  return { runId: run.runId };
}

async function logResume(message: string): Promise<void> {
  "use step";
  console.log(`[sleep-resume-smoke-test] ${new Date().toISOString()} ${message}`);
}
