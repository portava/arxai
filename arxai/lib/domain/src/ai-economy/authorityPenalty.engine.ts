import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Authority Penalty — proposes NARROWING or REVOKING an agent's authority.
//
// Asymmetric severity: a single severe trigger can revoke; mild triggers
// only narrow. Penalty proposals are sent upstream to Control Tower for
// enforcement; Risk Governor still has independent final veto.
//
// Severity tiers:
//   REVOKE_AUTHORITY — drawdownBreach OR governorOverrideAttempt > 0
//                      OR disciplineCollapse (discipline01 < 0.50)
//   NARROW_AUTHORITY — calibrationDrift OR risk breaches > 0
//                      OR sustainedNegativeExpectancy
//   HOLD             — none of the above
// ═══════════════════════════════════════════════════════════════════════════

export const AuthorityPenaltyInputsSchema = z.object({
  agentId: z.string().min(1),
  recentDrawdownPct: z.number().min(0),
  drawdownLimitPct: z.number().positive(),
  riskPolicyBreaches: z.int().nonnegative(),
  governorOverrideAttempts: z.int().nonnegative(),
  discipline01: z.number().min(0).max(1),
  meanCalibrationErrorPct: z.number().min(0),
  expectancyR: z.number(),
  sampleCount: z.int().nonnegative(),
});
export type AuthorityPenaltyInputs = z.infer<typeof AuthorityPenaltyInputsSchema>;

export const AuthorityPenaltyActionSchema = z.enum([
  "HOLD",
  "NARROW_AUTHORITY",
  "REVOKE_AUTHORITY",
]);
export type AuthorityPenaltyAction = z.infer<typeof AuthorityPenaltyActionSchema>;

export const AUTHORITY_PENALTY_THRESHOLDS = {
  // REVOKE triggers
  disciplineCollapseFloor: 0.50,
  drawdownBreachMultiplier: 1.0,             // exceeding limit revokes
  // NARROW triggers
  calibrationDriftPct: 20,                   // meanCalibrationError > 20pp narrows
  // Sustained-negative-expectancy trigger
  negativeExpectancyFloorR: -0.10,
  minSamplesForExpectancyTrigger: 50,
} as const;

export interface AuthorityPenaltyDecision {
  action: AuthorityPenaltyAction;
  agentId: string;
  triggers: string[];
  reasons: string[];
  blockers: string[];
}

export function evaluateAuthorityPenalty(i: AuthorityPenaltyInputs): AuthorityPenaltyDecision {
  const T = AUTHORITY_PENALTY_THRESHOLDS;
  const reasons: string[] = [];
  const blockers: string[] = [];

  const revokeTriggers: string[] = [];
  const narrowTriggers: string[] = [];

  // ── REVOKE checks ───────────────────────────────────────────────────────
  if (i.recentDrawdownPct >= i.drawdownLimitPct * T.drawdownBreachMultiplier) {
    revokeTriggers.push(`drawdown ${i.recentDrawdownPct.toFixed(2)}% breached limit ${i.drawdownLimitPct.toFixed(2)}%`);
  }
  if (i.governorOverrideAttempts > 0) {
    revokeTriggers.push(`governorOverrideAttempts=${i.governorOverrideAttempts} (any attempt is severe)`);
  }
  if (i.discipline01 < T.disciplineCollapseFloor) {
    revokeTriggers.push(`disciplineCollapse ${i.discipline01.toFixed(3)} < ${T.disciplineCollapseFloor}`);
  }

  // ── NARROW checks ───────────────────────────────────────────────────────
  if (i.meanCalibrationErrorPct > T.calibrationDriftPct) {
    narrowTriggers.push(`calibrationDrift ${i.meanCalibrationErrorPct.toFixed(1)}pp > ${T.calibrationDriftPct}pp`);
  }
  if (i.riskPolicyBreaches > 0) {
    narrowTriggers.push(`riskPolicyBreaches=${i.riskPolicyBreaches}`);
  }
  if (i.sampleCount >= T.minSamplesForExpectancyTrigger
      && i.expectancyR < T.negativeExpectancyFloorR) {
    narrowTriggers.push(`sustainedNegativeExpectancy expectancyR=${i.expectancyR.toFixed(3)} < ${T.negativeExpectancyFloorR}`);
  }

  let action: AuthorityPenaltyAction;
  if (revokeTriggers.length > 0) {
    action = "REVOKE_AUTHORITY";
    blockers.push(...revokeTriggers.map((t) => `revoke trigger: ${t}`));
    reasons.push(`severe trigger(s) detected — proposing REVOKE_AUTHORITY`);
  } else if (narrowTriggers.length > 0) {
    action = "NARROW_AUTHORITY";
    blockers.push(...narrowTriggers.map((t) => `narrow trigger: ${t}`));
    reasons.push(`narrow trigger(s) detected — proposing NARROW_AUTHORITY`);
  } else {
    action = "HOLD";
    reasons.push(`no penalty triggers — HOLD`);
  }
  reasons.push(`Risk Governor retains final veto on enforcement`);
  return { action, agentId: i.agentId, triggers: [...revokeTriggers, ...narrowTriggers], reasons, blockers };
}
