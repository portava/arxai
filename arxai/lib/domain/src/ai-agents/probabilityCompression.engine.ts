import type { ProbabilityCompressionInput } from "./aiAgents.types";

// "Probability compression" — converts a raw 0..100 score into a calibrated
// probability in [0, 1]. Uses a sigmoid centered at `midpoint` (default 50)
// with a tunable temperature. Higher temperature → flatter curve (less
// extreme probabilities). The point is to AVOID the system claiming 99%
// certainty just because seven scorers all maxed out — empirical reality
// rarely matches headline scores.

const DEFAULT_TEMPERATURE = 12;  // sigmoid steepness; smaller = steeper
const DEFAULT_MIDPOINT = 50;

export function compressProbability(input: ProbabilityCompressionInput): number {
  const T = input.temperature ?? DEFAULT_TEMPERATURE;
  const M = input.midpoint ?? DEFAULT_MIDPOINT;
  if (T <= 0) return input.rawScore >= M ? 1 : 0;

  const x = (input.rawScore - M) / T;
  const sig = 1 / (1 + Math.exp(-x));
  return Math.max(0, Math.min(1, sig));
}

// Inverse — useful when callers want to convert a target probability back
// to the equivalent raw score (e.g. "what raw score equals 90% calibrated?")
export function rawForProbability(p: number, temperature = DEFAULT_TEMPERATURE, midpoint = DEFAULT_MIDPOINT): number {
  const clamped = Math.max(0.001, Math.min(0.999, p));
  const x = Math.log(clamped / (1 - clamped));
  return midpoint + x * temperature;
}

// Helper: compress a 0..100 score into a 0..100 calibrated confidence
// (multiplies by 100 and rounds — convenient for UI display).
export function calibratedConfidence(rawScore: number, temperature = DEFAULT_TEMPERATURE): number {
  return Math.round(compressProbability({ rawScore, temperature }) * 100);
}
