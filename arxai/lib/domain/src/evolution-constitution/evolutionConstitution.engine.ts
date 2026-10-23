import { z } from "zod/v4";
import { GOVERNANCE_LAWS } from "./governanceLaws.engine";
import {
  ForbiddenCheckInputsSchema,
  type ForbiddenCheckInputs,
  checkForbiddenMutation,
} from "./forbiddenMutationRules.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Evolution Constitution — single advisory entry point that rules on a
// proposed mutation/promotion. Combines:
//   1. Forbidden-mutation patterns (hard NO)
//   2. Governance laws (referenced, never overridden)
//   3. Sandbox-only requirement (PROJECT RULE)
//
// Output is advisory: blockers go to the Risk Governor / Control Tower.
// ═══════════════════════════════════════════════════════════════════════════

export const ConstitutionRuleInputsSchema = z.object({
  mutationFingerprint: z.string().min(1),
  proposedFromMode: z.enum(["SANDBOX", "SHADOW", "LIVE"]),
  forbidden: ForbiddenCheckInputsSchema,
});
export type ConstitutionRuleInputs = z.infer<typeof ConstitutionRuleInputsSchema>;

export interface ConstitutionRuling {
  permitted: boolean;
  matchedForbiddenPatternIds: string[];
  citedLawIds: string[];
  reasons: string[];
  blockers: string[];
}

export function ruleOnMutation(i: ConstitutionRuleInputs): ConstitutionRuling {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const cited: string[] = [];
  // Project Rule: only sandbox mutations are valid.
  if (i.proposedFromMode !== "SANDBOX") {
    blockers.push(`mode ${i.proposedFromMode} ≠ SANDBOX — refused by L_SANDBOX_ONLY_EVO`);
    cited.push("L_SANDBOX_ONLY_EVO");
  }
  const f = checkForbiddenMutation(i.forbidden);
  if (!f.permitted) {
    cited.push("L_FORBIDDEN_NEVER");
    blockers.push(...f.reasons.map((r) => `forbidden: ${r}`));
  }
  // Always cite the constitutional umbrella laws.
  cited.push("L_VAULT_AUDIT");
  const permitted = blockers.length === 0;
  reasons.push(permitted
    ? `constitution: PERMITTED (cited ${cited.length} law(s))`
    : `constitution: REFUSED (${blockers.length} blocker(s))`);
  return {
    permitted,
    matchedForbiddenPatternIds: f.matchedPatternIds,
    citedLawIds: cited,
    reasons,
    blockers,
  };
}

export function constitutionPreamble(): string[] {
  return GOVERNANCE_LAWS.map((l) => `${l.id}: ${l.text}`);
}
