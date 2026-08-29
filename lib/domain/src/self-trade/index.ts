// Self-Trade AI — Decision Brain & Handshake Network (Task #212).
// PURE / deterministic, SHADOW / decision-only public barrel. No IO here; the
// api-server gathers raw inputs (candles, scanner/scalp signals, news risk,
// broker spread, ledger, quota, governor, handshake readiness) and feeds these
// modules, which never place real orders and never fabricate data.

export * from "./selfTradeDecision.types.js";
export {
  detectMarketRegime,
  classifySetup,
  evaluateMtfAlignment,
  evaluateEntryZone,
  evaluateLateEntry,
  evaluateSpreadSlippage,
  computeNoTradeScore,
  applyConfidenceDecay,
} from "./decisionModules.js";
export { buildTradeThesis } from "./tradeThesis.js";
export {
  computeRankScore,
  buildScoreBreakdown,
  rankCandidates,
} from "./opportunityRanking.js";
export {
  staticForexCorrelation,
  resolveCorrelation,
  evaluateCorrelationConflict,
} from "./correlation.js";
export type { CorrelationLookup, CorrelationConflict } from "./correlation.js";
export { runDecisionPipeline, isSimulatedDataSource } from "./decisionPipeline.js";
export { resolveSupervisor } from "./selfTradeSupervisor.js";
export type {
  SupervisorResult,
  SupervisorOpts,
  OppositeConflictJournalEntry,
} from "./selfTradeSupervisor.js";
export { buildVolatilityMatrix } from "./volatilityMatrix.js";
export type {
  VolatilityMatrix,
  VolatilityNode,
  VolatilityPair,
  VolatilitySeriesInput,
  MatrixDirection,
  MatrixMomentum,
} from "./volatilityMatrix.js";

// ── Autonomous Live Execution (Task #213) — pure decision→execution modules ──
export { evaluateExecutionPermission } from "./executionPermission.js";
export type {
  ExecutionPermissionAction,
  ExecutionPermissionInput,
  ExecutionPermissionVerdict,
} from "./executionPermission.js";
export { computeRiskAwareLot } from "./riskAwareLotSizer.js";
export type {
  RiskAwareLotInput,
  RiskAwareLotResult,
  LotClampReason,
} from "./riskAwareLotSizer.js";
export { evaluateQuotaPressure } from "./quotaPressure.js";
export type {
  QuotaPressureRegime,
  QuotaPressureInput,
  QuotaPressureVerdict,
} from "./quotaPressure.js";
export { evaluateManagementAction } from "./positionManagement.js";
export type {
  ManagementAction,
  PositionManagementInput,
  PositionManagementVerdict,
} from "./positionManagement.js";
