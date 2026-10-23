// ═══════════════════════════════════════════════════════════════════════════
// Overfit Exposure — pure. Probes how much of the apparent edge is
// overfitting by comparing baseline against:
//   • RANDOMIZATION (random entries with same risk model)
//   • SHUFFLED_TRADE_ORDER (order-shuffled equity curves)
//   • OUT_OF_SAMPLE (held-out period)
//   • SYNTHETIC_MARKET_VARIATIONS (bootstrapped or perturbed candles)
//   • HIDDEN_REGIME_EVALUATION (regimes withheld during fit)
//
// The MORE the perturbed expectancy resembles baseline, the more likely the
// edge is a fit-to-history artefact (high exposure). The LESS it resembles
// baseline (i.e. perturbed collapses), the more likely the edge is real.
// We therefore compute exposure as a function of degradation gap.
// ═══════════════════════════════════════════════════════════════════════════

import { degradationPct, clamp01, type EdgeAttackGrade } from "./edgeFragility.engine";

export type OverfitProbeKind =
  | "RANDOMIZATION"
  | "SHUFFLED_TRADE_ORDER"
  | "OUT_OF_SAMPLE"
  | "SYNTHETIC_MARKET_VARIATIONS"
  | "HIDDEN_REGIME_EVALUATION"
  | (string & {});

export interface OverfitProbe {
  kind: OverfitProbeKind;
  perturbedExpectancyR: number;
  description?: string;
}
export interface OverfitExposureInput {
  baselineExpectancyR: number;
  probes: ReadonlyArray<OverfitProbe>;
  // Probes whose perturbed expectancy collapses below this fraction of
  // baseline are evidence of overfitting. Default 0.5.
  collapseThresholdPct01?: number;
  // Probes for which collapse evidence is REVERSED (e.g. RANDOMIZATION
  // SHOULD collapse — if it doesn't, we suspect overfitting via leakage).
  reversedKinds?: ReadonlyArray<OverfitProbeKind>;
}
export interface OverfitExposureResult {
  baselineExpectancyR: number;
  probes: Array<EdgeAttackGrade & { reversed: boolean }>;
  fragilityScore01: number;            // = overfitExposureScore01
  robustnessScore01: number;
  exposurePoints: string[];
  worstProbeKind: string;
  reasons: string[];
}

const DEFAULT_REVERSED: ReadonlyArray<OverfitProbeKind> = ["RANDOMIZATION"];

export function assessOverfitExposure(i: OverfitExposureInput): OverfitExposureResult {
  const reasons: string[] = [];
  const baseline = i.baselineExpectancyR;
  const collapseThr = i.collapseThresholdPct01 ?? 0.5;
  const reversedSet = new Set<OverfitProbeKind>(i.reversedKinds ?? DEFAULT_REVERSED);

  if (i.probes.length === 0) {
    reasons.push("no overfit probes — conservative 0.5 exposure");
    return {
      baselineExpectancyR: baseline,
      probes: [], fragilityScore01: 0.5, robustnessScore01: 0.5,
      exposurePoints: [], worstProbeKind: "none", reasons,
    };
  }

  const grades: Array<EdgeAttackGrade & { reversed: boolean }> = i.probes.map(p => {
    const deg = degradationPct(baseline, p.perturbedExpectancyR);
    const reversed = reversedSet.has(p.kind);
    // For NORMAL probes: collapse (high deg) → exposure (overfit). We treat
    // breaking = collapse beyond threshold.
    // For REVERSED probes (randomization): NO collapse → exposure.
    let exposureContribution: number;
    let breaking: boolean;
    if (reversed) {
      // exposure rises as randomized expectancy stays close to baseline
      exposureContribution = clamp01(1 - deg);
      breaking = exposureContribution >= 0.5;
    } else {
      exposureContribution = clamp01(deg);
      breaking = deg >= collapseThr || p.perturbedExpectancyR <= 0;
    }
    return {
      kind: p.kind,
      perturbedExpectancyR: p.perturbedExpectancyR,
      degradationPct01: exposureContribution,
      breaking,
      description: p.description,
      reversed,
    };
  });

  const exposure = grades.reduce((s, g) => s + g.degradationPct01, 0) / grades.length;
  const broken = grades.filter(g => g.breaking).map(g => g.kind);
  const worst = grades.reduce((w, g) => g.degradationPct01 > w.degradationPct01 ? g : w, grades[0]!);

  reasons.push(`overfit exposure ${exposure.toFixed(2)} (1.0 = full overfit, 0.0 = robust)`);
  reasons.push(`${broken.length}/${grades.length} probes flagged exposure (worst "${worst.kind}")`);

  return {
    baselineExpectancyR: baseline,
    probes: grades,
    fragilityScore01: clamp01(exposure),
    robustnessScore01: clamp01(1 - exposure),
    exposurePoints: broken,
    worstProbeKind: worst.kind,
    reasons,
  };
}
