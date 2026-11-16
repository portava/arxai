import { z } from "zod/v4";
import { SpeciesSchema, type Species } from "./speciesClassification.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Extinction Risk — for a given species, how likely is it to die out under
// current conditions? Inputs include population, trailing performance, and
// regime hostility.
// ═══════════════════════════════════════════════════════════════════════════

export const ExtinctionRiskInputsSchema = z.object({
  species: SpeciesSchema,
  populationCount: z.int().nonnegative(),
  meanExpectancyR: z.number(),
  recentDrawdownPct: z.number().min(0),
  regimeHostility01: z.number().min(0).max(1),
});
export type ExtinctionRiskInputs = z.infer<typeof ExtinctionRiskInputsSchema>;

export interface ExtinctionRiskResult {
  species: Species;
  risk01: number;
  triggers: string[];
  reasons: string[];
}

export function evaluateExtinctionRisk(i: ExtinctionRiskInputs): ExtinctionRiskResult {
  const triggers: string[] = [];
  let r = 0;
  if (i.populationCount <= 1) {
    r += 0.35;
    triggers.push(`population ${i.populationCount} ≤ 1`);
  } else if (i.populationCount <= 3) {
    r += 0.20;
    triggers.push(`population ${i.populationCount} ≤ 3`);
  }
  if (i.meanExpectancyR < 0) {
    r += 0.25;
    triggers.push(`negative species expectancy ${i.meanExpectancyR.toFixed(3)}`);
  }
  if (i.recentDrawdownPct > 10) {
    r += 0.20;
    triggers.push(`drawdown ${i.recentDrawdownPct.toFixed(2)}% > 10%`);
  }
  r += i.regimeHostility01 * 0.20;
  if (i.regimeHostility01 > 0.7) triggers.push(`regime hostility ${i.regimeHostility01.toFixed(2)}`);
  const risk01 = Math.min(1, r);
  return {
    species: i.species,
    risk01,
    triggers,
    reasons: [`extinction risk=${risk01.toFixed(3)} from ${triggers.length} trigger(s)`],
  };
}
