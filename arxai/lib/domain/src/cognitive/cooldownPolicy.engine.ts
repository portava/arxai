// ═══════════════════════════════════════════════════════════════════════════
// Cooldown Policy
//
// Adjustable cooldown recommendation based on severity AND context. The
// existing cooldown.engine produces a *hard* plan; this engine produces an
// adjustable *policy* the operator UI can tune. Knobs:
//
//   • baselineMature?           true → harsher cooldowns trusted; false → softer
//   • repeatOffenseCount        recent COOLDOWN/RECOVERY events for this trader
//   • disciplineScore01         lower discipline → longer cooldowns
//   • severityScore01           composite risk evidence
//   • allowConfirmedOverride    if true, trader can confirm-and-continue at MEDIUM
//
// Output: kind + duration + flags + tradersFacingMessage + checklist.
// Always firm but never shaming.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";

export const CooldownPolicyKindSchema = z.enum([
  "NONE", "SOFT_COOLDOWN", "COOLDOWN", "RECOVERY_MODE", "LOCKDOWN",
]);
export type CooldownPolicyKind = z.infer<typeof CooldownPolicyKindSchema>;

export const CooldownPolicySchema = z.object({
  kind: CooldownPolicyKindSchema,
  durationMinutes: z.number().nonnegative(),
  forcesRecovery: z.boolean(),
  forcesLockdown: z.boolean(),
  allowConfirmedOverride: z.boolean(),
  recoveryChecklist: z.array(z.string()),
  message: z.string(),
  reasons: z.array(z.string()),
});
export type CooldownPolicy = z.infer<typeof CooldownPolicySchema>;

export interface CooldownPolicyInput {
  severityScore01: number;       // 0..1 composite
  baselineMature: boolean;
  repeatOffenseCount: number;    // 0..n
  disciplineScore01: number;     // 0..1, higher better
  allowConfirmedOverride?: boolean;
}

export function recommendCooldownPolicy(input: CooldownPolicyInput): CooldownPolicy {
  const reasons: string[] = [];
  const repeats = Math.max(0, input.repeatOffenseCount);
  const discMult = 1 + Math.max(0, 0.5 - input.disciplineScore01) * 1.5;   // weak discipline lengthens
  const repeatMult = 1 + Math.min(2, repeats * 0.35);
  const matureMult = input.baselineMature ? 1.0 : 0.6;

  let kind: CooldownPolicyKind = "NONE";
  let baseMinutes = 0;
  let forcesRecovery = false;
  let forcesLockdown = false;
  let allowConfirmedOverride = !!input.allowConfirmedOverride;

  if (input.severityScore01 >= 0.85) {
    kind = "LOCKDOWN"; baseMinutes = 240; forcesLockdown = true;
    allowConfirmedOverride = false;
    reasons.push(`severity ${input.severityScore01.toFixed(2)} ≥ 0.85 → LOCKDOWN base 240m`);
  } else if (input.severityScore01 >= 0.65) {
    kind = "RECOVERY_MODE"; baseMinutes = 60; forcesRecovery = true;
    allowConfirmedOverride = false;
    reasons.push(`severity ${input.severityScore01.toFixed(2)} ≥ 0.65 → RECOVERY_MODE base 60m`);
  } else if (input.severityScore01 >= 0.45) {
    kind = "COOLDOWN"; baseMinutes = 30;
    reasons.push(`severity ${input.severityScore01.toFixed(2)} ≥ 0.45 → COOLDOWN base 30m`);
  } else if (input.severityScore01 >= 0.25) {
    kind = "SOFT_COOLDOWN"; baseMinutes = 10;
    reasons.push(`severity ${input.severityScore01.toFixed(2)} ≥ 0.25 → SOFT_COOLDOWN base 10m`);
  } else {
    reasons.push(`severity ${input.severityScore01.toFixed(2)} → no cooldown`);
  }

  const adjusted = Math.round(baseMinutes * discMult * repeatMult * matureMult);
  reasons.push(`adjusted: discipline×${discMult.toFixed(2)} · repeats×${repeatMult.toFixed(2)} · mature×${matureMult.toFixed(2)} → ${adjusted}m`);

  const checklist = buildChecklist(kind);
  const message = buildMessage(kind, adjusted);

  return {
    kind,
    durationMinutes: adjusted,
    forcesRecovery, forcesLockdown,
    allowConfirmedOverride: allowConfirmedOverride && (kind === "SOFT_COOLDOWN" || kind === "COOLDOWN"),
    recoveryChecklist: checklist,
    message, reasons,
  };
}

function buildChecklist(kind: CooldownPolicyKind): string[] {
  if (kind === "NONE") return [];
  const items = ["Step away from the chart for the cooldown duration"];
  if (kind === "SOFT_COOLDOWN") items.push("Re-read the last setup notes before the next entry");
  if (kind === "COOLDOWN") {
    items.push("Review the last losing trade — entry vs plan");
    items.push("Confirm the next entry is an A-grade setup");
  }
  if (kind === "RECOVERY_MODE") {
    items.push("Drop to micro-lots for the next session");
    items.push("Only A-grade setups; require written rationale");
  }
  if (kind === "LOCKDOWN") {
    items.push("Run a full post-mortem on today's session");
    items.push("Re-enable trading only after a confirmation step");
  }
  return items;
}
function buildMessage(kind: CooldownPolicyKind, mins: number): string {
  switch (kind) {
    case "NONE":          return "Cognitive state stable. Trade your plan.";
    case "SOFT_COOLDOWN": return `Brief ${mins}m pause recommended. Resume after a quick reset.`;
    case "COOLDOWN":      return `Pausing trading for ${mins} minutes. Protective — not a judgment.`;
    case "RECOVERY_MODE": return `Recovery mode for ${mins} minutes. Smaller size, A-grade setups only.`;
    case "LOCKDOWN":      return `Hard pause for ${mins} minutes. Use the time to reset; trading re-enables after review.`;
  }
}
