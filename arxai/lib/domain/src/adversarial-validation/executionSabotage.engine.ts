// ═══════════════════════════════════════════════════════════════════════════
// Execution Sabotage — pure. Tests survival under partial fills, latency
// spikes, rejected orders, broker instability, and execution delays.
// ═══════════════════════════════════════════════════════════════════════════

import { degradationPct, clamp01, type EdgeAttackGrade } from "./edgeFragility.engine";

export type ExecutionSabotageKind =
  | "PARTIAL_FILLS"
  | "LATENCY_SPIKES"
  | "REJECTED_ORDERS"
  | "BROKER_INSTABILITY"
  | "EXECUTION_DELAYS"
  | (string & {});

export interface ExecutionSabotageScenario {
  kind: ExecutionSabotageKind;
  perturbedExpectancyR: number;
  description?: string;
}
export interface ExecutionSabotageInput {
  baselineExpectancyR: number;
  scenarios: ReadonlyArray<ExecutionSabotageScenario>;
  failDegradationPct01?: number;       // default 0.5
}
export interface ExecutionSabotageResult {
  baselineExpectancyR: number;
  scenarios: EdgeAttackGrade[];
  fragilityScore01: number;            // = executionFragilityScore01
  robustnessScore01: number;
  sabotagePoints: string[];
  worstScenarioKind: string;
  worstDegradationPct01: number;
  reasons: string[];
}

export function assessExecutionSabotage(i: ExecutionSabotageInput): ExecutionSabotageResult {
  const reasons: string[] = [];
  const failThr = i.failDegradationPct01 ?? 0.5;
  const baseline = i.baselineExpectancyR;

  if (i.scenarios.length === 0) {
    reasons.push("no execution sabotage scenarios — conservative 0.5 fragility");
    return {
      baselineExpectancyR: baseline,
      scenarios: [], fragilityScore01: 0.5, robustnessScore01: 0.5,
      sabotagePoints: [], worstScenarioKind: "none", worstDegradationPct01: 0,
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
  const sabotages = grades.filter(g => g.breaking).map(g => g.kind);
  const worst = grades.reduce((w, g) => g.degradationPct01 > w.degradationPct01 ? g : w, grades[0]!);

  reasons.push(`${sabotages.length}/${grades.length} sabotage scenarios broke execution`);
  reasons.push(`worst sabotage: "${worst.kind}" deg ${(worst.degradationPct01 * 100).toFixed(0)}%`);

  return {
    baselineExpectancyR: baseline,
    scenarios: grades,
    fragilityScore01: clamp01(fragility),
    robustnessScore01: clamp01(1 - fragility),
    sabotagePoints: sabotages,
    worstScenarioKind: worst.kind,
    worstDegradationPct01: worst.degradationPct01,
    reasons,
  };
}
