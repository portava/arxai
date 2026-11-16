import {
  type PriorityScore, type ValidationCostScore, type EfficiencyTier,
  type ValidationEfficiencyScore, type EarlyFailureDecision,
  type FastTrackDecision, type DuplicateMatch, type ControlTowerRecommendation,
  type ControlTowerAction, type CandidateId, clamp01,
} from "./validationEfficiency.types";

// ═══════════════════════════════════════════════════════════════════════════
// Validation Efficiency Score — composite that turns priority + cost into
// a single [0,1] efficiency score and an EfficiencyTier:
//
//   tier =
//     KILL        if killDecision.kill
//     FAST_TRACK  if fastTrackDecision.fastTrack AND not killed
//     HIGH        score ≥ 0.75
//     MEDIUM      score ≥ 0.50
//     LOW         otherwise
//
// score01 = clamp01(priority01 · (1 - α·cost01))   with α = 0.8
//
// Plus: derive a Control Tower recommendation (ADVANCE / PAUSE / DEMOTE /
// RETIRE). The recommendation is informational — Control Tower itself
// owns the final decision; this is the engine's structured suggestion.
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_EFFICIENCY_TUNING = {
  costPenaltyAlpha: 0.8,
  highTierAt:       0.75,
  mediumTierAt:     0.50,
} as const;
export type EfficiencyTuning = typeof DEFAULT_EFFICIENCY_TUNING;

export interface EfficiencyInput {
  priority: PriorityScore;
  cost: ValidationCostScore;
  earlyFailure?: EarlyFailureDecision;
  fastTrack?: FastTrackDecision;
  duplicateMatches?: ReadonlyArray<DuplicateMatch>;
  tuning?: EfficiencyTuning;
}

export function computeValidationEfficiency(input: EfficiencyInput): ValidationEfficiencyScore {
  const tuning = input.tuning ?? DEFAULT_EFFICIENCY_TUNING;
  const reasons: string[] = [];
  const blockers: string[] = [];

  // Cross-input identity guard.
  if (input.priority.candidateId !== input.cost.candidateId) {
    blockers.push(`priority/cost candidateId mismatch: ${input.priority.candidateId} vs ${input.cost.candidateId}`);
  }
  if (input.earlyFailure && input.earlyFailure.candidateId !== input.priority.candidateId) {
    blockers.push(`earlyFailure candidateId mismatch`);
  }
  if (input.fastTrack && input.fastTrack.candidateId !== input.priority.candidateId) {
    blockers.push(`fastTrack candidateId mismatch`);
  }

  const priority01 = clamp01(input.priority.score01);
  const cost01     = clamp01(input.cost.cost01);
  const score01    = clamp01(priority01 * (1 - tuning.costPenaltyAlpha * cost01));
  reasons.push(`priority ${priority01.toFixed(2)} × (1 − ${tuning.costPenaltyAlpha}·${cost01.toFixed(2)}) = ${score01.toFixed(3)}`);

  let tier: EfficiencyTier;
  if (input.earlyFailure?.kill) {
    tier = "KILL";
    reasons.push(`KILL — early-failure: ${input.earlyFailure.failedChecks.join(",") || "(no checks listed)"}`);
  } else if (input.fastTrack?.fastTrack) {
    tier = "FAST_TRACK";
    reasons.push(`FAST_TRACK — all gates pass and no blockers`);
  } else if (score01 >= tuning.highTierAt) {
    tier = "HIGH";
  } else if (score01 >= tuning.mediumTierAt) {
    tier = "MEDIUM";
  } else {
    tier = "LOW";
  }

  // Duplicate findings flagged but do not change the tier — Control Tower
  // is the one who acts on MERGE/ARCHIVE.
  for (const m of input.duplicateMatches ?? []) {
    if (m.a === input.priority.candidateId || m.b === input.priority.candidateId) {
      reasons.push(`duplicate vs ${m.a === input.priority.candidateId ? m.b : m.a}: ${m.action} (sim ${m.similarity01.toFixed(2)})`);
    }
  }

  // Blockers force a non-FAST_TRACK outcome — never let a structurally
  // broken composite end up FAST_TRACK by accident.
  if (blockers.length > 0 && tier === "FAST_TRACK") {
    tier = "HIGH";
    reasons.push(`FAST_TRACK demoted to HIGH due to ${blockers.length} blocker(s)`);
  }

  return {
    candidateId: input.priority.candidateId,
    score01, tier, priority01, cost01, reasons, blockers,
  };
}

// ── Control Tower recommendation derived from the efficiency score ───────
//
// This is purely advisory — Control Tower has the final say.
export function recommendControlTowerAction(
  candidateId: CandidateId,
  efficiency: ValidationEfficiencyScore,
  duplicateMatches?: ReadonlyArray<DuplicateMatch>,
): ControlTowerRecommendation {
  const reasons: string[] = [];
  let action: ControlTowerAction;

  // Hard rules first.
  if (efficiency.blockers.length > 0) {
    action = "PAUSE";
    reasons.push(`PAUSE — ${efficiency.blockers.length} blocker(s)`);
    return { candidateId, action, reasons };
  }
  if (efficiency.tier === "KILL") {
    action = "RETIRE";
    reasons.push(`RETIRE — efficiency tier KILL`);
    return { candidateId, action, reasons };
  }

  // Duplicate handling — deterministic via match.retireId / match.keepId,
  // computed by the detector from explicit precedence rules. If this
  // candidate is the retireId on any MERGE/ARCHIVE match, recommend RETIRE.
  for (const m of duplicateMatches ?? []) {
    if (m.retireId === candidateId && (m.action === "MERGE" || m.action === "ARCHIVE")) {
      reasons.push(`RETIRE — duplicate of ${m.keepId} (${m.action}, sim ${m.similarity01.toFixed(2)})`);
      return { candidateId, action: "RETIRE", reasons };
    }
  }

  switch (efficiency.tier) {
    case "FAST_TRACK":
    case "HIGH":
      action = "ADVANCE"; reasons.push(`ADVANCE — tier ${efficiency.tier}, score ${efficiency.score01.toFixed(2)}`); break;
    case "MEDIUM":
      action = "ADVANCE"; reasons.push(`ADVANCE — tier MEDIUM (slow lane)`); break;
    case "LOW":
      action = "PAUSE";   reasons.push(`PAUSE — tier LOW, score ${efficiency.score01.toFixed(2)}`); break;
    default:
      action = "PAUSE";   reasons.push(`PAUSE — unknown tier`);
  }
  return { candidateId, action, reasons };
}
