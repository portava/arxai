import type { Triple } from "./contracts.js";

// Indices in structuralFeatures' features-1 vector. Each fit sees only the
// named evidence, and all predict the same verified first-break outcome.
export const specialistFeatures = {
  STRUCTURE: [0, 1, 11, 16, 17], // pivot distance/age and established swing direction
  MOMENTUM: [2, 3, 4, 6], // 3/10/30-bar moves and last body
  LIQUIDITY: [7, 8, 9, 10, 12], // wicks, excursions beyond pivots and sweep recency
  PATTERN: [5, 13, 14, 15], // recent range, gaps, retests and pending break
} as const;
export type Specialist = keyof typeof specialistFeatures;
export const specialistIds = Object.keys(specialistFeatures) as Specialist[];
export const ATI_SPECIALIST_VERSION = "ati-structural-specialists-m1-15-v1";
export type SpecialistQuoteStudy = {
  version: "fixed-horizon-bid-ask-v1";
  streamId: string; symbol: string; epoch: number; bid: number; ask: number;
};
export type SpecialistReceipt = {
  version: typeof ATI_SPECIALIST_VERSION; target: "FIRST_STRUCTURAL_BREAK_15_M1";
  quoteStudy?: SpecialistQuoteStudy;
  asOf: number; symbol: string; provider: string; modelId: string; trainedThrough: number; trainedWindows: number;
  trend: "UP" | "DOWN" | "UNESTABLISHED"; frequency: Triple; probabilities: Record<Specialist, Triple>;
};
export function specialistPool(receipt: SpecialistReceipt, omit?: Specialist): Triple {
  const ids = specialistIds.filter((id) => id !== omit);
  return [0, 1, 2].map((i) => ids.reduce((sum, id) => sum + receipt.probabilities[id][i]!, 0) / ids.length) as Triple;
}
