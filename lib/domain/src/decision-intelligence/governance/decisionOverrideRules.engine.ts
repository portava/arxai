import {
  type AggressionLimitDecision,
  type ConfirmationLevel,
  type GovernanceAction,
  type GovernanceOverride,
  type PermissionDecision,
  type PermissionLevel,
  type PolicyDecision,
  type SizingDecision,
  AGGRESSION_RANK,
  CONFIRMATION_RANK,
  PERMISSION_RANK,
} from "./governance.types";
import { type AggressionLevel } from "../decisionIntelligence.types";
import { LEVEL_MULTIPLIER } from "../adaptiveAggression.engine";

// ═══════════════════════════════════════════════════════════════════════════
// applyOverrides — Risk Governor / Control Tower / Operator overrides.
//
// Overrides are MONOTONIC RESTRICTIONS:
//   • permission     can only be LOWERED   (BLOCKED < OBSERVE_ONLY < … < FULL)
//   • aggression cap can only be LOWERED   (CONSERVATIVE < … < MAX)
//   • position size  can only be LOWERED   (min)
//   • confirmation   can only be RAISED    (NONE < … < MULTI_STEP)
//   • delay seconds  can only be RAISED    (max)
//   • forceRecommendedAction can only RAISE severity (e.g. PROCEED → WAIT)
//
// An override that tries to RELAX a governance decision is silently
// ignored (and recorded in the appliedOverrides audit trail with a
// "ignored: would relax" reason).
// ═══════════════════════════════════════════════════════════════════════════

const ACTION_SEVERITY: Record<GovernanceAction, number> = {
  PROCEED: 0,
  PROCEED_REDUCED: 1,
  WAIT: 2,
  MONITOR_ONLY: 3,
  SOFT_BLOCK: 4,
  HARD_BLOCK: 5,
};

export interface ApplyOverridesInput {
  readonly permission: PermissionDecision;
  readonly aggressionLimit: AggressionLimitDecision;
  readonly sizing: SizingDecision;
  readonly policy: PolicyDecision;
  readonly recommendedAction: GovernanceAction;
  readonly overrides: ReadonlyArray<GovernanceOverride>;
}

export interface ApplyOverridesResult {
  readonly permission: PermissionDecision;
  readonly aggressionLimit: AggressionLimitDecision;
  readonly sizing: SizingDecision;
  readonly policy: PolicyDecision;
  readonly recommendedAction: GovernanceAction;
  readonly appliedOverrides: ReadonlyArray<GovernanceOverride>;
  readonly notes: ReadonlyArray<string>;
}

function lowerPerm(c: PermissionLevel, t: PermissionLevel): PermissionLevel {
  return PERMISSION_RANK[t] < PERMISSION_RANK[c] ? t : c;
}
function lowerAgg(c: AggressionLevel, t: AggressionLevel): AggressionLevel {
  return AGGRESSION_RANK[t] < AGGRESSION_RANK[c] ? t : c;
}
function raiseConf(c: ConfirmationLevel, t: ConfirmationLevel): ConfirmationLevel {
  return CONFIRMATION_RANK[t] > CONFIRMATION_RANK[c] ? t : c;
}
function raiseAction(c: GovernanceAction, t: GovernanceAction): GovernanceAction {
  return ACTION_SEVERITY[t] > ACTION_SEVERITY[c] ? t : c;
}

export function applyOverrides(
  input: ApplyOverridesInput,
): ApplyOverridesResult {
  const notes: string[] = [];
  const applied: GovernanceOverride[] = [];

  let perm = { ...input.permission };
  let agg  = { ...input.aggressionLimit };
  let siz  = { ...input.sizing };
  let pol  = { ...input.policy };
  let act  = input.recommendedAction;

  for (const ov of input.overrides) {
    const before = {
      perm: perm.allowedPermissionLevel,
      agg: agg.maxAggressionLevel,
      sizR: siz.maxPositionSizeR,
      conf: pol.requiredConfirmation,
      delay: pol.requiredDelaySeconds,
      act,
    };
    let touched = false;

    if (ov.maxPermissionLevel !== undefined) {
      const next = lowerPerm(perm.allowedPermissionLevel, ov.maxPermissionLevel);
      if (next !== perm.allowedPermissionLevel) {
        perm = {
          allowedPermissionLevel: next,
          reasons: [...perm.reasons, `${ov.source} override → ${next} (${ov.reason})`],
          blockers: next === "BLOCKED"
            ? [...perm.blockers, `${ov.source}: ${ov.reason}`]
            : perm.blockers,
        };
        touched = true;
      } else if (PERMISSION_RANK[ov.maxPermissionLevel] > PERMISSION_RANK[before.perm]) {
        notes.push(
          `${ov.source} permission override ignored: would relax ${before.perm}→${ov.maxPermissionLevel}`,
        );
      }
    }
    if (ov.maxAggressionLevel !== undefined) {
      const next = lowerAgg(agg.maxAggressionLevel, ov.maxAggressionLevel);
      if (next !== agg.maxAggressionLevel) {
        // Re-clamp the multiplier to the new cap level so the cap and
        // its multiplier remain internally consistent.
        const newMul = Math.min(agg.maxAggressionMultiplier, LEVEL_MULTIPLIER[next]);
        agg = {
          ...agg, maxAggressionLevel: next,
          maxAggressionMultiplier: newMul,
          reasons: [
            ...agg.reasons,
            `${ov.source} override cap → ${next} (×${newMul.toFixed(2)}) (${ov.reason})`,
          ],
        };
        // Sizing must also respect the tighter aggression multiplier.
        if (siz.appliedMultiplier > newMul) {
          const ratio = siz.baseRiskR > 0
            ? newMul / siz.appliedMultiplier
            : 0;
          const newSize = siz.maxPositionSizeR * ratio;
          siz = {
            ...siz,
            appliedMultiplier: newMul,
            maxPositionSizeR: newSize,
            reasons: [
              ...siz.reasons,
              `${ov.source} aggression-cap restriction shrinks size → ${newSize.toFixed(3)}R (×${newMul.toFixed(2)})`,
            ],
          };
        }
        touched = true;
      } else if (AGGRESSION_RANK[ov.maxAggressionLevel] > AGGRESSION_RANK[before.agg]) {
        notes.push(
          `${ov.source} aggression override ignored: would relax ${before.agg}→${ov.maxAggressionLevel}`,
        );
      }
    }
    if (ov.maxPositionSizeR !== undefined) {
      if (ov.maxPositionSizeR < siz.maxPositionSizeR) {
        siz = {
          ...siz,
          maxPositionSizeR: ov.maxPositionSizeR,
          reasons: [...siz.reasons, `${ov.source} cap → ${ov.maxPositionSizeR.toFixed(3)}R (${ov.reason})`],
        };
        touched = true;
      } else if (ov.maxPositionSizeR > siz.maxPositionSizeR) {
        notes.push(
          `${ov.source} sizing override ignored: would relax ${before.sizR.toFixed(3)}R→${ov.maxPositionSizeR.toFixed(3)}R`,
        );
      }
    }
    if (ov.minConfirmation !== undefined) {
      const next = raiseConf(pol.requiredConfirmation, ov.minConfirmation);
      if (next !== pol.requiredConfirmation) {
        pol = {
          ...pol, requiredConfirmation: next,
          reasons: [...pol.reasons, `${ov.source} requires ${next} confirmation (${ov.reason})`],
        };
        touched = true;
      } else if (CONFIRMATION_RANK[ov.minConfirmation] < CONFIRMATION_RANK[before.conf]) {
        notes.push(
          `${ov.source} confirmation override ignored: would relax ${before.conf}→${ov.minConfirmation}`,
        );
      }
    }
    if (ov.minDelaySeconds !== undefined) {
      if (ov.minDelaySeconds > pol.requiredDelaySeconds) {
        pol = {
          ...pol, requiredDelaySeconds: Math.round(ov.minDelaySeconds),
          reasons: [...pol.reasons, `${ov.source} requires ≥${ov.minDelaySeconds}s delay (${ov.reason})`],
        };
        touched = true;
      } else if (ov.minDelaySeconds < pol.requiredDelaySeconds) {
        notes.push(
          `${ov.source} delay override ignored: would relax ${before.delay}s→${ov.minDelaySeconds}s`,
        );
      }
    }
    if (ov.forceRecommendedAction !== undefined) {
      const next = raiseAction(act, ov.forceRecommendedAction);
      if (next !== act) {
        act = next;
        touched = true;
      } else if (ACTION_SEVERITY[ov.forceRecommendedAction] < ACTION_SEVERITY[before.act]) {
        notes.push(
          `${ov.source} action override ignored: would relax ${before.act}→${ov.forceRecommendedAction}`,
        );
      }
    }

    if (touched) applied.push(ov);
  }

  // Re-derive recommendedAction from final permission if a more severe
  // permission was reached (BLOCKED → HARD_BLOCK at minimum).
  if (perm.allowedPermissionLevel === "BLOCKED") act = raiseAction(act, "HARD_BLOCK");
  if (perm.allowedPermissionLevel === "OBSERVE_ONLY") act = raiseAction(act, "MONITOR_ONLY");

  return {
    permission: perm,
    aggressionLimit: agg,
    sizing: siz,
    policy: pol,
    recommendedAction: act,
    appliedOverrides: applied,
    notes,
  };
}
