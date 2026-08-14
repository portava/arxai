import {
  type DecisionQualityScore,
  type ExpectancyMetrics,
  type FatigueState,
  type SimulationResult,
} from "../decisionIntelligence.types";
import {
  type PermissionDecision,
  type PermissionLevel,
  PERMISSION_RANK,
} from "./governance.types";

// ═══════════════════════════════════════════════════════════════════════════
// derivePermission — decision quality CONTROLS permission level.
//
// Inputs:
//   decisionQuality   pure-process score for the candidate decision
//   expectancy        history-derived survival/expectancy block
//   fatigue           cooldown / exhaustion state
//   simulation        recomputed Monte-Carlo proof (must be approved)
//   patienceMode      patience-engine recommendation
//
// Rules locked in:
//   • PUNISH-grade decision quality (<0.40)            → BLOCKED.
//   • Sim DECLINED                                     → BLOCKED.
//   • Fatigue forceCooldown                            → BLOCKED.
//   • Patience HARD_BLOCK                              → BLOCKED.
//   • Patience SOFT_BLOCK                              → OBSERVE_ONLY.
//   • Patience MONITOR_ONLY                            → OBSERVE_ONLY.
//   • Patience WAIT                                    → REDUCED.
//   • Negative expectancy AND not yet blocked above    → OBSERVE_ONLY.
//   • Survival quality below 0.30                      → REDUCED (cap).
//   • Otherwise: STANDARD; promote to FULL only when all of:
//       quality ≥ 0.75, expectancy E[R] > 0,
//       survivalQuality ≥ 0.65, sim approved with P(ruin) ≤ 0.02.
//   • A disciplined LOSS must NEVER be punished here. Quality score is the
//     only quality-derived gate; outcome plays no role.
// ═══════════════════════════════════════════════════════════════════════════

export interface DerivePermissionInput {
  readonly decisionQuality: DecisionQualityScore;
  readonly expectancy: ExpectancyMetrics;
  readonly fatigue: FatigueState;
  readonly simulation: SimulationResult;
  readonly patienceMode:
    | "PROCEED" | "WAIT" | "MONITOR_ONLY"
    | "SOFT_BLOCK" | "HARD_BLOCK";
}

const PUNISH_QUALITY_BELOW = 0.40;
const FULL_PROMOTION_QUALITY = 0.75;
const FULL_PROMOTION_SURVIVAL = 0.65;
const FULL_PROMOTION_RUIN_MAX = 0.02;
const REDUCED_SURVIVAL_BELOW = 0.30;

function lowerTo(
  current: PermissionLevel, target: PermissionLevel,
): PermissionLevel {
  return PERMISSION_RANK[target] < PERMISSION_RANK[current] ? target : current;
}

export function derivePermission(
  input: DerivePermissionInput,
): PermissionDecision {
  const reasons: string[] = [];
  const blockers: string[] = [];
  let level: PermissionLevel = "STANDARD";

  // ── Hard blockers ───────────────────────────────────────────────────────
  if (input.fatigue.forceCooldown) {
    level = "BLOCKED";
    blockers.push("fatigue: forced cooldown");
  }
  if (!input.simulation.approved) {
    level = "BLOCKED";
    blockers.push(
      `future-risk simulation declined (P(ruin)=${input.simulation.ruinProbability01.toFixed(2)})`,
    );
  }
  if (input.patienceMode === "HARD_BLOCK") {
    level = "BLOCKED";
    blockers.push("patience HARD_BLOCK");
  }
  if (input.decisionQuality.qualityScore01 < PUNISH_QUALITY_BELOW) {
    level = "BLOCKED";
    blockers.push(
      `decision quality ${input.decisionQuality.qualityScore01.toFixed(2)} below PUNISH threshold ${PUNISH_QUALITY_BELOW}`,
    );
  }

  // ── Mid-severity caps (only apply if not already BLOCKED) ───────────────
  if (level !== "BLOCKED") {
    if (input.patienceMode === "SOFT_BLOCK") {
      level = lowerTo(level, "OBSERVE_ONLY");
      reasons.push("patience SOFT_BLOCK → OBSERVE_ONLY");
    }
    if (input.patienceMode === "MONITOR_ONLY") {
      level = lowerTo(level, "OBSERVE_ONLY");
      reasons.push("patience MONITOR_ONLY → OBSERVE_ONLY");
    }
    if (input.patienceMode === "WAIT") {
      level = lowerTo(level, "REDUCED");
      reasons.push("patience WAIT → REDUCED");
    }
    if (input.expectancy.sampleSize >= 20 && input.expectancy.expectancyR <= 0) {
      level = lowerTo(level, "OBSERVE_ONLY");
      reasons.push(
        `negative expectancy E[R]=${input.expectancy.expectancyR.toFixed(2)} → OBSERVE_ONLY`,
      );
    }
    if (input.expectancy.survivalQuality01 < REDUCED_SURVIVAL_BELOW) {
      level = lowerTo(level, "REDUCED");
      reasons.push(
        `low survival quality ${input.expectancy.survivalQuality01.toFixed(2)} → REDUCED`,
      );
    }
  }

  // ── FULL promotion (only from STANDARD with everything green) ───────────
  if (
    level === "STANDARD"
    && input.decisionQuality.qualityScore01 >= FULL_PROMOTION_QUALITY
    && input.expectancy.expectancyR > 0
    && input.expectancy.survivalQuality01 >= FULL_PROMOTION_SURVIVAL
    && input.simulation.approved
    && input.simulation.ruinProbability01 <= FULL_PROMOTION_RUIN_MAX
  ) {
    level = "FULL";
    reasons.push("all gates green → FULL");
  }

  if (reasons.length === 0 && blockers.length === 0) {
    reasons.push(`default ${level}`);
  }

  return {
    allowedPermissionLevel: level,
    reasons,
    blockers,
  };
}
