import type {
  ConditionEvaluation, EvaluationContext, LiquiditySweepParamsSchema,
} from "../conditionalExecution.types";
import type { z } from "zod/v4";

type Params = z.infer<typeof LiquiditySweepParamsSchema>;

// liquiditySweep — wait for a sweep of a liquidity pool then reversal.
// HIGH side: price must push ABOVE poolPrice by ≥ minPenetrationPips,
//   then reverse back DOWN by ≥ reversalPips from the post-arm peak.
// LOW side: symmetric — push below, reverse up.
//
// PERMANENTLY_IMPOSSIBLE if penetration exceeds invalidationPips without
// the required reversal (treated as a breakout, not a sweep).
export function evaluateLiquiditySweep(
  params: Params,
  ctx: EvaluationContext,
): ConditionEvaluation {
  const ticks = ctx.recentTicks;
  if (ticks.length === 0) {
    return { kind: "LIQUIDITY_SWEEP", status: "PENDING", reasons: ["no ticks observed since arming"] };
  }
  const prices = ticks.map((t) => t.currentPrice);

  if (params.side === "HIGH") {
    const peak = Math.max(...prices);
    const penetrationPips = (peak - params.poolPrice) / ctx.pipSize;

    if (penetrationPips < params.minPenetrationPips) {
      return {
        kind: "LIQUIDITY_SWEEP", status: "PENDING",
        reasons: [`peak ${penetrationPips.toFixed(1)}p past pool < min ${params.minPenetrationPips}p`],
      };
    }
    if (penetrationPips > params.invalidationPips) {
      // Check if reversal happened BEFORE invalidation: if low after peak is
      // already back enough to satisfy reversal AND peak is past invalidation,
      // we still call this a successful sweep (the reversal qualifies).
      const peakIdx = prices.indexOf(peak);
      const postPeak = prices.slice(peakIdx);
      const trough = Math.min(...postPeak);
      const reversalPips = (peak - trough) / ctx.pipSize;
      if (reversalPips >= params.reversalPips) {
        return {
          kind: "LIQUIDITY_SWEEP", status: "SATISFIED",
          reasons: [`HIGH sweep — penetrated ${penetrationPips.toFixed(1)}p, reversed ${reversalPips.toFixed(1)}p ≥ ${params.reversalPips}p`],
        };
      }
      return {
        kind: "LIQUIDITY_SWEEP", status: "PERMANENTLY_IMPOSSIBLE",
        reasons: [`penetration ${penetrationPips.toFixed(1)}p > invalidation ${params.invalidationPips}p without reversal — broke through, not swept`],
      };
    }
    // In sweep zone — check reversal
    const peakIdx = prices.indexOf(peak);
    const postPeak = prices.slice(peakIdx);
    const trough = Math.min(...postPeak);
    const reversalPips = (peak - trough) / ctx.pipSize;
    if (reversalPips >= params.reversalPips) {
      return {
        kind: "LIQUIDITY_SWEEP", status: "SATISFIED",
        reasons: [`HIGH sweep — penetrated ${penetrationPips.toFixed(1)}p, reversed ${reversalPips.toFixed(1)}p ≥ ${params.reversalPips}p`],
      };
    }
    return {
      kind: "LIQUIDITY_SWEEP", status: "PENDING",
      reasons: [`penetrated ${penetrationPips.toFixed(1)}p but reversal only ${reversalPips.toFixed(1)}p < ${params.reversalPips}p`],
    };
  }

  // ── LOW side (symmetric) ───────────────────────────────────────────────
  const trough = Math.min(...prices);
  const penetrationPips = (params.poolPrice - trough) / ctx.pipSize;

  if (penetrationPips < params.minPenetrationPips) {
    return {
      kind: "LIQUIDITY_SWEEP", status: "PENDING",
      reasons: [`trough ${penetrationPips.toFixed(1)}p past pool < min ${params.minPenetrationPips}p`],
    };
  }

  const troughIdx = prices.indexOf(trough);
  const postTrough = prices.slice(troughIdx);
  const peakAfter = Math.max(...postTrough);
  const reversalPips = (peakAfter - trough) / ctx.pipSize;

  if (penetrationPips > params.invalidationPips && reversalPips < params.reversalPips) {
    return {
      kind: "LIQUIDITY_SWEEP", status: "PERMANENTLY_IMPOSSIBLE",
      reasons: [`penetration ${penetrationPips.toFixed(1)}p > invalidation ${params.invalidationPips}p without reversal — broke through, not swept`],
    };
  }
  if (reversalPips >= params.reversalPips) {
    return {
      kind: "LIQUIDITY_SWEEP", status: "SATISFIED",
      reasons: [`LOW sweep — penetrated ${penetrationPips.toFixed(1)}p, reversed ${reversalPips.toFixed(1)}p ≥ ${params.reversalPips}p`],
    };
  }
  return {
    kind: "LIQUIDITY_SWEEP", status: "PENDING",
    reasons: [`penetrated ${penetrationPips.toFixed(1)}p but reversal only ${reversalPips.toFixed(1)}p < ${params.reversalPips}p`],
  };
}
