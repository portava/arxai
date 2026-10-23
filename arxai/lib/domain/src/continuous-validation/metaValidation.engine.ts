// ═══════════════════════════════════════════════════════════════════════════
// Meta-Validation — pure. Validates the validation system itself by
// tracking false approvals (strategies promoted that should not have been)
// and false blocks (strategies blocked that proved profitable). Reports
// precision, recall, calibration grade, and a system-tuning recommendation.
// ═══════════════════════════════════════════════════════════════════════════

import { clamp01 } from "./confidenceHealth.engine";

export type MetaTuningRecommendation =
  | "TIGHTEN_VALIDATION"
  | "LOOSEN_VALIDATION"
  | "HOLD_VALIDATION_THRESHOLDS";

export type MetaCalibrationGrade = "A" | "B" | "C" | "D" | "F";

export interface MetaValidationInput {
  windowDays: number;
  trueApprovals: number;       // approved → still profitable
  falseApprovals: number;      // approved → broke / lost money
  trueBlocks: number;          // blocked  → would have lost / collapsed
  falseBlocks: number;         // blocked  → would have been profitable
  // Tuning thresholds (defaults documented above)
  tightenAboveFalseApprovalRate01?: number;  // default 0.10
  loosenAboveFalseBlockRate01?: number;      // default 0.20
}
export interface MetaValidationResult {
  windowDays: number;
  precision01: number;          // TA / (TA + FA)
  recall01: number;             // TA / (TA + FB)
  falseApprovalRate01: number;  // FA / (TA + FA)
  falseBlockRate01: number;     // FB / (TB + FB)
  totalDecisions: number;
  calibrationGrade: MetaCalibrationGrade;
  recommendation: MetaTuningRecommendation;
  reasons: string[];
}

function gradeOf(falseApproval: number, falseBlock: number): MetaCalibrationGrade {
  const worst = Math.max(falseApproval, falseBlock);
  if (worst <= 0.05) return "A";
  if (worst <= 0.10) return "B";
  if (worst <= 0.20) return "C";
  if (worst <= 0.30) return "D";
  return "F";
}

export function assessMetaValidation(i: MetaValidationInput): MetaValidationResult {
  const reasons: string[] = [];
  const tightenThr = i.tightenAboveFalseApprovalRate01 ?? 0.10;
  const loosenThr  = i.loosenAboveFalseBlockRate01     ?? 0.20;

  const totalApprovals = i.trueApprovals + i.falseApprovals;
  const totalBlocks    = i.trueBlocks + i.falseBlocks;
  const totalDecisions = totalApprovals + totalBlocks;

  const precision = totalApprovals > 0 ? clamp01(i.trueApprovals / totalApprovals) : 0;
  // recall in this domain: of all opportunities that SHOULD have been
  // approved (TA + FB), what fraction we approved (TA)
  const opportunities = i.trueApprovals + i.falseBlocks;
  const recall = opportunities > 0 ? clamp01(i.trueApprovals / opportunities) : 0;
  const fAR = totalApprovals > 0 ? clamp01(i.falseApprovals / totalApprovals) : 0;
  const fBR = totalBlocks    > 0 ? clamp01(i.falseBlocks    / totalBlocks)    : 0;

  let recommendation: MetaTuningRecommendation = "HOLD_VALIDATION_THRESHOLDS";
  if (fAR > tightenThr && fAR >= fBR) {
    recommendation = "TIGHTEN_VALIDATION";
    reasons.push(`falseApprovalRate ${(fAR * 100).toFixed(1)}% > ${(tightenThr * 100).toFixed(0)}% — tighten`);
  } else if (fBR > loosenThr && fBR > fAR) {
    recommendation = "LOOSEN_VALIDATION";
    reasons.push(`falseBlockRate ${(fBR * 100).toFixed(1)}% > ${(loosenThr * 100).toFixed(0)}% — loosen`);
  } else {
    reasons.push(`falseApprovalRate ${(fAR * 100).toFixed(1)}% / falseBlockRate ${(fBR * 100).toFixed(1)}% — hold`);
  }

  const grade = gradeOf(fAR, fBR);
  reasons.push(`precision ${precision.toFixed(2)} | recall ${recall.toFixed(2)} | grade ${grade} over ${totalDecisions} decisions in ${i.windowDays}d`);

  return {
    windowDays: i.windowDays,
    precision01: precision,
    recall01: recall,
    falseApprovalRate01: fAR,
    falseBlockRate01: fBR,
    totalDecisions,
    calibrationGrade: grade,
    recommendation,
    reasons,
  };
}
