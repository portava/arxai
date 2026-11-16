// ═══════════════════════════════════════════════════════════════════════════
// Assumption Audit — pure. Lists the assumptions a strategy makes (e.g.
// "spread ≤ X", "broker fills at quote", "regime is trending", "news feed
// available") and grades whether each holds, with a severity weight. The
// engine reports the violation severity, the violated set, and a list of
// recommended restrictions.
// ═══════════════════════════════════════════════════════════════════════════

import { clamp01 } from "./edgeFragility.engine";

export interface StrategyAssumption {
  kind: string;
  holds: boolean;
  severity01: number;          // weight applied if violated
  evidence?: string;
  recommendedRestriction?: string;
}
export interface AssumptionAuditInput {
  assumptions: ReadonlyArray<StrategyAssumption>;
}
export interface AssumptionAuditResult {
  assumptionsHolding: string[];
  assumptionsViolated: string[];
  violationSeverity01: number;
  totalAssumptions: number;
  score01: number;             // 1 - severity-weighted violation share
  recommendedRestrictions: string[];
  reasons: string[];
}

export function auditAssumptions(i: AssumptionAuditInput): AssumptionAuditResult {
  const reasons: string[] = [];
  const restrictions: string[] = [];
  const holding: string[] = []; const violated: string[] = [];
  let weightSum = 0; let violatedWeight = 0;

  for (const a of i.assumptions) {
    const w = clamp01(a.severity01);
    weightSum += w;
    if (a.holds) {
      holding.push(a.kind);
    } else {
      violated.push(a.kind);
      violatedWeight += w;
      if (a.recommendedRestriction) restrictions.push(a.recommendedRestriction);
      reasons.push(`assumption "${a.kind}" VIOLATED (severity ${w.toFixed(2)})${a.evidence ? `: ${a.evidence}` : ""}`);
    }
  }
  const violationSeverity01 = weightSum > 0 ? clamp01(violatedWeight / weightSum) : 0;
  const score01 = clamp01(1 - violationSeverity01);
  reasons.push(`${holding.length}/${i.assumptions.length} assumptions hold; severity ${violationSeverity01.toFixed(2)}`);

  return {
    assumptionsHolding: holding,
    assumptionsViolated: violated,
    violationSeverity01,
    totalAssumptions: i.assumptions.length,
    score01,
    recommendedRestrictions: dedupe(restrictions),
    reasons,
  };
}

function dedupe<T>(arr: T[]): T[] {
  const seen = new Set<T>(); const out: T[] = [];
  for (const x of arr) if (!seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}
