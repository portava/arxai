import {
  type OrderContext, type OrderQualityReport, type OrderQualityVerdict,
  type SlippagePrediction, type SpreadVerdict, type FillProbability,
  type LiquidityVerdict, type ExecutionStress, type BrokerReliability,
  clamp01, clampNonNegative,
} from "./executionMicrostructure.types";

// ═══════════════════════════════════════════════════════════════════════════
// Order Quality — final pre-execution composite. Aggregates all sub-verdicts
// into one of: APPROVED / REDUCE_SIZE / DELAY / BLOCKED + a recommended
// size in lots. Pure.
//
// Decision tree:
//   • Any HARD blocker (spread, liquidity, broker) → BLOCKED, size=0
//   • CRITICAL execution stress OR broker reliability < 0.40 → BLOCKED
//   • Slippage > 0.5 × stopLossPips → BLOCKED (would invalidate the trade)
//   • HIGH stress OR fill prob < 0.55 → DELAY
//   • Liquidity shortfall (but partial fillable) → REDUCE_SIZE to fillable
//   • Slippage > 0.25 × stopLoss OR fillProb < 0.75 → REDUCE_SIZE × 0.5
//   • Otherwise APPROVED at intended size
// ═══════════════════════════════════════════════════════════════════════════

export interface OrderQualityInput {
  order: OrderContext;
  slippage: SlippagePrediction;
  spread: SpreadVerdict;
  fill: FillProbability;
  liquidity: LiquidityVerdict;
  stress: ExecutionStress;
  broker: BrokerReliability;
}

export function reportOrderQuality(input: OrderQualityInput): OrderQualityReport {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const o = input.order;

  // Aggregate hard blockers.
  blockers.push(...input.spread.blockers, ...input.liquidity.blockers, ...input.broker.blockers);
  if (input.stress.level === "CRITICAL") blockers.push(`execution stress CRITICAL (${input.stress.score01.toFixed(2)})`);
  if (input.broker.reliability01 < 0.40) blockers.push(`broker reliability ${input.broker.reliability01.toFixed(2)} < 0.40`);
  if (input.slippage.worstCaseSlippagePips > 0.5 * o.stopLossPips) {
    blockers.push(`worst-case slippage ${input.slippage.worstCaseSlippagePips.toFixed(1)}p > 50% of stop ${o.stopLossPips}p`);
  }

  // Quality score for observability.
  const slipPenalty = clamp01(input.slippage.expectedSlippagePips / Math.max(1, o.stopLossPips));
  const qualityScore01 = clamp01(
      0.30 * (input.spread.acceptable ? 1 : 0)
    + 0.20 * input.fill.probability01
    + 0.20 * (input.liquidity.sufficient ? 1 : 0)
    + 0.15 * (1 - input.stress.score01)
    + 0.15 * input.broker.reliability01
    - 0.20 * slipPenalty,
  );

  if (blockers.length > 0) {
    reasons.push(`BLOCKED — ${blockers.length} hard guardrail(s)`);
    return { verdict: "BLOCKED", recommendedSizeLots: 0, qualityScore01, reasons, blockers };
  }

  let verdict: OrderQualityVerdict = "APPROVED";
  let size = o.intendedSizeLots;

  if (input.stress.level === "HIGH" || input.fill.probability01 < 0.55) {
    verdict = "DELAY";
    reasons.push(`DELAY — stress ${input.stress.level}, fill ${input.fill.probability01.toFixed(2)}`);
    return { verdict, recommendedSizeLots: 0, qualityScore01, reasons, blockers };
  }

  if (!input.liquidity.sufficient && input.liquidity.fillableLots > 0) {
    verdict = "REDUCE_SIZE";
    size = clampNonNegative(input.liquidity.fillableLots);
    reasons.push(`REDUCE_SIZE — liquidity fillable ${size.toFixed(2)}lots`);
  } else if (input.slippage.expectedSlippagePips > 0.25 * o.stopLossPips || input.fill.probability01 < 0.75) {
    verdict = "REDUCE_SIZE";
    size = clampNonNegative(o.intendedSizeLots * 0.5);
    reasons.push(`REDUCE_SIZE × 0.5 — slippage or fill below comfort`);
  } else {
    reasons.push(`APPROVED — quality ${qualityScore01.toFixed(2)}`);
  }

  return { verdict, recommendedSizeLots: size, qualityScore01, reasons, blockers };
}
