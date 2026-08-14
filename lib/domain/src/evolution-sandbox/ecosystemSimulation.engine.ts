import { z } from "zod/v4";
import { CorrelatedFailureInputsSchema, simulateCorrelatedFailure } from "./correlatedFailureScenario.engine";
import { MassDisagreementInputsSchema, simulateMassDisagreement } from "./massDisagreementScenario.engine";
import { EcosystemStressInputsSchema, evaluateEcosystemStress } from "./ecosystemStress.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Ecosystem Simulation — orchestrates the three sandbox scenarios in one
// roll-up. PROJECT RULE: sandbox evolution must simulate ECOSYSTEM-WIDE
// stress, not isolated strategies. This engine enforces that gate.
// ═══════════════════════════════════════════════════════════════════════════

export const EcosystemSimInputsSchema = z.object({
  mode: z.enum(["SANDBOX", "SHADOW", "LIVE"]),
  failure: CorrelatedFailureInputsSchema,
  disagreement: MassDisagreementInputsSchema,
  stress: EcosystemStressInputsSchema,
});
export type EcosystemSimInputs = z.infer<typeof EcosystemSimInputsSchema>;

export interface EcosystemSimulationResult {
  passed: boolean;
  failure: ReturnType<typeof simulateCorrelatedFailure>;
  disagreement: ReturnType<typeof simulateMassDisagreement>;
  stress: ReturnType<typeof evaluateEcosystemStress>;
  reasons: string[];
  blockers: string[];
}

export function runEcosystemSimulation(i: EcosystemSimInputs): EcosystemSimulationResult {
  const reasons: string[] = [];
  const blockers: string[] = [];
  if (i.mode !== "SANDBOX") {
    blockers.push(`mode ${i.mode} ≠ SANDBOX — ecosystem simulation refused`);
    reasons.push(`refused — sandbox-only`);
    const dummy = simulateCorrelatedFailure(i.failure);
    return {
      passed: false,
      failure: { ...dummy, blockers: [...dummy.blockers, "mode!=SANDBOX"] },
      disagreement: simulateMassDisagreement(i.disagreement),
      stress: evaluateEcosystemStress(i.stress),
      reasons,
      blockers,
    };
  }
  const failure = simulateCorrelatedFailure(i.failure);
  const disagreement = simulateMassDisagreement(i.disagreement);
  const stress = evaluateEcosystemStress(i.stress);
  blockers.push(...failure.blockers, ...stress.blockers);
  if (disagreement.paralysis) blockers.push(`mass-disagreement paralysis — system cannot decide`);
  const passed = blockers.length === 0;
  reasons.push(passed ? "ecosystem simulation PASSED" : `ecosystem simulation FAILED (${blockers.length} blocker[s])`);
  return { passed, failure, disagreement, stress, reasons, blockers };
}
