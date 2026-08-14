// ═══════════════════════════════════════════════════════════════════════════
// Behavioral Stress — pure. Tests survival under post-loss aggression,
// override frequency, fatigue, revenge-trading, and overtrading patterns.
// Each scenario carries the expectancy AFTER the behavior fires.
// ═══════════════════════════════════════════════════════════════════════════

import { degradationPct, clamp01, type EdgeAttackGrade } from "./edgeFragility.engine";

export type BehavioralStressKind =
  | "POST_LOSS_AGGRESSION"
  | "OVERRIDE_FREQUENCY_HIGH"
  | "FATIGUE_CONDITIONS"
  | "REVENGE_TRADING"
  | "OVERTRADING_PATTERN"
  | (string & {});

export interface BehavioralStressScenario {
  kind: BehavioralStressKind;
  perturbedExpectancyR: number;
  description?: string;
}
export interface BehavioralStressInput {
  baselineExpectancyR: number;
  scenarios: ReadonlyArray<BehavioralStressScenario>;
  failDegradationPct01?: number;       // default 0.5
}
export interface BehavioralStressResult {
  baselineExpectancyR: number;
  scenarios: EdgeAttackGrade[];
  fragilityScore01: number;            // = behavioralFragilityScore01
  robustnessScore01: number;
  stressPoints: string[];
  worstScenarioKind: string;
  worstDegradationPct01: number;
  reasons: string[];
}

export function assessBehavioralStress(i: BehavioralStressInput): BehavioralStressResult {
  const reasons: string[] = [];
  const failThr = i.failDegradationPct01 ?? 0.5;
  const baseline = i.baselineExpectancyR;

  if (i.scenarios.length === 0) {
    reasons.push("no behavioral stress scenarios — conservative 0.5 fragility");
    return {
      baselineExpectancyR: baseline,
      scenarios: [], fragilityScore01: 0.5, robustnessScore01: 0.5,
      stressPoints: [], worstScenarioKind: "none", worstDegradationPct01: 0,
      reasons,
    };
  }

  const grades: EdgeAttackGrade[] = i.scenarios.map(s => {
    const deg = degradationPct(baseline, s.perturbedExpectancyR);
    return {
      kind: s.kind,
      perturbedExpectancyR: s.perturbedExpectancyR,
      degradationPct01: deg,
      breaking: deg >= failThr || s.perturbedExpectancyR <= 0,
      description: s.description,
    };
  });
  const fragility = grades.reduce((s, g) => s + g.degradationPct01, 0) / grades.length;
  const stresses = grades.filter(g => g.breaking).map(g => g.kind);
  const worst = grades.reduce((w, g) => g.degradationPct01 > w.degradationPct01 ? g : w, grades[0]!);

  reasons.push(`${stresses.length}/${grades.length} behavioral stresses broke the strategy`);
  reasons.push(`worst behavior: "${worst.kind}" deg ${(worst.degradationPct01 * 100).toFixed(0)}%`);

  return {
    baselineExpectancyR: baseline,
    scenarios: grades,
    fragilityScore01: clamp01(fragility),
    robustnessScore01: clamp01(1 - fragility),
    stressPoints: stresses,
    worstScenarioKind: worst.kind,
    worstDegradationPct01: worst.degradationPct01,
    reasons,
  };
}
