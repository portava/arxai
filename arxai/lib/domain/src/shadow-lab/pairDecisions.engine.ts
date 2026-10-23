import type {
  ComparisonClass, PairClassification, ShadowDecisionPair,
} from "./shadowLab.types";

// pairDecisions — classify a (baseline, candidate) decision pair into
// one of 7 ComparisonClass values. Direction comparison is short-circuit
// when one side blocked.
export function classifyPair(p: ShadowDecisionPair): PairClassification {
  const reasons: string[] = [];
  const b = p.baseline;
  const c = p.candidate;
  const bTraded = b.action !== "REJECT";
  const cTraded = c.action !== "REJECT";

  let comparisonClass: ComparisonClass;
  if (!bTraded && !cTraded) {
    comparisonClass = "CONCURRED_BLOCKED";
    reasons.push("both rejected");
  } else if (bTraded && !cTraded) {
    comparisonClass = "BASELINE_TRADED_CANDIDATE_BLOCKED";
    reasons.push(`baseline ${b.direction} traded; candidate blocked`);
  } else if (!bTraded && cTraded) {
    comparisonClass = "CANDIDATE_TRADED_BASELINE_BLOCKED";
    reasons.push(`candidate ${c.direction} traded; baseline blocked`);
  } else if (b.direction !== c.direction) {
    comparisonClass = "OPPOSITE_DIRECTIONS";
    reasons.push(`baseline ${b.direction} vs candidate ${c.direction}`);
  } else if (b.action === "APPROVE" && c.action === "APPROVE_REDUCED") {
    comparisonClass = "BASELINE_FULL_CANDIDATE_REDUCED";
    reasons.push(`baseline full size, candidate reduced ×${c.sizeMultiplier.toFixed(2)}`);
  } else if (b.action === "APPROVE_REDUCED" && c.action === "APPROVE") {
    comparisonClass = "CANDIDATE_FULL_BASELINE_REDUCED";
    reasons.push(`candidate full size, baseline reduced ×${b.sizeMultiplier.toFixed(2)}`);
  } else {
    comparisonClass = "CONCURRED_TRADED";
    reasons.push(`both traded ${b.direction} (sizes ×${b.sizeMultiplier.toFixed(2)} / ×${c.sizeMultiplier.toFixed(2)})`);
  }
  return { pairId: p.pairId, comparisonClass, reasons };
}
