// Execution Intelligence — Phase 4B barrel.
export * from "./executionIntelligence.types";
export * from "./preTradeCostEstimator.engine";
export * from "./implementationShortfall.engine";
export * from "./effectiveSpread.engine";
export * from "./realizedSpread.engine";
export * from "./marketImpact.engine";
export * from "./timingRisk.engine";
export * from "./opportunityCost.engine";
export * from "./executionBenchmark.engine";
export * from "./executionQualityGrade.engine";
export * from "./brokerScorecard.engine";
export * from "./executionLearning.engine";
export * from "./orderTacticSelector.engine";
export * from "./executionGovernance.engine";

// ── Composite post-trade report builder ──────────────────────────────────
import {
  type PostTradeInput,
  type PostTradeExecutionReport,
  type ExecutionVerdict,
  clamp01,
} from "./executionIntelligence.types";
import { computeImplementationShortfall } from "./implementationShortfall.engine";
import { computeEffectiveSpread }          from "./effectiveSpread.engine";
import { computeRealizedSpread }           from "./realizedSpread.engine";
import { computeMarketImpact }             from "./marketImpact.engine";
import { computeTimingRisk }               from "./timingRisk.engine";
import { computeOpportunityCost }          from "./opportunityCost.engine";
import { benchmarkExecution }              from "./executionBenchmark.engine";
import { gradeExecutionQuality }           from "./executionQualityGrade.engine";

export function buildPostTradeExecutionReport(input: PostTradeInput): PostTradeExecutionReport {
  const reasons: string[] = [];
  const anomalies: string[] = [];

  const fillRatio01 = clamp01(input.intendedSizeLots > 0 ? input.filledLots / input.intendedSizeLots : 0);

  const is = computeImplementationShortfall({
    side: input.side, intendedLots: input.intendedSizeLots, filledLots: input.filledLots,
    decisionPrice: input.decisionPrice, fillPrice: input.fillPrice,
    postSignalMaxFavorablePrice: input.postSignalMaxFavorablePrice,
    pipSize: input.pipSize, pipValuePerLotUsd: input.pipValuePerLotUsd,
  });
  const effective = computeEffectiveSpread(input.fillPrice, input.midAtSignal, input.pipSize);
  const realized  = computeRealizedSpread(input.side, input.fillPrice, input.midAfterDelay, input.pipSize);
  const impact    = computeMarketImpact(input.side, input.midAtSignal, input.midAfterDelay, input.pipSize);
  const timing    = computeTimingRisk(0, Math.max(0, input.latencyAtFillMs - input.latencyAtDecisionMs));
  const opp       = computeOpportunityCost({
    side: input.side, intendedLots: input.intendedSizeLots, filledLots: input.filledLots,
    decisionPrice: input.decisionPrice,
    postSignalMaxFavorablePrice: input.postSignalMaxFavorablePrice,
    pipSize: input.pipSize,
  });
  const bench = benchmarkExecution({
    side: input.side, fillPrice: input.fillPrice,
    arrivalPrice: input.arrivalPrice, decisionPrice: input.decisionPrice,
    spreadAtSignalPips: input.spreadAtSignalPips, spreadAtFillPips: input.spreadAtFillPips,
    latencyAtDecisionMs: input.latencyAtDecisionMs, latencyAtFillMs: input.latencyAtFillMs,
    pipSize: input.pipSize,
  });
  const quality = gradeExecutionQuality({
    implementationShortfallPips: is.totalShortfallPips,
    expectedEdgePips: input.expectedEdgePips,
    fillRatio01,
    rejected: input.rejected, requoted: input.requoted,
  });

  if (input.rejected) anomalies.push("order REJECTED by broker");
  if (input.requoted) anomalies.push("order REQUOTED by broker");
  if (fillRatio01 === 0 && !input.rejected) anomalies.push("zero fill (no rejection)");
  if (fillRatio01 < 1 && fillRatio01 > 0) anomalies.push(`partial fill ${(fillRatio01 * 100).toFixed(0)}%`);
  if (bench.arrivalPriceSlippagePips > 5) anomalies.push(`arrival slippage ${bench.arrivalPriceSlippagePips.toFixed(1)}p`);
  if (bench.latencyDeltaMs > 1000) anomalies.push(`fill latency ${bench.latencyDeltaMs.toFixed(0)}ms over decision`);
  if (bench.spreadDeltaPips > input.spreadAtSignalPips) anomalies.push(`spread doubled by fill`);

  // Helped or hurt vs edge.
  let helpedOrHurt: PostTradeExecutionReport["helpedOrHurt"];
  const isOverEdge = is.totalShortfallPips / Math.max(1e-9, input.expectedEdgePips);
  if (input.rejected || isOverEdge >= 1)         helpedOrHurt = "DESTROYED";
  else if (isOverEdge >= 0.30)                   helpedOrHurt = "HURT";
  else if (Math.abs(isOverEdge) <= 0.05 && bench.arrivalPriceSlippagePips <= 0)
                                                 helpedOrHurt = "HELPED";
  else                                           helpedOrHurt = "NEUTRAL";

  // Verdict mapping.
  let verdict: ExecutionVerdict;
  if (input.rejected || helpedOrHurt === "DESTROYED")        verdict = "EXECUTION_BLOCKED";
  else if (input.requoted || quality.grade === "F")          verdict = "EXECUTION_UNSTABLE";
  else if (quality.grade === "D" || helpedOrHurt === "HURT") verdict = "EXECUTION_COSTLY";
  else if (quality.grade === "B" || quality.grade === "C")   verdict = "EXECUTION_ACCEPTABLE";
  else                                                       verdict = "EXECUTION_CLEAN";

  reasons.push(`IS ${is.totalShortfallPips.toFixed(2)}p (${is.totalShortfallUsd.toFixed(2)} USD), grade ${quality.grade}, verdict ${verdict}, ${helpedOrHurt}`);
  reasons.push(`benchmarks: arrival Δ ${bench.arrivalPriceSlippagePips.toFixed(2)}p, decision Δ ${bench.decisionPriceSlippagePips.toFixed(2)}p, spread Δ ${bench.spreadDeltaPips.toFixed(2)}p, latency Δ ${bench.latencyDeltaMs.toFixed(0)}ms`);
  reasons.push(`effective spread ${effective.toFixed(2)}p, realized spread ${realized.toFixed(2)}p, impact ${impact.toFixed(2)}p`);

  return {
    decisionId: input.decisionId,
    symbolId: input.symbolId, brokerId: input.brokerId,
    strategyId: input.strategyId, session: input.session,
    fillRatio01,
    implementationShortfallPips: is.totalShortfallPips,
    implementationShortfallUsd:  is.totalShortfallUsd,
    effectiveSpreadPips: effective,
    realizedSpreadPips:  realized,
    marketImpactPips:    impact,
    timingRiskPips:      timing,
    opportunityCostPips: opp,
    arrivalPriceSlippagePips:  bench.arrivalPriceSlippagePips,
    decisionPriceSlippagePips: bench.decisionPriceSlippagePips,
    spreadDeltaPips: bench.spreadDeltaPips,
    latencyDeltaMs:  bench.latencyDeltaMs,
    helpedOrHurt,
    grade:   quality.grade,
    verdict,
    reasons, anomalies,
  };
}
