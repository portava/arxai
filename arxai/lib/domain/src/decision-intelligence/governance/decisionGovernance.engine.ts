import {
  type ConvictionReport,
  type DecisionQualityScore,
  type ExpectancyMetrics,
  type FatigueState,
  type MarketPersonality,
  type SimulationResult,
  type AdaptiveAggression,
} from "../decisionIntelligence.types";
import {
  type DecisionGovernanceVerdict,
  type GovernanceAction,
  type GovernanceOverride,
  type PermissionLevel,
} from "./governance.types";
import { derivePermission } from "./decisionPermission.engine";
import { deriveAggressionLimit } from "./aggressionLimit.engine";
import { deriveSizingMultiplier } from "./convictionToSizing.engine";
import { derivePolicy } from "./decisionPolicy.engine";
import { applyOverrides } from "./decisionOverrideRules.engine";

// ═══════════════════════════════════════════════════════════════════════════
// runDecisionGovernance — top-level governance pipeline.
//
// Pure function. Consumes the recomputed Decision Intelligence sub-results
// and an optional ordered list of external overrides, and returns the
// enforceable governance verdict.
//
// Contract (acceptance criteria):
//   • Decision quality       → permission level
//   • Conviction calibration → aggression cap and sizing multiplier
//   • Survival impact        → can REDUCE (sizing) or BLOCK (permission)
//   • Future risk score      → forces WAIT / REDUCE_SIZE / SOFT_BLOCK / HARD_BLOCK
//   • No-trade decisions are scored elsewhere; they do not consume sizing
//     here, but their score is recorded in `noTradeQualityScore01`.
//   • Bad winning trades reduce trust → drag conviction calibration down
//     over time → tighter aggression cap and sizing.
//   • Good losing trades do not reduce trust → calibration stays intact.
// ═══════════════════════════════════════════════════════════════════════════

export interface RunDecisionGovernanceInput {
  readonly candidateId: string;
  readonly decisionQuality: DecisionQualityScore;
  readonly expectancy: ExpectancyMetrics;
  readonly conviction: ConvictionReport;
  readonly fatigue: FatigueState;
  readonly market: MarketPersonality;
  readonly simulation: SimulationResult;
  readonly aggression: AdaptiveAggression;
  readonly patienceMode:
    | "PROCEED" | "WAIT" | "MONITOR_ONLY"
    | "SOFT_BLOCK" | "HARD_BLOCK";
  readonly baseRiskR: number;
  readonly overrides?: ReadonlyArray<GovernanceOverride>;
}

function baseRecommendedAction(
  permission: PermissionLevel,
  patienceMode: RunDecisionGovernanceInput["patienceMode"],
  sim: SimulationResult,
  aggressionMul: number,
): GovernanceAction {
  if (permission === "BLOCKED" || patienceMode === "HARD_BLOCK") return "HARD_BLOCK";
  if (!sim.approved) return "HARD_BLOCK";
  if (patienceMode === "SOFT_BLOCK") return "SOFT_BLOCK";
  if (permission === "OBSERVE_ONLY" || patienceMode === "MONITOR_ONLY") return "MONITOR_ONLY";
  if (patienceMode === "WAIT") return "WAIT";
  if (sim.ruinProbability01 > 0.05) return "WAIT";
  if (permission === "REDUCED" || aggressionMul < 0.8) return "PROCEED_REDUCED";
  return "PROCEED";
}

function plainEnglish(
  action: GovernanceAction, perm: PermissionLevel,
  maxR: number, baseR: number,
): string {
  const head =
      action === "HARD_BLOCK"      ? "Do not trade. A hard governance gate is engaged."
    : action === "SOFT_BLOCK"      ? "Hold off. Process or expectancy does not support a trade."
    : action === "MONITOR_ONLY"    ? "Watch only. Conditions are unstable; do not stage an order."
    : action === "WAIT"            ? "Wait briefly. Let conditions settle before acting."
    : action === "PROCEED_REDUCED" ? "Proceed at reduced size. Caps were tightened by governance."
    :                                "Proceed normally within governance caps.";
  const sizeNote = baseR > 0
    ? ` Position cap: ${maxR.toFixed(3)}R (base ${baseR.toFixed(3)}R).`
    : "";
  return `${head} Permission=${perm}.${sizeNote}`;
}

export function runDecisionGovernance(
  input: RunDecisionGovernanceInput,
): DecisionGovernanceVerdict {
  const permission = derivePermission({
    decisionQuality: input.decisionQuality,
    expectancy: input.expectancy,
    fatigue: input.fatigue,
    simulation: input.simulation,
    patienceMode: input.patienceMode,
  });
  const aggressionLimit = deriveAggressionLimit({
    conviction: input.conviction,
    aggression: input.aggression,
    market: input.market,
    fatigue: input.fatigue,
  });
  const sizing = deriveSizingMultiplier({
    baseRiskR: input.baseRiskR,
    conviction: input.conviction,
    decisionQuality: input.decisionQuality,
    expectancy: input.expectancy,
    simulation: input.simulation,
    aggressionLimit,
  });
  const policy = derivePolicy({
    permission, aggressionLimit, sizing,
    simulation: input.simulation,
    fatigue: input.fatigue,
  });

  const baseAction = baseRecommendedAction(
    permission.allowedPermissionLevel,
    input.patienceMode,
    input.simulation,
    aggressionLimit.maxAggressionMultiplier,
  );

  const overridden = applyOverrides({
    permission, aggressionLimit, sizing, policy,
    recommendedAction: baseAction,
    overrides: input.overrides ?? [],
  });

  const reasons: string[] = [];
  reasons.push(`permission=${overridden.permission.allowedPermissionLevel}`);
  reasons.push(`aggression cap=${overridden.aggressionLimit.maxAggressionLevel}`);
  reasons.push(`maxPositionSizeR=${overridden.sizing.maxPositionSizeR.toFixed(3)} (×${overridden.sizing.appliedMultiplier.toFixed(2)})`);
  reasons.push(`confirmation=${overridden.policy.requiredConfirmation}, delay=${overridden.policy.requiredDelaySeconds}s`);
  reasons.push(`recommendedAction=${overridden.recommendedAction}`);
  if (overridden.notes.length) reasons.push(...overridden.notes);

  const reason =
    overridden.permission.blockers[0]
    ?? overridden.permission.reasons[0]
    ?? `governance: ${overridden.recommendedAction}`;

  return {
    candidateId: input.candidateId,
    allowedPermissionLevel: overridden.permission.allowedPermissionLevel,
    maxAggressionLevel: overridden.aggressionLimit.maxAggressionLevel,
    maxPositionSize: overridden.sizing.maxPositionSizeR,
    requiredConfirmation: overridden.policy.requiredConfirmation,
    requiredDelay: overridden.policy.requiredDelaySeconds,
    recommendedAction: overridden.recommendedAction,
    reason,
    permission: overridden.permission,
    aggressionLimit: overridden.aggressionLimit,
    sizing: overridden.sizing,
    policy: overridden.policy,
    appliedOverrides: [...overridden.appliedOverrides],
    reasons,
    plainEnglishExplanation: plainEnglish(
      overridden.recommendedAction,
      overridden.permission.allowedPermissionLevel,
      overridden.sizing.maxPositionSizeR,
      input.baseRiskR,
    ),
  };
}
