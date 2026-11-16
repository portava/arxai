import { z } from "zod/v4";
import { AuthoritySchema, type Authority, authorityRank } from "./authorityHierarchy.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Emergency Veto — short-circuit power. ONLY the highest authorities can
// emergency-veto an action. If the authority isn't ranked high enough, the
// veto is REFUSED with a reason.
// ═══════════════════════════════════════════════════════════════════════════

export const EmergencyVetoInputsSchema = z.object({
  invokingAuthority: AuthoritySchema,
  proposedAction: z.string().min(1),
  reason: z.string().min(1),
  ecosystemFitness01: z.number().min(0).max(1).optional(),
  systemicFragility01: z.number().min(0).max(1).optional(),
});
export type EmergencyVetoInputs = z.infer<typeof EmergencyVetoInputsSchema>;

export interface EmergencyVetoDecision {
  vetoApproved: boolean;
  invokingAuthority: Authority;
  proposedAction: string;
  reasons: string[];
  blockers: string[];
}

const VETO_ELIGIBLE_RANK_MAX = 2; // KILL_SWITCH, RISK_GOVERNOR, CONTROL_TOWER

export function evaluateEmergencyVeto(
  i: EmergencyVetoInputs,
): EmergencyVetoDecision {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const rank = authorityRank(i.invokingAuthority);
  if (rank > VETO_ELIGIBLE_RANK_MAX) {
    blockers.push(`authority ${i.invokingAuthority} (rank ${rank}) not eligible to veto — must be rank ≤ ${VETO_ELIGIBLE_RANK_MAX}`);
    reasons.push(`emergency veto REFUSED`);
    return {
      vetoApproved: false,
      invokingAuthority: i.invokingAuthority,
      proposedAction: i.proposedAction,
      reasons,
      blockers,
    };
  }
  reasons.push(`emergency veto APPROVED — ${i.invokingAuthority} blocks "${i.proposedAction}" (${i.reason})`);
  if (typeof i.ecosystemFitness01 === "number") reasons.push(`ecosystemFitness=${i.ecosystemFitness01.toFixed(3)}`);
  if (typeof i.systemicFragility01 === "number") reasons.push(`systemicFragility=${i.systemicFragility01.toFixed(3)}`);
  return {
    vetoApproved: true,
    invokingAuthority: i.invokingAuthority,
    proposedAction: i.proposedAction,
    reasons,
    blockers,
  };
}
