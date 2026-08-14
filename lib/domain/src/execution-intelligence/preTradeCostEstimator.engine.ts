// ═══════════════════════════════════════════════════════════════════════════
// Pre-trade Cost Estimator
//
// Estimates expected execution cost BEFORE order send, in pips and USD,
// then compares it to the strategy's expected edge. If estimated cost
// destroys or materially erodes the edge, the trade is blocked or reduced.
//
// Components (all in pips, additive):
//   • spread cost      = spread / 2                          (one half-spread one way)
//   • slippage cost    = base × sizeMult × volMult × newsMult
//   • market impact    = α × max(0, sizeLots/depthLots − 1)  (book-walking)
//   • timing risk      = vol × √holdMinutes                  (price drift while waiting)
//   • opportunity cost = small constant for limit-only conditions (handled by caller)
//
// Verdict ladder (after edge comparison):
//   • cost > 1.00 × edge          → EXECUTION_BLOCKED      / HARD_BLOCK
//   • cost > 0.66 × edge          → EXECUTION_COSTLY       / WAIT
//   • cost > 0.40 × edge          → EXECUTION_COSTLY       / REDUCE_SIZE×0.5
//   • cost > 0.20 × edge          → EXECUTION_ACCEPTABLE   / LIMIT_ONLY
//   • otherwise                   → EXECUTION_CLEAN        / EXECUTE
//
// Pure. Never throws.
// ═══════════════════════════════════════════════════════════════════════════

import {
  type PreTradeInput, type PreTradeCostEstimate, type CostBreakdown,
  clamp01,
} from "./executionIntelligence.types";

const NEWS_MULT = 1.75;
const MARKET_IMPACT_ALPHA = 1.5;

export function estimatePreTradeCost(input: PreTradeInput): PreTradeCostEstimate {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];

  const spreadCostPips = input.spreadAtSignalPips / 2;
  const sizeMult = input.topBookDepthLots > 0
    ? 1 + Math.max(0, input.intendedSizeLots / input.topBookDepthLots - 1)
    : 5;
  const volMult  = 1 + 0.5 * Math.max(0, input.recentVolatilityPipsPerMin);
  const newsMult = input.newsActiveWindow ? NEWS_MULT : 1;
  const baseSlip = input.spreadAtSignalPips / 2;
  const slippageCostPips = baseSlip * sizeMult * volMult * newsMult;

  const marketImpactPips = input.topBookDepthLots > 0
    ? MARKET_IMPACT_ALPHA * Math.max(0, input.intendedSizeLots / input.topBookDepthLots - 1)
    : MARKET_IMPACT_ALPHA * 2;
  const timingRiskPips = input.recentVolatilityPipsPerMin * Math.sqrt(Math.max(0, input.expectedHoldMinutes));

  const opportunityCostPips = 0;
  const totalCostPips = spreadCostPips + slippageCostPips + marketImpactPips + timingRiskPips + opportunityCostPips;
  const totalCostUsd = totalCostPips * input.pipValuePerLotUsd * input.intendedSizeLots;

  const expectedCost: CostBreakdown = {
    spreadCostPips, slippageCostPips, marketImpactPips,
    timingRiskPips, opportunityCostPips, totalCostPips, totalCostUsd,
  };

  reasons.push(
    `spread ${spreadCostPips.toFixed(2)}p + slip ${slippageCostPips.toFixed(2)}p + impact ${marketImpactPips.toFixed(2)}p + timing ${timingRiskPips.toFixed(2)}p = ${totalCostPips.toFixed(2)}p (${totalCostUsd.toFixed(2)}USD)`,
  );

  const edgeAfterCostPips = input.expectedEdgePips - totalCostPips;
  const edgeRatio = input.expectedEdgePips > 0 ? totalCostPips / input.expectedEdgePips : Infinity;
  reasons.push(`edge ${input.expectedEdgePips.toFixed(2)}p − cost ${totalCostPips.toFixed(2)}p = ${edgeAfterCostPips.toFixed(2)}p (cost/edge ${Number.isFinite(edgeRatio) ? edgeRatio.toFixed(2) : "∞"})`);

  let verdict: PreTradeCostEstimate["verdict"];
  let recommendation: PreTradeCostEstimate["recommendation"];
  let recommendedSizeMultiplier = 1;
  const edgeDestroyed = input.expectedEdgePips <= 0 || edgeAfterCostPips <= 0 || edgeRatio > 1;

  if (edgeDestroyed) {
    blockers.push(`expected cost destroys edge (cost ${totalCostPips.toFixed(2)}p ≥ edge ${input.expectedEdgePips.toFixed(2)}p)`);
    verdict = "EXECUTION_BLOCKED";
    recommendation = "HARD_BLOCK";
    recommendedSizeMultiplier = 0;
  } else if (edgeRatio > 0.66) {
    verdict = "EXECUTION_COSTLY";
    recommendation = "WAIT";
    recommendedSizeMultiplier = 0;
    warnings.push(`cost/edge ${edgeRatio.toFixed(2)} > 0.66 — wait`);
  } else if (edgeRatio > 0.40) {
    verdict = "EXECUTION_COSTLY";
    recommendation = "REDUCE_SIZE";
    recommendedSizeMultiplier = 0.5;
    warnings.push(`cost/edge ${edgeRatio.toFixed(2)} > 0.40 — reduce size`);
  } else if (edgeRatio > 0.20) {
    verdict = "EXECUTION_ACCEPTABLE";
    recommendation = "LIMIT_ONLY";
    recommendedSizeMultiplier = clamp01(1);
    warnings.push(`cost/edge ${edgeRatio.toFixed(2)} > 0.20 — limit-only`);
  } else {
    verdict = "EXECUTION_CLEAN";
    recommendation = "EXECUTE";
  }

  if (input.newsActiveWindow) warnings.push(`news window active — slippage 1.75×`);
  if (input.intendedSizeLots > input.topBookDepthLots && input.topBookDepthLots > 0) {
    warnings.push(`size ${input.intendedSizeLots} > top-book depth ${input.topBookDepthLots}`);
  }

  return {
    decisionId: input.decisionId,
    expectedCost, edgeAfterCostPips, edgeDestroyed,
    recommendedSizeMultiplier, verdict, recommendation,
    reasons, warnings, blockers,
  };
}
