// ═══════════════════════════════════════════════════════════════════════════
// Confirmation Policy
//
// When risk is meaningful, every entry should require an explicit
// human-in-the-loop confirmation step. This policy outputs the kind of
// confirmation that should be enforced by the Control Tower:
//
//   NONE              — no confirmation
//   ONE_CLICK         — single click "I confirm"
//   CHECKLIST         — must tick a setup checklist
//   TWO_STEP          — confirm + cooldown timer (e.g. 30s) before send
//   WRITTEN_RATIONALE — short typed rationale required
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";

export const ConfirmationKindSchema = z.enum([
  "NONE", "ONE_CLICK", "CHECKLIST", "TWO_STEP", "WRITTEN_RATIONALE",
]);
export type ConfirmationKind = z.infer<typeof ConfirmationKindSchema>;

export const ConfirmationPolicySchema = z.object({
  kind: ConfirmationKindSchema,
  cooldownSecondsBeforeSend: z.number().int().nonnegative(),
  requireWrittenRationale: z.boolean(),
  reasons: z.array(z.string()),
});
export type ConfirmationPolicy = z.infer<typeof ConfirmationPolicySchema>;

export interface ConfirmationInput {
  severity01: number;
  baselineMature: boolean;
}

export function recommendConfirmationPolicy(input: ConfirmationInput): ConfirmationPolicy {
  const reasons: string[] = [];
  let kind: ConfirmationKind = "NONE";
  let cooldownSecondsBeforeSend = 0;
  let requireWrittenRationale = false;

  if (input.severity01 >= 0.65)      { kind = "WRITTEN_RATIONALE"; cooldownSecondsBeforeSend = 60; requireWrittenRationale = true;  reasons.push("severity ≥0.65 → written rationale + 60s cooldown"); }
  else if (input.severity01 >= 0.50) { kind = "TWO_STEP";          cooldownSecondsBeforeSend = 30;                                  reasons.push("severity ≥0.50 → two-step confirm + 30s cooldown"); }
  else if (input.severity01 >= 0.35) { kind = "CHECKLIST";                                                                          reasons.push("severity ≥0.35 → setup checklist required"); }
  else if (input.severity01 >= 0.25) { kind = "ONE_CLICK";                                                                          reasons.push("severity ≥0.25 → single-click confirm"); }
  else if (!input.baselineMature)    { kind = "ONE_CLICK";                                                                          reasons.push("baseline immature → single-click confirm by default"); }
  else                               {                                                                                              reasons.push("no confirmation required"); }

  return { kind, cooldownSecondsBeforeSend, requireWrittenRationale, reasons };
}
