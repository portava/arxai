import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Civilization Stress Test — extreme, multi-axis tail-event stress test.
// Combines a market shock magnitude, a duration, and a recovery latency to
// produce a "civilization survival" pass/fail.
// ═══════════════════════════════════════════════════════════════════════════

export const CivilizationStressInputsSchema = z.object({
  shockMagnitudeSigma: z.number().min(0),     // e.g. 6 = 6-sigma move
  shockDurationDays: z.number().min(0),
  reservesFraction01: z.number().min(0).max(1),
  ecosystemFitness01: z.number().min(0).max(1),
  recoveryLatencyDays: z.number().min(0),
  catastrophicLossLimitPct: z.number().min(0).max(100),
});
export type CivilizationStressInputs = z.infer<typeof CivilizationStressInputsSchema>;

export interface CivilizationStressResult {
  projectedAccountLossPct: number;
  survives: boolean;
  marginOfSafety01: number;
  reasons: string[];
  blockers: string[];
}

export function runCivilizationStressTest(
  i: CivilizationStressInputs,
): CivilizationStressResult {
  const reasons: string[] = [];
  const blockers: string[] = [];
  // Crude projected loss model: shock magnitude * duration scaling, dampened
  // by reserves and fitness, amplified by recovery latency.
  const shockEnergy = i.shockMagnitudeSigma * Math.sqrt(1 + i.shockDurationDays);
  const damping = i.reservesFraction01 * 0.6 + i.ecosystemFitness01 * 0.4;
  const latencyMul = 1 + Math.min(1, i.recoveryLatencyDays / 30) * 0.5;
  const projectedAccountLossPct = Math.max(0, Math.min(100,
    shockEnergy * (1 - damping) * latencyMul,
  ));
  const survives = projectedAccountLossPct < i.catastrophicLossLimitPct;
  const marginOfSafety01 = Math.max(0, Math.min(1,
    (i.catastrophicLossLimitPct - projectedAccountLossPct) / Math.max(1, i.catastrophicLossLimitPct),
  ));
  if (!survives) {
    blockers.push(`projected loss ${projectedAccountLossPct.toFixed(2)}% ≥ catastrophic limit ${i.catastrophicLossLimitPct}%`);
  }
  reasons.push(
    `shockEnergy=${shockEnergy.toFixed(2)}, damping=${damping.toFixed(2)}, latencyMul=${latencyMul.toFixed(2)} → loss ${projectedAccountLossPct.toFixed(2)}%`,
    `survives=${survives}, marginOfSafety=${marginOfSafety01.toFixed(3)}`,
  );
  return { projectedAccountLossPct, survives, marginOfSafety01, reasons, blockers };
}
