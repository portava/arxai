import type { AiConfidenceFactor, AiDecision } from "./aiInsight.types";
import { computeConfidence, discountConfidence } from "./aiConfidence.engine";

export interface DecisionInput {
  factors: AiConfidenceFactor[];
  // Hard blockers: any non-empty array forces verdict=BLOCK.
  blockers?: string[];
  // Soft cautions: lower confidence but do not block.
  cautions?: { reason: string; penalty: number }[];
  // Approve threshold (0..100). Default 70.
  approveThreshold?: number;
  // Wait band — between waitFloor and approveThreshold means WAIT.
  waitFloor?: number;
}

// Pure: combine signal factors into a final verdict. The risk manager and
// route handlers wrap this — this engine never reads anything external.
export function decide(input: DecisionInput): AiDecision {
  const blockers = input.blockers ?? [];
  const cautions = input.cautions ?? [];
  const approveThreshold = input.approveThreshold ?? 70;
  const waitFloor = input.waitFloor ?? 50;

  const baseConfidence = computeConfidence(input.factors);
  const finalConfidence = discountConfidence(baseConfidence.score, cautions.map((c) => c.penalty));

  if (blockers.length > 0) {
    return {
      verdict: "BLOCK",
      confidence: finalConfidence,
      reasoning: `Blocked by ${blockers.length} hard rule(s).`,
      factors: input.factors,
      blockers,
      cautions: cautions.map((c) => c.reason),
    };
  }

  if (finalConfidence >= approveThreshold) {
    return {
      verdict: "APPROVE",
      confidence: finalConfidence,
      reasoning: `Confidence ${finalConfidence} ≥ threshold ${approveThreshold}.`,
      factors: input.factors,
      blockers: [],
      cautions: cautions.map((c) => c.reason),
    };
  }
  if (finalConfidence >= waitFloor) {
    return {
      verdict: "WAIT",
      confidence: finalConfidence,
      reasoning: `Confidence ${finalConfidence} between wait floor ${waitFloor} and approve ${approveThreshold}.`,
      factors: input.factors,
      blockers: [],
      cautions: cautions.map((c) => c.reason),
    };
  }
  return {
    verdict: "BLOCK",
    confidence: finalConfidence,
    reasoning: `Confidence ${finalConfidence} below wait floor ${waitFloor}.`,
    factors: input.factors,
    blockers: ["Low confidence"],
    cautions: cautions.map((c) => c.reason),
  };
}
