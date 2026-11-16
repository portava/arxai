import { z } from "zod/v4";
import { SpeciesSchema, type Species } from "./speciesClassification.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Adaptation Capacity — can this species reorganize when its regime ends?
// Combines historical adaptation success rate, parameter flexibility, and
// validation pipeline depth.
// ═══════════════════════════════════════════════════════════════════════════

export const AdaptationCapacityInputsSchema = z.object({
  species: SpeciesSchema,
  historicalSuccessRate01: z.number().min(0).max(1),
  parameterFlexibility01: z.number().min(0).max(1),
  validationDepth01: z.number().min(0).max(1),
  attemptCount: z.int().nonnegative(),
});
export type AdaptationCapacityInputs = z.infer<typeof AdaptationCapacityInputsSchema>;

export interface AdaptationCapacityResult {
  species: Species;
  capacity01: number;
  reasons: string[];
}

export function evaluateAdaptationCapacity(
  i: AdaptationCapacityInputs,
): AdaptationCapacityResult {
  // Confidence from sample size: 20+ attempts saturates.
  const confidence = Math.min(1, i.attemptCount / 20);
  const capacity01 = Math.max(0, Math.min(1,
    i.historicalSuccessRate01 * 0.45 * confidence
    + i.parameterFlexibility01 * 0.30
    + i.validationDepth01 * 0.25,
  ));
  return {
    species: i.species,
    capacity01,
    reasons: [
      `capacity=${capacity01.toFixed(3)} (success ${i.historicalSuccessRate01.toFixed(2)}×conf ${confidence.toFixed(2)}, flex ${i.parameterFlexibility01.toFixed(2)}, depth ${i.validationDepth01.toFixed(2)})`,
    ],
  };
}
