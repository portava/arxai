// Shared-boot aggregator for the DB-backed integration lane.
//
// WHY THIS EXISTS
//   `runIntegrationCiTests.ts` (the `ci:integration` lane) historically spawned
//   a SEPARATE `pnpm --filter <pkg> run <script>` child per test, so every test
//   re-paid full Node + tsx + module-graph startup and the HTTP ones re-booted
//   the in-process Express app. Many of those tests export a
//   `run(): Promise<CiTestResultLike>` and self-boot the shared app via
//   `inProcessAppHarness`, exactly like the offline `test:ci-inprocess` lane
//   (`runInProcessCiTests.ts`).
//
//   This runner imports those `run()`s and executes them sequentially in ONE
//   process. The shared in-process app boots at most ONCE and every app-booting
//   test reuses that listener. No assertion changes: each `run()` runs the exact
//   same checks and returns its pass/fail counts, which are aggregated here. The
//   process exits non-zero if ANY test reports a failure or throws. Each test
//   file remains independently runnable via its own `test:*` script.
//
// NO-DB IMPORT BOUNDARY
//   This file statically imports test modules that pull in `@workspace/db`,
//   whose module init THROWS synchronously when `DATABASE_URL` is unset. It must
//   therefore NEVER be imported by the wiring guard or any no-DB context — it is
//   only ever spawned by `runIntegrationCiTests.ts` AFTER the DB is provisioned.
//   `runIntegrationCiTests.ts` itself stays free of test-module imports so the
//   guard can keep importing `INTEGRATION_LANE_KEYS` from it with no database.
//
// LOCKSTEP
//   The set of tests run here MUST equal the set of `INTEGRATION_LANE_TESTS`
//   entries flagged `inProcess`. We assert that at startup and fail loudly on
//   any drift, so the lane can never silently skip a flagged test or run one
//   that isn't flagged.

import { closeSharedServer, type CiTestResultLike } from "./inProcessAppHarness.js";
import { INTEGRATION_LANE_TESTS } from "./runIntegrationCiTests.js";
import { run as runCandleDepthDiagnostics } from "../candleDepthDiagnosticsTest.js";
import { run as runBrokerCandleCoverageRoute } from "../brokerCandleCoverageRouteTest.js";
import { run as runCandleDepthRoute } from "../candleDepthDiagnosticsRouteTest.js";
import { run as runHandshakeMonitorPerm } from "../handshakeMonitorPermissionTest.js";
import { run as runInvestorLiveBalanceDb } from "../investorLiveBalanceDbTest.js";
import { run as runInvestorPerformanceRoute } from "../investorPerformanceRouteHonestyTest.js";
import { run as runLiveCycleCloseGuard } from "../liveTestCycleCloseGuardIntegrationTest.js";
import { run as runRealizedDailyPnl } from "../realizedDailyPnlDbTest.js";
import { run as runRubyDrawSetupRoute } from "../rubyDrawSetupRouteTest.js";
import { run as runRubyQualityRouteDb } from "../rubyQualityRouteDbTest.js";
import { run as runWatchlistUniverseGate } from "../watchlistUniverseGateRouteTest.js";

interface AggregatedTest {
  /** `<pkg>::<script>` key — must match this test's INTEGRATION_LANE_TESTS entry. */
  key: string;
  run: () => Promise<CiTestResultLike>;
}

// Every entry here MUST be flagged `inProcess: true` in INTEGRATION_LANE_TESTS
// (and vice versa). `assertLockstep()` enforces this before anything runs.
const TESTS: readonly AggregatedTest[] = [
  { key: "@workspace/scripts::test:candle-depth-diagnostics", run: runCandleDepthDiagnostics },
  { key: "@workspace/scripts::test:broker-candle-coverage-route", run: runBrokerCandleCoverageRoute },
  { key: "@workspace/scripts::test:candle-depth-route", run: runCandleDepthRoute },
  { key: "@workspace/scripts::test:handshake-monitor-perm", run: runHandshakeMonitorPerm },
  { key: "@workspace/scripts::test:investor-live-balance-db", run: runInvestorLiveBalanceDb },
  { key: "@workspace/scripts::test:investor-performance-route", run: runInvestorPerformanceRoute },
  { key: "@workspace/scripts::test:live-cycle-close-guard", run: runLiveCycleCloseGuard },
  { key: "@workspace/scripts::test:realized-daily-pnl", run: runRealizedDailyPnl },
  { key: "@workspace/scripts::test:ruby-draw-setup-route", run: runRubyDrawSetupRoute },
  { key: "@workspace/scripts::test:ruby-quality-route-db", run: runRubyQualityRouteDb },
  { key: "@workspace/scripts::test:watchlist-universe-gate", run: runWatchlistUniverseGate },
] as const;

/**
 * Fail loudly if this aggregator and the `inProcess` flags in
 * `INTEGRATION_LANE_TESTS` ever drift apart. Without this, adding a flag without
 * wiring the `run()` here (or vice versa) would silently drop a safety test from
 * the lane or double-run one.
 */
function assertLockstep(): void {
  const covered = [...TESTS.map((t) => t.key)].sort();
  const flagged = INTEGRATION_LANE_TESTS.filter((t) => t.inProcess === true)
    .map((t) => `${t.pkg}::${t.script}`)
    .sort();
  const coveredSet = new Set(covered);
  const flaggedSet = new Set(flagged);
  const missing = flagged.filter((k) => !coveredSet.has(k)); // flagged but not run here
  const extra = covered.filter((k) => !flaggedSet.has(k)); // run here but not flagged
  if (missing.length === 0 && extra.length === 0) return;

  // eslint-disable-next-line no-console
  console.error(
    "[runIntegrationInProcessTests] LOCKSTEP DRIFT — the in-process aggregator and the " +
      "`inProcess` flags in INTEGRATION_LANE_TESTS disagree:",
  );
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`  flagged inProcess but NOT run here: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`  run here but NOT flagged inProcess: ${extra.join(", ")}`);
  }
  process.exit(1);
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("runIntegrationInProcessTests — shared-boot integration suite");
  // eslint-disable-next-line no-console
  console.log("============================================================\n");

  assertLockstep();

  const results: CiTestResultLike[] = [];
  let hardError: unknown = null;

  for (const t of TESTS) {
    // eslint-disable-next-line no-console
    console.log(`\n──────── ${t.key} ────────`);
    try {
      results.push(await t.run());
    } catch (err) {
      hardError = err;
      // eslint-disable-next-line no-console
      console.error(`[${t.key}] THREW:`, err);
      results.push({ name: t.key, passes: 0, failures: 1 });
      // Stop on a hard throw — a thrown test usually leaves shared state dirty,
      // and the standalone scripts still cover isolated reruns.
      break;
    }
  }

  await closeSharedServer().catch(() => {});

  // eslint-disable-next-line no-console
  console.log("\n============================================================");
  let totalPasses = 0;
  let totalFailures = 0;
  for (const r of results) {
    totalPasses += r.passes;
    totalFailures += r.failures;
    // eslint-disable-next-line no-console
    console.log(`  ${r.failures > 0 ? "✗" : "✓"} ${r.name}: ${r.passes} passed, ${r.failures} failed`);
  }
  // eslint-disable-next-line no-console
  console.log(`\nTotal: ${totalPasses} passed, ${totalFailures} failed across ${results.length} tests`);

  if (hardError || totalFailures > 0) process.exit(1);
  process.exit(0);
}

main().catch(async (err) => {
  await closeSharedServer().catch(() => {});
  // eslint-disable-next-line no-console
  console.error("[runIntegrationInProcessTests] FAILED:", err);
  process.exit(1);
});
