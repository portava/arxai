import {
  type OrderContext, type ExecutionStress, type ExecutionStressLevel, clamp01,
} from "./executionMicrostructure.types";

// ═══════════════════════════════════════════════════════════════════════════
// Execution Stress — composite [0,1] of microstructure tension. Inputs:
// spread inflation, volatility, volume burst, news. Maps to a 4-level
// label. Pure.
// ═══════════════════════════════════════════════════════════════════════════

export function computeExecutionStress(o: OrderContext): ExecutionStress {
  const reasons: string[] = [];
  const spreadInflation01 = clamp01(o.avgSpreadPips > 0 ? (o.spreadPips / o.avgSpreadPips - 1) / 3 : 0);
  const vol01    = clamp01(Math.max(0, o.recentVolatilityZ) / 3);
  const burst01  = clamp01(Math.abs(o.recentVolumeZ) / 3);
  const news01   = o.newsActiveWindow ? 1 : 0;
  const score01 = clamp01(0.35 * spreadInflation01 + 0.30 * vol01 + 0.15 * burst01 + 0.20 * news01);
  reasons.push(`spreadInfl ${spreadInflation01.toFixed(2)} · vol ${vol01.toFixed(2)} · burst ${burst01.toFixed(2)} · news ${news01} → score ${score01.toFixed(2)}`);

  const level: ExecutionStressLevel =
      score01 >= 0.80 ? "CRITICAL"
    : score01 >= 0.55 ? "HIGH"
    : score01 >= 0.30 ? "ELEVATED"
    : "CALM";
  reasons.push(`level ${level}`);
  return { level, score01, reasons };
}
