import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Ecosystem Stress — coordinated stress test across multiple stress
// dimensions (volatility shock, liquidity drought, correlation regime
// change). Returns a 0..1 stress score and the worst-axis driver.
// ═══════════════════════════════════════════════════════════════════════════

export const StressAxisSchema = z.object({
  axis: z.enum(["VOLATILITY_SHOCK", "LIQUIDITY_DROUGHT", "CORRELATION_REGIME", "EXECUTION_OUTAGE"]),
  intensity01: z.number().min(0).max(1),
});
export type StressAxis = z.infer<typeof StressAxisSchema>;

export const EcosystemStressInputsSchema = z.object({
  axes: z.array(StressAxisSchema).min(1),
  ecosystemFitness01: z.number().min(0).max(1),
  reservesFraction01: z.number().min(0).max(1),
});
export type EcosystemStressInputs = z.infer<typeof EcosystemStressInputsSchema>;

export interface EcosystemStressReport {
  stress01: number;
  worstAxis: string;
  systemBreaks: boolean;
  reasons: string[];
  blockers: string[];
}

export function evaluateEcosystemStress(i: EcosystemStressInputs): EcosystemStressReport {
  const reasons: string[] = [];
  const blockers: string[] = [];
  let worst = i.axes[0]!;
  for (const a of i.axes) if (a.intensity01 > worst.intensity01) worst = a;
  // Combined stress: max-axis dominates; resilience reduces it.
  const resilience = i.ecosystemFitness01 * 0.6 + i.reservesFraction01 * 0.4;
  const stress01 = Math.max(0, Math.min(1, worst.intensity01 - resilience * 0.5));
  const systemBreaks = stress01 >= 0.7;
  if (systemBreaks) blockers.push(`ecosystem stress ${stress01.toFixed(2)} ≥ break threshold 0.70 — system would not survive`);
  reasons.push(`worst axis ${worst.axis}@${worst.intensity01.toFixed(2)}, resilience ${resilience.toFixed(2)} → stress ${stress01.toFixed(3)}`);
  return { stress01, worstAxis: worst.axis, systemBreaks, reasons, blockers };
}
