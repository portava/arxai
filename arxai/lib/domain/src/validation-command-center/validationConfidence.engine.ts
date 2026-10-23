// ═══════════════════════════════════════════════════════════════════════════
// Validation Confidence — pure. Combines all sub-scores into a single
// "how confident are we?" number. Used by the Command Center to gate
// promotions and surface plain-English explanations.
// ═══════════════════════════════════════════════════════════════════════════

export interface ValidationConfidenceInput {
  statisticalConfidenceScore01: number;
  regimeFitScore01: number;
  edgeDurabilityScore01: number;
  monteCarloRobustness01: number;
  outOfSampleScore01: number;
  sampleSize: number;
}
export interface ValidationConfidenceResult {
  score01: number;
  components: Record<string, number>;
  weakestComponent: string;
  strongestComponent: string;
  reasons: string[];
}

export function computeValidationConfidence(
  i: ValidationConfidenceInput,
): ValidationConfidenceResult {
  const sampleAdequacy01 = Math.min(1, Math.max(0, i.sampleSize / 200));
  const components: Record<string, number> = {
    statisticalConfidence: clamp01(i.statisticalConfidenceScore01),
    regimeFit:             clamp01(i.regimeFitScore01),
    edgeDurability:        clamp01(i.edgeDurabilityScore01),
    monteCarloRobustness:  clamp01(i.monteCarloRobustness01),
    outOfSample:           clamp01(i.outOfSampleScore01),
    sampleAdequacy:        sampleAdequacy01,
  };
  const weights: Record<string, number> = {
    statisticalConfidence: 0.20,
    regimeFit:             0.15,
    edgeDurability:        0.20,
    monteCarloRobustness:  0.20,
    outOfSample:           0.20,
    sampleAdequacy:        0.05,
  };
  let score01 = 0;
  for (const k of Object.keys(components)) {
    score01 += components[k]! * weights[k]!;
  }
  score01 = clamp01(score01);

  const entries = Object.entries(components);
  const weakest = entries.reduce((w, e) => e[1] < w[1] ? e : w, entries[0]!);
  const strongest = entries.reduce((s, e) => e[1] > s[1] ? e : s, entries[0]!);
  const reasons: string[] = [
    `weighted confidence = ${score01.toFixed(3)}`,
    `weakest dimension: ${weakest[0]} (${weakest[1].toFixed(2)})`,
    `strongest dimension: ${strongest[0]} (${strongest[1].toFixed(2)})`,
  ];
  if (i.sampleSize < 100) reasons.push(`sample size ${i.sampleSize} below 100 — confidence is conservative`);

  return { score01, components, weakestComponent: weakest[0], strongestComponent: strongest[0], reasons };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
