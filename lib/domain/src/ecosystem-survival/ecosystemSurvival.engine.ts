import { z } from "zod/v4";
import { CivilizationStressInputsSchema, runCivilizationStressTest } from "./civilizationStressTest.engine";
import { SystemicRecoveryInputsSchema, evaluateSystemicRecovery } from "./systemicRecovery.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Ecosystem Survival — single advisory survival score in [0,1] for the
// whole system right now. Combines:
//   • Civilization stress-test margin of safety
//   • Systemic recovery score
//   • Current ecosystem fitness
//   • Current systemic fragility (inverted)
//
// PROJECT RULE: ecosystem survival must continuously be measured.
// ═══════════════════════════════════════════════════════════════════════════

export const EcosystemSurvivalInputsSchema = z.object({
  ecosystemFitness01: z.number().min(0).max(1),
  systemicFragility01: z.number().min(0).max(1),
  stressTest: CivilizationStressInputsSchema,
  recovery: SystemicRecoveryInputsSchema,
});
export type EcosystemSurvivalInputs = z.infer<typeof EcosystemSurvivalInputsSchema>;

export interface EcosystemSurvivalReport {
  survival01: number;
  pillars: {
    fitness01: number;
    invertedFragility01: number;
    marginOfSafety01: number;
    recoveryScore01: number;
  };
  stressSurvives: boolean;
  reasons: string[];
  blockers: string[];
}

export function evaluateEcosystemSurvival(
  i: EcosystemSurvivalInputs,
): EcosystemSurvivalReport {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const stress = runCivilizationStressTest(i.stressTest);
  const recovery = evaluateSystemicRecovery(i.recovery);
  const invertedFragility01 = 1 - i.systemicFragility01;
  const survival01 = Math.max(0, Math.min(1,
    i.ecosystemFitness01 * 0.30
    + invertedFragility01 * 0.20
    + stress.marginOfSafety01 * 0.30
    + recovery.recoveryScore01 * 0.20,
  ));
  if (!stress.survives) blockers.push(...stress.blockers);
  blockers.push(...recovery.blockers);
  if (survival01 < 0.3) blockers.push(`ecosystem survival ${survival01.toFixed(3)} < 0.3 — recommend halting all promotions`);
  reasons.push(
    `survival=${survival01.toFixed(3)} (fit ${i.ecosystemFitness01.toFixed(2)}, ¬fragility ${invertedFragility01.toFixed(2)}, margin ${stress.marginOfSafety01.toFixed(2)}, recovery ${recovery.recoveryScore01.toFixed(2)})`,
  );
  return {
    survival01,
    pillars: {
      fitness01: i.ecosystemFitness01,
      invertedFragility01,
      marginOfSafety01: stress.marginOfSafety01,
      recoveryScore01: recovery.recoveryScore01,
    },
    stressSurvives: stress.survives,
    reasons,
    blockers,
  };
}
