import { z } from "zod/v4";
import { clamp01 } from "../portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Concentration Risk — Herfindahl-style index across symbols, strategies,
// and sessions. 0 = perfectly diversified, 1 = single-bucket concentration.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const ConcentrationInputSchema = z.object({
  perSymbolRiskR: z.record(z.string(), z.number().nonnegative()),
  perStrategyRiskR: z.record(z.string(), z.number().nonnegative()),
  perSessionRiskR: z.record(z.string(), z.number().nonnegative()),
}).strict();
export type ConcentrationInput = z.infer<typeof ConcentrationInputSchema>;

export interface ConcentrationOutput {
  symbolHHI01: number;
  strategyHHI01: number;
  sessionHHI01: number;
  concentrationIndex01: number;
  reasons: string[];
}

function hhi(values: Record<string, number>): number {
  const total = Object.values(values).reduce((s, v) => s + v, 0);
  if (total <= 0) return 0;
  let sum = 0;
  for (const v of Object.values(values)) {
    const share = v / total;
    sum += share * share;
  }
  // HHI ranges from 1/n (uniform) to 1 (max). Normalize to 0..1: use raw value.
  return clamp01(sum);
}

export function computeConcentrationRisk(i: ConcentrationInput): ConcentrationOutput {
  const sym = hhi(i.perSymbolRiskR);
  const strat = hhi(i.perStrategyRiskR);
  const sess = hhi(i.perSessionRiskR);
  const composite = clamp01(0.40 * sym + 0.30 * strat + 0.30 * sess);
  return {
    symbolHHI01: sym,
    strategyHHI01: strat,
    sessionHHI01: sess,
    concentrationIndex01: composite,
    reasons: [
      `HHI symbol ${sym.toFixed(3)}, strategy ${strat.toFixed(3)}, session ${sess.toFixed(3)}`,
      `concentrationIndex ${composite.toFixed(3)}`,
    ],
  };
}
