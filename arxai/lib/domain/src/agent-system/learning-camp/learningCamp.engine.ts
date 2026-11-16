// Agent Ecosystem — Layer 2: Learning Camp stage machine (§7). PURE.
//
// Learning Camp is CORRECTION, not deletion. A struggling agent moves through
// supervised stages, gets stored correction rules it must respect afterwards
// (repeating a corrected mistake is penalized by the review engine), and
// returns Supervised or Full — or is further restricted if it does not improve.

export type CampStage =
  | "FAILURE_REVIEW" | "PATTERN_CORRECTION" | "REPLAY_TRAINING"
  | "SHADOW_MODE" | "SUPERVISED_RETURN" | "FULL_RETURN" | "FURTHER_RESTRICTION";

export type CampReturnStatus =
  | "IN_PROGRESS" | "RETURNED_FULL" | "RETURNED_SUPERVISED" | "FURTHER_RESTRICTED";

// Forward progression for stages that always advance the same way.
const LINEAR: Partial<Record<CampStage, CampStage>> = {
  FAILURE_REVIEW: "PATTERN_CORRECTION",
  PATTERN_CORRECTION: "REPLAY_TRAINING",
  REPLAY_TRAINING: "SHADOW_MODE",
};

/** Next stage given whether the agent is showing improvement. PURE. */
export function nextCampStage(current: CampStage, improved: boolean): CampStage {
  if (current in LINEAR) return LINEAR[current]!;
  if (current === "SHADOW_MODE") return improved ? "SUPERVISED_RETURN" : "FURTHER_RESTRICTION";
  if (current === "SUPERVISED_RETURN") return improved ? "FULL_RETURN" : "FURTHER_RESTRICTION";
  return current; // FULL_RETURN / FURTHER_RESTRICTION are terminal
}

export function isTerminalStage(stage: CampStage): boolean {
  return stage === "FULL_RETURN" || stage === "FURTHER_RESTRICTION";
}

export function returnStatusForStage(stage: CampStage): CampReturnStatus {
  if (stage === "FULL_RETURN") return "RETURNED_FULL";
  if (stage === "FURTHER_RESTRICTION") return "FURTHER_RESTRICTED";
  if (stage === "SUPERVISED_RETURN") return "RETURNED_SUPERVISED";
  return "IN_PROGRESS";
}

/** Entry triggers (§7): poor streak, repeated corrected mistake, or a Risk/
 *  Promotion-Board recommendation. PURE. */
export function shouldEnterLearningCamp(args: {
  poorRecent: number;
  repeatedCorrectedMistake?: boolean;
  recommendedByRiskOrBoard?: boolean;
}): boolean {
  return args.poorRecent >= 8
    || args.repeatedCorrectedMistake === true
    || args.recommendedByRiskOrBoard === true;
}

/** Derive durable correction rules from observed failure patterns. PURE. */
export function buildCorrectionRules(failurePatterns: string[]): string[] {
  const rules = new Set<string>();
  for (const p of failurePatterns) {
    switch (p) {
      case "ignored_sr": rules.add("Always respect mapped support/resistance before advising entry."); break;
      case "no_stop_defined":
      case "reckless_win_no_stop": rules.add("Never advise an entry without a defined invalidation/stop."); break;
      case "unrealistic_target": rules.add("Target must be reachable within the expected move and time horizon."); break;
      case "duplicate_analysis": rules.add("Do not repeat an analysis already produced for the same setup."); break;
      case "late_chase": rules.add("Do not chase late entries; step back when the entry window has passed."); break;
      case "overconfident_loss": rules.add("Calibrate confidence to evidence; high confidence requires strong confirmation."); break;
      default: rules.add(`Correct recurring failure pattern: ${p}.`);
    }
  }
  return [...rules];
}
