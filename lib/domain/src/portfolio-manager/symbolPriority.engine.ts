import {
  type SymbolContext, type SymbolPriority, type RiskBudget, clamp01,
} from "./portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Symbol Priority — composite [0,1] over (regimeRelevance, recentExpectancy
// via tanh, executionQuality, liquidity). Each symbol gets a riskR cap =
// priority × perSymbolCapR (still subject to the global per-symbol cap).
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_SYMBOL_WEIGHTS = {
  regimeRelevance: 0.35,
  performance:     0.30,
  executionQuality: 0.20,
  liquidity:       0.15,
} as const;
export type SymbolWeights = typeof DEFAULT_SYMBOL_WEIGHTS;

export function computeSymbolPriorities(
  symbols: ReadonlyArray<SymbolContext>,
  riskBudget: RiskBudget,
  weights: SymbolWeights = DEFAULT_SYMBOL_WEIGHTS,
): ReadonlyArray<SymbolPriority> {
  const wSum = weights.regimeRelevance + weights.performance + weights.executionQuality + weights.liquidity;
  return symbols.map((s) => {
    const reasons: string[] = [];
    const perfTanh = (Math.tanh(s.recentExpectancyR) + 1) / 2;
    const raw =
        clamp01(s.regimeRelevance01)  * weights.regimeRelevance
      + perfTanh                       * weights.performance
      + clamp01(s.executionQuality01) * weights.executionQuality
      + clamp01(s.liquidity01)        * weights.liquidity;
    const priority01 = clamp01(wSum > 0 ? raw / wSum : 0);
    const capR = Math.min(riskBudget.perSymbolCapR, priority01 * riskBudget.perSymbolCapR);
    reasons.push(
      `regime ${s.regimeRelevance01.toFixed(2)} · perfTanh ${perfTanh.toFixed(2)} · ` +
      `exec ${s.executionQuality01.toFixed(2)} · liq ${s.liquidity01.toFixed(2)} → ${priority01.toFixed(3)}`);
    reasons.push(`capR ${capR.toFixed(2)}`);
    return { symbolId: s.symbolId, priority01, capR, reasons };
  });
}
