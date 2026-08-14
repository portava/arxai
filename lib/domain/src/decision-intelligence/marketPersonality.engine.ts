import { type MarketPersonality, clamp01 } from "./decisionIntelligence.types";

// ═══════════════════════════════════════════════════════════════════════════
// Market Personality — profile the current market across six independent
// traits given a small bag of rolling indicators. Pure. The dominant trait
// is the highest-magnitude one (or MIXED when no trait clearly leads).
//
// All inputs in [0,1] except autocorr1 ∈ [-1,1].
// ═══════════════════════════════════════════════════════════════════════════

export interface PersonalityInput {
  trendStrength01: number;       // ADX / MA-slope normalised
  rangeBound01: number;          // 1 − trendStrength is fine if absent
  autocorr1: number;             // lag-1 autocorrelation of returns
  realisedVolZ: number;          // z-score of realised vol (may be negative)
  volumeBurstZ: number;          // z-score of volume bursts
  microNoiseRatio01: number;     // tick-level noise / range
  dominantThreshold?: number;    // default 0.10 — gap over runner-up
}

export function profileMarketPersonality(input: PersonalityInput): MarketPersonality {
  const reasons: string[] = [];
  const trending01      = clamp01(input.trendStrength01);
  const meanReverting01 = clamp01((-input.autocorr1 + 1) / 2 * (1 - trending01) + 0.25 * input.rangeBound01);
  const momentum01      = clamp01(((input.autocorr1 + 1) / 2) * trending01);
  const calm01          = clamp01(1 - sigmoid(input.realisedVolZ));
  const frenzy01        = clamp01(sigmoid(input.realisedVolZ) * sigmoid(input.volumeBurstZ));
  const noisy01         = clamp01(input.microNoiseRatio01);

  const traits: { key: MarketPersonality["dominantTrait"]; v: number }[] = [
    { key: "TRENDING",       v: trending01 },
    { key: "MEAN_REVERTING", v: meanReverting01 },
    { key: "MOMENTUM",       v: momentum01 },
    { key: "CALM",           v: calm01 },
    { key: "FRENZY",         v: frenzy01 },
    { key: "NOISY",          v: noisy01 },
  ];
  traits.sort((a, b) => b.v - a.v);
  const top = traits[0]!;
  const second = traits[1]!;
  const gap = (input.dominantThreshold ?? 0.10);
  const dominantTrait: MarketPersonality["dominantTrait"] =
    top.v - second.v >= gap ? top.key : "MIXED";
  reasons.push(`top ${top.key} ${top.v.toFixed(2)} · second ${second.key} ${second.v.toFixed(2)} (gap ${gap}) → dominant ${dominantTrait}`);

  return {
    trending01, meanReverting01, momentum01,
    calm01, frenzy01, noisy01, dominantTrait, reasons,
  };
}

function sigmoid(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  return 1 / (1 + Math.exp(-x));
}
