import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Audit AI — grades every decision after the fact. Distinct from
// decision-qa (which answers 6 specific yes/no questions) and from
// regret-engine (which classifies regret kind). Audit AI gives a single
// composite grade A..F per decision plus reasons, and aggregates across
// many decisions.
// ═══════════════════════════════════════════════════════════════════════════

export const DecisionGradeSchema = z.enum(["A", "B", "C", "D", "F"]);
export type DecisionGrade = z.infer<typeof DecisionGradeSchema>;

export interface AuditInput {
  decisionId: string;
  decisionAtIso: string;
  // Quality signals (each 0..1, 1 = best)
  ruleCompliance01: number;             // did the decision follow the constitution + risk rules?
  processQuality01: number;             // were proper deliberation steps followed?
  entryQuality01: number;               // for executed trades — slippage/timing
  exitQuality01: number;                // for executed trades — exit timing
  outcomeQuality01: number;             // realized or counterfactual outcome quality
  isCounterfactualOutcome: boolean;     // true if this was a REJECT decision
}

export interface AuditGrade {
  decisionId: string;
  grade: DecisionGrade;
  composite01: number;                  // raw composite score
  byDimension: {
    ruleCompliance01: number;
    processQuality01: number;
    entryQuality01: number;
    exitQuality01: number;
    outcomeQuality01: number;
  };
  reasons: string[];
}

export interface AuditAggregate {
  totalDecisions: number;
  byGrade: Partial<Record<DecisionGrade, number>>;
  meanComposite01: number;
  weakestDimension: keyof AuditGrade["byDimension"] | null;
  reasons: string[];
}

// Weights — outcome and rule compliance both matter most (40% combined)
// BUT process quality alone has weight 0.30 because the project rule
// is "good process > lucky outcome". Entry/exit quality contribute 0.15
// combined.
export const AUDIT_WEIGHTS = {
  ruleCompliance: 0.30,
  processQuality: 0.30,
  outcomeQuality: 0.25,
  entryQuality: 0.075,
  exitQuality: 0.075,
} as const;

// Grade thresholds on composite 0..1
export const GRADE_THRESHOLDS = {
  A: 0.85,
  B: 0.70,
  C: 0.55,
  D: 0.40,
  // below D → F
} as const;
