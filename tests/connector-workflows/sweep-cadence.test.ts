import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isChainDead } from "../../catalog/providers/chain-supervisor.ts";
import { CLOCK_HEARTBEAT_STALE_AFTER_MS, CLOCK_SWEEP_INTERVAL_MS } from "../../connector/workflows/clock-sweep.ts";
import { EDGAR_HEARTBEAT_STALE_AFTER_MS, EDGAR_SWEEP_INTERVAL_MS } from "../../connector/workflows/edgar-sweep.ts";
import { EXPIRY_HEARTBEAT_STALE_AFTER_MS, EXPIRY_SWEEP_INTERVAL_MS } from "../../connector/workflows/expiry-sweep.ts";
import { RECOVERY_HEARTBEAT_STALE_AFTER_MS, RECOVERY_SWEEP_INTERVAL_MS } from "../../connector/workflows/recovery-sweep.ts";

// The two things a connector sweep's cadence is actually load-bearing for.
// Neither is a restatement of the constant: one couples it to what
// catalog.json PROMISES the agent (AGENTS.md rule 4), the other couples it
// to the supervisor's own liveness verdict (KNOWN_ISSUES.md #15's
// duplicate-chain class). A future cadence change that breaks either one
// fails here instead of in production.

const catalog = JSON.parse(readFileSync(new URL("../../catalog/catalog.json", import.meta.url), "utf8")) as {
  eventTypes: { provider: string; event: string; metadata: Record<string, string> }[];
};

/**
 * catalog.json's clock.time.at entry advertises its own wake lateness back
 * to the agent ("a durable 30s sweep", "checks it every ~30s") — that
 * number IS this sweep's tick interval, restated as a promise, and
 * search_events hands it to the agent verbatim. AGENTS.md rule 4: the
 * catalog is honest, so the promise tracks the constant instead of being
 * kept in sync by whoever remembers.
 *
 * Deliberately the most boring check that actually holds: both metadata
 * fields must CONTAIN the seconds figure derived from the constant. No
 * prose parsing — parsing English to decide whether a sentence is true is
 * brittle in ways that have nothing to do with the invariant, and a test
 * that fails for unrelated reasons is a test people learn to ignore. The
 * standing requirement this imposes is simply: state the cadence as a
 * number of seconds ("60s"), not as words ("about a minute").
 */
test("catalog.json's clock.time.at advertises the clock sweep's ACTUAL tick interval", () => {
  const entry = catalog.eventTypes.find((e) => e.provider === "clock" && e.event === "time.at");
  assert.ok(entry, "catalog.json has no clock/time.at entry");

  const advertisedCadence = `${CLOCK_SWEEP_INTERVAL_MS / 1000}s`;
  for (const field of ["latency", "durability"] as const) {
    assert.ok(
      entry.metadata[field].includes(advertisedCadence),
      `clock.time.at's metadata.${field} never mentions the connector clock sweep's real cadence (${advertisedCadence}), so what the catalog promises the agent and what the sweep does have drifted: ${entry.metadata[field]}`,
    );
  }
});

// The platform's full function duration, the same ~800s ceiling
// edgar-sweep.ts's own EDGAR_HEARTBEAT_STALE_AFTER_MS comment was chosen
// against (and market-data-session.ts's maxDuration=800).
const MAX_STEP_DURATION_MS = 800_000;

/**
 * Each sweep writes a heartbeat at the start and end of every tick, and the
 * ensure-* Cron supervisors start a SECOND chain whenever isChainDead()
 * says the heartbeat is stale. So the worst gap a HEALTHY chain can put
 * between two heartbeats — one full durable sleep plus one maximally slow
 * tick — must stay inside the staleness tolerance, or the supervisor
 * manufactures exactly the duplicate forever-chain KNOWN_ISSUES.md #15's
 * claimChain cannot prevent (claimChain stops one run forking itself; it
 * cannot stop two independently-started runs coexisting).
 */
for (const [name, intervalMs, staleAfterMs] of [
  ["recovery", RECOVERY_SWEEP_INTERVAL_MS, RECOVERY_HEARTBEAT_STALE_AFTER_MS],
  ["expiry", EXPIRY_SWEEP_INTERVAL_MS, EXPIRY_HEARTBEAT_STALE_AFTER_MS],
  ["clock", CLOCK_SWEEP_INTERVAL_MS, CLOCK_HEARTBEAT_STALE_AFTER_MS],
  ["edgar", EDGAR_SWEEP_INTERVAL_MS, EDGAR_HEARTBEAT_STALE_AFTER_MS],
] as const) {
  test(`a healthy ${name} chain never looks dead to its own supervisor`, () => {
    const worstHealthyGapMs = intervalMs + MAX_STEP_DURATION_MS;
    const now = Date.now();

    assert.equal(
      isChainDead(now - worstHealthyGapMs, now, staleAfterMs),
      false,
      `${name}: a healthy chain's worst heartbeat gap (${worstHealthyGapMs}ms = ${intervalMs}ms sleep + a ${MAX_STEP_DURATION_MS}ms tick) exceeds its ${staleAfterMs}ms staleness tolerance — the ensure-${name}-running Cron would start a duplicate chain alongside a working one`,
    );
  });
}
