// Combined in-process CI runner.
//
// The five CI tests below each exercise pure-unit / DB / in-process-app logic.
// Previously every one was spawned in its own `tsx` process, so the two that
// boot the real Express app paid the full app-boot cost twice and every test
// paid Node + tsx + module-graph startup from scratch.
//
// This runner imports each test's `run()` and executes them sequentially in a
// SINGLE process. The shared in-process app harness boots the Express app at
// most ONCE (lazily, on the first test that needs it) and every app-booting
// test reuses that same listener. No assertion is changed: each `run()` runs
// the exact same checks and returns its pass/fail counts, which are aggregated
// here. The process exits non-zero if ANY test reports a failure or throws.
//
// Each test file remains independently runnable via its existing `test:*`
// script (its standalone `isEntrypoint` guard boots/cleans up on its own).

import { closeSharedServer, type CiTestResultLike } from "./inProcessAppHarness.js";
import { run as runRealizedPnlGuard } from "../realizedPnlGuardTest.js";
import { run as runLiveCloseEvidence } from "../liveCloseEvidenceTest.js";
import { run as runLiveGovDispatch } from "../qaLiveGovernanceDispatchDecision.js";
import { run as runLiveCycleCloseGuard } from "../liveTestCycleCloseGuardIntegrationTest.js";
import { run as runAggregatesExcludeUnknown } from "../aggregatesExcludeUnknownPnlTest.js";
import { run as runInvestorPerformanceRoute } from "../investorPerformanceRouteHonestyTest.js";
import { run as runHandshakeMonitorPerm } from "../handshakeMonitorPermissionTest.js";
import { run as runRubyQualityRouteDb } from "../rubyQualityRouteDbTest.js";
import { run as runReconciledGhostExposureDb } from "../reconciledGhostExposureDbTest.js";
import { run as runRealizedDailyPnlDb } from "../realizedDailyPnlDbTest.js";
import { run as runReconcileSummaryEndpoint } from "../reconcileSummaryEndpointTest.js";
import { run as runRubyDrawSetupRoute } from "../rubyDrawSetupRouteTest.js";
import { run as runWatchlistUniverseGate } from "../watchlistUniverseGateRouteTest.js";
import { run as runCandleDepthDiagnostics } from "../candleDepthDiagnosticsTest.js";
import { run as runCandleDepthRoute } from "../candleDepthDiagnosticsRouteTest.js";
import { run as runAccountShellRoute } from "../meAccountShellRouteTest.js";
import { run as runCachedReadE2e } from "../meCachedReadEndToEndTest.js";
import { run as runBrokerCandleCoverageRoute } from "../brokerCandleCoverageRouteTest.js";

const TESTS: Array<{ label: string; run: () => Promise<CiTestResultLike> }> = [
  { label: "test:realized-pnl-guard", run: runRealizedPnlGuard },
  { label: "test:live-close-evidence", run: runLiveCloseEvidence },
  { label: "test:live-gov-dispatch", run: runLiveGovDispatch },
  { label: "test:live-cycle-close-guard", run: runLiveCycleCloseGuard },
  { label: "test:aggregates-exclude-unknown", run: runAggregatesExcludeUnknown },
  { label: "test:investor-performance-route", run: runInvestorPerformanceRoute },
  { label: "test:handshake-monitor-perm", run: runHandshakeMonitorPerm },
  { label: "test:ruby-quality-route-db", run: runRubyQualityRouteDb },
  { label: "test:reconciled-ghost-exposure-db", run: runReconciledGhostExposureDb },
  { label: "test:realized-daily-pnl", run: runRealizedDailyPnlDb },
  { label: "test:reconcile-summary-endpoint", run: runReconcileSummaryEndpoint },
  { label: "test:ruby-draw-setup-route", run: runRubyDrawSetupRoute },
  { label: "test:watchlist-universe-gate", run: runWatchlistUniverseGate },
  { label: "test:candle-depth-diagnostics", run: runCandleDepthDiagnostics },
  { label: "test:candle-depth-route", run: runCandleDepthRoute },
  { label: "test:account-shell-route", run: runAccountShellRoute },
  { label: "test:cached-read-e2e", run: runCachedReadE2e },
  { label: "test:broker-candle-coverage-route", run: runBrokerCandleCoverageRoute },
];

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("runInProcessCiTests — shared-boot CI suite");
  // eslint-disable-next-line no-console
  console.log("==========================================\n");

  const results: CiTestResultLike[] = [];
  let hardError: unknown = null;

  for (const t of TESTS) {
    // eslint-disable-next-line no-console
    console.log(`\n──────── ${t.label} ────────`);
    try {
      results.push(await t.run());
    } catch (err) {
      hardError = err;
      // eslint-disable-next-line no-console
      console.error(`[${t.label}] THREW:`, err);
      results.push({ name: t.label, passes: 0, failures: 1 });
      // Stop on a hard throw — a thrown test usually leaves shared state dirty,
      // and the standalone scripts still cover isolated reruns.
      break;
    }
  }

  await closeSharedServer().catch(() => {});

  // eslint-disable-next-line no-console
  console.log("\n==========================================");
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
  console.error("[runInProcessCiTests] FAILED:", err);
  process.exit(1);
});
