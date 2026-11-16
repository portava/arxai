import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Species Classification — group strategies into ecological "species" based
// on their behavioral fingerprint. Used by ecosystemBalance to enforce a
// minimum diversity floor.
// ═══════════════════════════════════════════════════════════════════════════

export const SpeciesSchema = z.enum([
  "TREND_FOLLOWER",
  "MEAN_REVERSION",
  "BREAKOUT",
  "LIQUIDITY_HUNTER",
  "VOLATILITY_HARVESTER",
  "ARBITRAGE",
  "UNKNOWN",
]);
export type Species = z.infer<typeof SpeciesSchema>;

export const SpeciesFingerprintSchema = z.object({
  strategyId: z.string().min(1),
  // Normalised behavioral axes in [0,1].
  trendBias01: z.number().min(0).max(1),
  meanReversionBias01: z.number().min(0).max(1),
  breakoutBias01: z.number().min(0).max(1),
  liquidityBias01: z.number().min(0).max(1),
  volatilityBias01: z.number().min(0).max(1),
  arbitrageBias01: z.number().min(0).max(1),
});
export type SpeciesFingerprint = z.infer<typeof SpeciesFingerprintSchema>;

export interface SpeciesClassification {
  strategyId: string;
  species: Species;
  confidence01: number;
  reasons: string[];
}

export function classifySpecies(i: SpeciesFingerprint): SpeciesClassification {
  const axes: { species: Species; v: number }[] = [
    { species: "TREND_FOLLOWER",       v: i.trendBias01 },
    { species: "MEAN_REVERSION",       v: i.meanReversionBias01 },
    { species: "BREAKOUT",             v: i.breakoutBias01 },
    { species: "LIQUIDITY_HUNTER",     v: i.liquidityBias01 },
    { species: "VOLATILITY_HARVESTER", v: i.volatilityBias01 },
    { species: "ARBITRAGE",            v: i.arbitrageBias01 },
  ];
  axes.sort((a, b) => b.v - a.v);
  const top = axes[0]!;
  const second = axes[1]!;
  const margin = top.v - second.v;
  const species: Species = top.v < 0.25 ? "UNKNOWN" : top.species;
  const confidence01 = Math.max(0, Math.min(1, margin * 2));
  return {
    strategyId: i.strategyId,
    species,
    confidence01,
    reasons: [`top=${top.species}@${top.v.toFixed(2)}, second=${second.species}@${second.v.toFixed(2)}, margin=${margin.toFixed(2)}`],
  };
}
