import { reportResult, type CheckResult } from "./_lib.js";
import { checkNoConsole } from "./check-no-console.js";
import { checkCanPlaceTrades } from "./check-can-place-trades.js";
import { checkRouteCollisions } from "./check-route-collisions.js";
import { checkDuplicateTables } from "./check-duplicate-tables.js";
import { checkVaultMutations } from "./check-vault-mutations.js";
import { checkCrossArtifactImports } from "./check-cross-artifact-imports.js";
import { checkDomainCircular } from "./check-domain-circular.js";
import { checkPaperAutopilotIsolation } from "./check-paper-autopilot-isolation.js";
import { checkLiveTradingReadinessLock } from "./check-live-trading-readiness-lock.js";
import { checkEmergencyKillSwitch } from "./check-emergency-kill-switch.js";
import { checkLiveOrderRiskLimits } from "./check-live-order-risk-limits.js";
import { checkSecurityRoleHeader } from "./check-security-role-header.js";
import { checkLiveBrokerExecutionDefaults } from "./check-live-broker-execution-defaults.js";
import { checkMasterLiveBridgeBinding } from "./check-master-live-bridge-binding.js";
import { checkMasterLiveUserApprovalRequired } from "./check-master-live-user-access.js";
import { checkOneClickConcurrency } from "./check-one-click-concurrency.js";
import { checkOneClickArmRoutesThroughGate } from "./check-one-click-arm-routes-through-gate.js";
import { checkScannerSelectedMarket } from "./check-scanner-selected-market.js";
import { checkPerUserIsolationMeRoutes } from "./perUserIsolationMeRoutes.js";
import {
  checkModernDemoDispatchUsesRouting,
  checkMasterBridgeLiveLocked,
  checkMasterBridgeSecretsNotLeaked,
} from "./check-master-bridge-routing.js";
import { checkRiskyWordingFrontend } from "./check-risky-wording-frontend.js";
import { checkNoInternalNamesUserUi } from "./check-no-internal-names-user-ui.js";
import { checkNoRealUserPasswordMutation } from "./check-no-real-user-password-mutation.js";
import { checkSharedBridgeReconciliation } from "./check-shared-bridge-reconciliation.js";
import { checkRealizedPnlDownstreamGuard } from "./check-realized-pnl-downstream-guard.js";
import { checkEaInputsTelemetry } from "./check-ea-inputs-telemetry.js";
import { checkProductRoleEnforcement } from "./check-product-role-enforcement.js";
import { checkInvestorNoGuaranteedReturn } from "./check-investor-no-guaranteed-return.js";
import { checkInvestorPerformanceMetrics } from "./check-investor-performance-metrics.js";
import { checkInvestorEquitySeries } from "./check-investor-equity-series.js";
import { checkRouterLevelAccessGuardLeak } from "./check-router-level-access-guard-leak.js";
import { checkGlobalAuthGateOrder } from "./check-global-auth-gate-order.js";
import { checkFundbookNoBrokerWrites } from "./check-fundbook-no-broker-writes.js";
import { checkChartTruthMockLeak } from "./check-chart-truth-mock-leak.js";
import { checkChartTruthBypass } from "./check-chart-truth-bypass.js";
import { checkChartTruthServiceBypass } from "./check-chart-truth-service-bypass.js";
import { checkReconciledGhostExposure } from "./check-reconciled-ghost-exposure.js";
import { checkBridgeV2Truth } from "./check-bridge-v2-truth.js";
import { checkModeScopeNoInvestorSnapshot } from "./check-mode-scope-no-investor-snapshot.js";
import { checkRubyDerivedSafetyEnvelope } from "./check-ruby-derived-safety-envelope.js";
import { checkMockProviderLiveFeed } from "./check-mock-provider-live-feed.js";
import { checkSyntheticFloorProdDefaultDeny } from "./check-synthetic-floor-prod-default-deny.js";
import { checkCooldownAdvisoryLock } from "./check-cooldown-advisory-lock.js";
import { checkDisplayContractImportBoundary } from "./check-display-contract-import-boundary.js";
import { checkTestScriptsWired } from "./check-test-scripts-wired.js";
import { checkFixAgentImportBoundary } from "./check-fix-agent-import-boundary.js";
import { checkAssistantNoDirectExecution } from "./check-assistant-no-direct-execution.js";
import { checkChartTradeNoDirectExecution } from "./check-chart-trade-no-direct-execution.js";
import { checkUnifiedReadinessNoDispatch } from "./check-unified-readiness-no-dispatch.js";
import { checkAdminTradingNoLiveBypass } from "./check-admin-trading-no-live-bypass.js";
import { checkLiveAiHarnessHonesty } from "./check-live-ai-harness-honesty.js";
import { checkBacktestNoLiveExecution } from "./check-backtest-no-live-execution.js";
import { checkMissionNoDirectExecution } from "./check-mission-no-direct-execution.js";
import { checkScannerVerdictImportBoundary } from "./check-scanner-verdict-import-boundary.js";
import { checkNoFabrication } from "./check-no-fabrication.js";
// NOTE: `check-no-user-facing-paper-only.ts` exists as a future guard but
// is intentionally NOT registered yet — it finds 65 pre-existing UI
// strings (login.tsx, onboarding.tsx, my-paper-trades.tsx, etc.) that are
// Phase 4 cleanup work, not Phase 3. The guard is wired up to run on
// demand: `pnpm tsx scripts/src/ci/check-no-user-facing-paper-only.ts`.

const checks: Array<() => CheckResult> = [
  checkCanPlaceTrades,
  checkVaultMutations,
  checkNoConsole,
  checkRouteCollisions,
  checkDuplicateTables,
  checkCrossArtifactImports,
  checkDomainCircular,
  checkPaperAutopilotIsolation,
  checkLiveTradingReadinessLock,
  checkEmergencyKillSwitch,
  checkLiveOrderRiskLimits,
  checkSecurityRoleHeader,
  checkLiveBrokerExecutionDefaults,
  checkMasterLiveBridgeBinding,
  checkMasterLiveUserApprovalRequired,
  checkOneClickConcurrency,
  checkOneClickArmRoutesThroughGate,
  checkScannerSelectedMarket,
  checkPerUserIsolationMeRoutes,
  checkModernDemoDispatchUsesRouting,
  checkMasterBridgeLiveLocked,
  checkMasterBridgeSecretsNotLeaked,
  checkRiskyWordingFrontend,
  checkNoInternalNamesUserUi,
  checkNoRealUserPasswordMutation,
  checkSharedBridgeReconciliation,
  checkRealizedPnlDownstreamGuard,
  checkEaInputsTelemetry,
  checkProductRoleEnforcement,
  checkInvestorNoGuaranteedReturn,
  checkInvestorPerformanceMetrics,
  checkInvestorEquitySeries,
  checkRouterLevelAccessGuardLeak,
  checkGlobalAuthGateOrder,
  checkFundbookNoBrokerWrites,
  checkChartTruthMockLeak,
  checkChartTruthBypass,
  checkChartTruthServiceBypass,
  checkReconciledGhostExposure,
  checkBridgeV2Truth,
  checkModeScopeNoInvestorSnapshot,
  checkRubyDerivedSafetyEnvelope,
  checkMockProviderLiveFeed,
  checkSyntheticFloorProdDefaultDeny,
  checkCooldownAdvisoryLock,
  checkDisplayContractImportBoundary,
  checkTestScriptsWired,
  checkFixAgentImportBoundary,
  checkAssistantNoDirectExecution,
  checkChartTradeNoDirectExecution,
  checkUnifiedReadinessNoDispatch,
  checkAdminTradingNoLiveBypass,
  checkLiveAiHarnessHonesty,
  checkBacktestNoLiveExecution,
  checkMissionNoDirectExecution,
  checkScannerVerdictImportBoundary,
  checkNoFabrication,
];

let failed = 0;
const startedAt = Date.now();
for (const c of checks) {
  const r = c();
  reportResult(r);
  if (!r.ok) failed++;
}
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
// eslint-disable-next-line no-console
console.log(`\n${checks.length - failed}/${checks.length} guards passed in ${elapsed}s`);
process.exit(failed === 0 ? 0 : 1);
