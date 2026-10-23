import { z } from "zod/v4";
import { clamp01 } from "../portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Diversification — inverse-HHI across symbols × strategies × sessions.
// 1 = well diversified, 0 = perfectly concentrated.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const DiversificationInputSchema = z.object({
  perSymbolRiskR: z.record(z.string(), z.number().nonnegative()),
  perStrategyRiskR: z.record(z.string(), z.number().nonnegative()),
  perSessionRiskR: z.record(z.string(), z.number().nonnegative()),
}).strict();
export type DiversificationInput = z.infer<typeof DiversificationInputSchema>;

export interface DiversificationOutput {
  diversification01: number;
  effectiveCounts: { symbols: number; strategies: number; sessions: number };
  reasons: string[];
}

function effectiveN(values: Record<string, number>): number {
  const total = Object.values(values).reduce((s, v) => s + v, 0);
  if (total <= 0) return 0;
  let sumSq = 0;
  for (const v of Object.values(values)) {
    const share = v / total;
    sumSq += share * share;
  }
  // Inverse-HHI is the effective number of equally-weighted buckets.
  return sumSq > 0 ? 1 / sumSq : 0;
}

export function computeDiversification(i: DiversificationInput): DiversificationOutput {
  const sym = effectiveN(i.perSymbolRiskR);
  const strat = effectiveN(i.perStrategyRiskR);
  const sess = effectiveN(i.perSessionRiskR);
  // Normalize each to [0,1] by squashing log(N+1).
  const sq = (n: number) => clamp01(Math.log(n + 1) / Math.log(11)); // 10 buckets → ~1
  const composite = clamp01(0.40 * sq(sym) + 0.30 * sq(strat) + 0.30 * sq(sess));
  return {
    diversification01: composite,
    effectiveCounts: { symbols: sym, strategies: strat, sessions: sess },
    reasons: [
      `effectiveN sym ${sym.toFixed(2)}, strat ${strat.toFixed(2)}, sess ${sess.toFixed(2)}`,
      `diversification ${composite.toFixed(3)}`,
    ],
  };
}
