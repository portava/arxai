import {
  type FatigueState,
  type SimulationResult,
} from "../decisionIntelligence.types";
import {
  type AggressionLimitDecision,
  type ConfirmationLevel,
  type PermissionDecision,
  type PolicyDecision,
  type SizingDecision,
  CONFIRMATION_RANK,
} from "./governance.types";

// ═══════════════════════════════════════════════════════════════════════════
// derivePolicy — translate permission, aggression, sizing, sim, fatigue
// into the operational policy: requiredConfirmation + requiredDelay.
//
// Confirmation ladder (take MAX across rules):
//   • Permission BLOCKED                            → MULTI_STEP (overrides)
//   • Permission OBSERVE_ONLY                       → DOUBLE
//   • Aggression cap = MAX                          → DOUBLE
//   • Aggression cap = ELEVATED                     → SINGLE
//   • maxPositionSizeR ≥ 1.5 × baseRiskR            → DOUBLE
//   • Sim P(ruin) > 0.02 (still approved)           → SINGLE
//   • Fatigue score ≥ 0.5                           → SINGLE
//   • else                                          → NONE
//
// Required delay ladder (seconds, take MAX across rules):
//   • Permission BLOCKED                            → 0     (nothing to delay)
//   • Permission OBSERVE_ONLY                       → 60
//   • Aggression cap = MAX                          → 30
//   • Fatigue forceCooldown                         → 600   (10 min cool-off)
//   • Fatigue score ≥ 0.5                           → 60
//   • Sim P(ruin) > 0.02                            → 30
//   • else                                          → 0
//
// Note: BLOCKED forces the strictest confirmation (MULTI_STEP) so that
// any caller attempting to override gets the highest-friction path.
// ═══════════════════════════════════════════════════════════════════════════

export interface DerivePolicyInput {
  readonly permission: PermissionDecision;
  readonly aggressionLimit: AggressionLimitDecision;
  readonly sizing: SizingDecision;
  readonly simulation: SimulationResult;
  readonly fatigue: FatigueState;
}

function maxConfirmation(
  a: ConfirmationLevel, b: ConfirmationLevel,
): ConfirmationLevel {
  return CONFIRMATION_RANK[a] >= CONFIRMATION_RANK[b] ? a : b;
}

export function derivePolicy(input: DerivePolicyInput): PolicyDecision {
  const reasons: string[] = [];
  let confirmation: ConfirmationLevel = "NONE";
  let delay = 0;

  if (input.permission.allowedPermissionLevel === "BLOCKED") {
    confirmation = maxConfirmation(confirmation, "MULTI_STEP");
    reasons.push("BLOCKED → MULTI_STEP confirmation, no delay");
  }
  if (input.permission.allowedPermissionLevel === "OBSERVE_ONLY") {
    confirmation = maxConfirmation(confirmation, "DOUBLE");
    delay = Math.max(delay, 60);
    reasons.push("OBSERVE_ONLY → DOUBLE confirmation, 60s delay");
  }
  if (input.aggressionLimit.maxAggressionLevel === "MAX") {
    confirmation = maxConfirmation(confirmation, "DOUBLE");
    delay = Math.max(delay, 30);
    reasons.push("aggression cap MAX → DOUBLE confirmation, 30s delay");
  } else if (input.aggressionLimit.maxAggressionLevel === "ELEVATED") {
    confirmation = maxConfirmation(confirmation, "SINGLE");
    reasons.push("aggression cap ELEVATED → SINGLE confirmation");
  }
  if (
    input.sizing.maxPositionSizeR >= 1.5 * input.sizing.baseRiskR
    && input.sizing.baseRiskR > 0
  ) {
    confirmation = maxConfirmation(confirmation, "DOUBLE");
    reasons.push(
      `position ${input.sizing.maxPositionSizeR.toFixed(2)}R ≥ 1.5×base → DOUBLE confirmation`,
    );
  }
  if (input.simulation.approved && input.simulation.ruinProbability01 > 0.02) {
    confirmation = maxConfirmation(confirmation, "SINGLE");
    delay = Math.max(delay, 30);
    reasons.push(
      `sim P(ruin)=${input.simulation.ruinProbability01.toFixed(2)} > 0.02 → SINGLE confirmation, 30s delay`,
    );
  }
  if (input.fatigue.forceCooldown) {
    delay = Math.max(delay, 600);
    reasons.push("fatigue forceCooldown → 10min delay");
  } else if (input.fatigue.fatigueScore01 >= 0.5) {
    confirmation = maxConfirmation(confirmation, "SINGLE");
    delay = Math.max(delay, 60);
    reasons.push(
      `fatigue ${input.fatigue.fatigueScore01.toFixed(2)} ≥ 0.5 → SINGLE confirmation, 60s delay`,
    );
  }

  if (reasons.length === 0) {
    reasons.push("baseline policy: no confirmation, no delay");
  }

  return {
    requiredConfirmation: confirmation,
    requiredDelaySeconds: Math.round(delay),
    reasons,
  };
}
