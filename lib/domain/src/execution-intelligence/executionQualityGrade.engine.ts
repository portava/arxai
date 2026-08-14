// ═══════════════════════════════════════════════════════════════════════════
// Execution Quality Grade — A..F
//
// Inputs: implementation shortfall (pips), expected edge (pips), arrival
// slippage, fill ratio, anomalies (rejected/requoted).
//
// Grading (relative to the strategy's edge, so a 1-pip cost on a 5-pip edge
// is graded harder than a 1-pip cost on a 50-pip edge):
//   IS/edge ≤ 0.05    → A
//   IS/edge ≤ 0.15    → B
//   IS/edge ≤ 0.30    → C
//   IS/edge ≤ 0.60    → D
//   IS/edge >  0.60   → F
//
// Plus penalties:
//   • rejected  → automatic F
//   • requoted  → drop one grade
//   • fillRatio<1 → drop one grade
//
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import type { ExecutionGrade } from "./executionIntelligence.types";

const ORDER: ExecutionGrade[] = ["A", "B", "C", "D", "F"];
function dropGrade(g: ExecutionGrade, by: number): ExecutionGrade {
  const i = Math.min(ORDER.length - 1, ORDER.indexOf(g) + by);
  return ORDER[i];
}
export function gradeNumeric(g: ExecutionGrade): number {
  return { A: 4, B: 3, C: 2, D: 1, F: 0 }[g];
}

export interface QualityGradeInput {
  implementationShortfallPips: number;
  expectedEdgePips: number;
  fillRatio01: number;
  rejected: boolean;
  requoted: boolean;
}

export interface QualityGradeResult {
  grade: ExecutionGrade;
  isOverEdge: number;
  reasons: string[];
}

export function gradeExecutionQuality(i: QualityGradeInput): QualityGradeResult {
  const reasons: string[] = [];
  const edge = Math.max(1e-9, i.expectedEdgePips);
  const isOverEdge = i.implementationShortfallPips / edge;
  reasons.push(`IS/edge ${isOverEdge.toFixed(2)}`);

  let grade: ExecutionGrade =
      isOverEdge <= 0.05 ? "A"
    : isOverEdge <= 0.15 ? "B"
    : isOverEdge <= 0.30 ? "C"
    : isOverEdge <= 0.60 ? "D"
    : "F";

  if (i.rejected) {
    grade = "F";
    reasons.push("REJECTED → F");
  } else {
    if (i.requoted) {
      grade = dropGrade(grade, 1);
      reasons.push("REQUOTED → drop one grade");
    }
    if (i.fillRatio01 < 1) {
      grade = dropGrade(grade, 1);
      reasons.push(`partial fill ${(i.fillRatio01 * 100).toFixed(0)}% → drop one grade`);
    }
  }
  return { grade, isOverEdge, reasons };
}
