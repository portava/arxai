import { z } from "zod/v4";
import { SpeciesSchema, type Species } from "./speciesClassification.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Ecosystem Balance — does the population mix avoid monoculture? Reports
// Shannon-like diversity in [0,1] and flags species over-concentration.
// PROJECT RULE: a healthy ecosystem must not collapse to one species.
// ═══════════════════════════════════════════════════════════════════════════

export const SpeciesPopulationSchema = z.object({
  species: SpeciesSchema,
  capitalSharePct: z.number().min(0).max(100),
  count: z.int().nonnegative(),
});
export type SpeciesPopulation = z.infer<typeof SpeciesPopulationSchema>;

export const EcosystemBalanceInputsSchema = z.object({
  populations: z.array(SpeciesPopulationSchema).min(1),
  monocultureCapShare01: z.number().min(0).max(1).default(0.6),
});
export type EcosystemBalanceInputs = z.infer<typeof EcosystemBalanceInputsSchema>;

export interface EcosystemBalanceReport {
  diversity01: number;
  dominantSpecies: Species;
  dominantShare01: number;
  monocultureRisk: boolean;
  reasons: string[];
  blockers: string[];
}

export function evaluateEcosystemBalance(
  i: EcosystemBalanceInputs,
): EcosystemBalanceReport {
  const reasons: string[] = [];
  const blockers: string[] = [];
  // Use capital share as the population weight.
  const total = i.populations.reduce((s, p) => s + p.capitalSharePct, 0) || 1;
  let H = 0;
  let dominant = i.populations[0]!;
  for (const p of i.populations) {
    if (p.capitalSharePct > dominant.capitalSharePct) dominant = p;
    const f = p.capitalSharePct / total;
    if (f > 0) H -= f * Math.log(f);
  }
  // Shannon max with N species = ln(N).
  const maxH = Math.log(i.populations.length || 1) || 1;
  const diversity01 = Math.max(0, Math.min(1, H / maxH));
  const dominantShare01 = dominant.capitalSharePct / total;
  const monocultureRisk = dominantShare01 >= i.monocultureCapShare01;
  if (monocultureRisk) {
    blockers.push(`monoculture: ${dominant.species} holds ${(dominantShare01 * 100).toFixed(1)}% capital share (cap ${(i.monocultureCapShare01 * 100).toFixed(0)}%)`);
  }
  reasons.push(`diversity=${diversity01.toFixed(3)}, dominant=${dominant.species}@${(dominantShare01 * 100).toFixed(1)}%`);
  return {
    diversity01,
    dominantSpecies: dominant.species,
    dominantShare01,
    monocultureRisk,
    reasons,
    blockers,
  };
}
