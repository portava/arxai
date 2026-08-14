// ═══════════════════════════════════════════════════════════════════════════
// Edge Fragility — pure. Actively tries to break the edge with parameter
// shifts, delayed entries/exits, reduced liquidity, spread widening, and
// slippage increases. A scenario "breaks" the edge when its perturbed
// expectancy degrades beyond `failDegradationPct01` (default 0.5) of the
// baseline. fragilityScore01 = average degradation across scenarios.
// ═══════════════════════════════════════════════════════════════════════════

export type EdgeAttackKind =
  | "PARAM_SHIFT"
  | "DELAYED_ENTRY"
  | "DELAYED_EXIT"
  | "REDUCED_LIQUIDITY"
  | "SPREAD_WIDENING"
  | "SLIPPAGE_INCREASE"
  | (string & {});

export interface EdgeAttackScenario {
  kind: EdgeAttackKind;
  perturbedExpectancyR: number;
  magnitude01?: number;
  description?: string;
}
export interface EdgeFragilityInput {
  baselineExpectancyR: number;
  attacks: ReadonlyArray<EdgeAttackScenario>;
  failDegradationPct01?: number;       // default 0.5
}
export interface EdgeAttackGrade {
  kind: string;
  perturbedExpectancyR: number;
  degradationPct01: number;
  breaking: boolean;
  description?: string;
}
export interface EdgeFragilityResult {
  baselineExpectancyR: number;
  attacks: EdgeAttackGrade[];
  fragilityScore01: number;
  robustnessScore01: number;
  breakingPoints: string[];
  worstAttackKind: string;
  worstDegradationPct01: number;
  reasons: string[];
}

export function degradationPct(baseline: number, perturbed: number): number {
  if (baseline > 0) return Math.max(0, Math.min(1, (baseline - perturbed) / baseline));
  return perturbed <= 0 ? 1 : 0;
}

export function assessEdgeFragility(i: EdgeFragilityInput): EdgeFragilityResult {
  const reasons: string[] = [];
  const failThr = i.failDegradationPct01 ?? 0.5;
  const baseline = i.baselineExpectancyR;

  if (i.attacks.length === 0) {
    reasons.push("no edge attacks supplied — cannot judge fragility (conservative 0.5)");
    return {
      baselineExpectancyR: baseline,
      attacks: [], fragilityScore01: 0.5, robustnessScore01: 0.5,
      breakingPoints: [], worstAttackKind: "none", worstDegradationPct01: 0,
      reasons,
    };
  }

  const grades: EdgeAttackGrade[] = i.attacks.map(a => {
    const deg = degradationPct(baseline, a.perturbedExpectancyR);
    return {
      kind: a.kind,
      perturbedExpectancyR: a.perturbedExpectancyR,
      degradationPct01: deg,
      breaking: deg >= failThr || a.perturbedExpectancyR <= 0,
      description: a.description,
    };
  });
  const fragility = grades.reduce((s, g) => s + g.degradationPct01, 0) / grades.length;
  const breaking = grades.filter(g => g.breaking).map(g => g.kind);
  const worst = grades.reduce((w, g) => g.degradationPct01 > w.degradationPct01 ? g : w, grades[0]!);

  reasons.push(`${breaking.length}/${grades.length} edge attacks broke the strategy`);
  reasons.push(`fragility ${fragility.toFixed(2)} | worst attack "${worst.kind}" deg ${(worst.degradationPct01 * 100).toFixed(0)}%`);
  if (baseline <= 0) reasons.push("baseline expectancy ≤ 0 — every attack treated as catastrophic");

  return {
    baselineExpectancyR: baseline,
    attacks: grades,
    fragilityScore01: clamp01(fragility),
    robustnessScore01: clamp01(1 - fragility),
    breakingPoints: breaking,
    worstAttackKind: worst.kind,
    worstDegradationPct01: worst.degradationPct01,
    reasons,
  };
}

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
