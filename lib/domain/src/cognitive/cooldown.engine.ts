// ═══════════════════════════════════════════════════════════════════════════
// Cooldown Engine
//
// Composes cognitive verdict + revenge/overtrade signals + trader risk into
// a cooldown plan: kind (NONE/COOLDOWN/RECOVERY_MODE/LOCKDOWN), duration,
// recovery checklist (firm but not shaming), and a `forcesRecovery` flag
// the Control Tower consumes.
//
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import {
  type CognitiveVerdict, type EmotionalDegradation,
} from "./cognitive.types";
import type { CognitiveRiskScore } from "./cognitiveState.types";
import type { RevengeTradeReport } from "../trader-dna/revengeTradingDetector.engine";
import type { OvertradeReport } from "../trader-dna/overtradeGuard.engine";
import type { TraderRiskScore } from "../trader-dna/traderDNA.types";

export const CooldownKindSchema = z.enum([
  "NONE", "COOLDOWN", "RECOVERY_MODE", "LOCKDOWN",
]);
export type CooldownKind = z.infer<typeof CooldownKindSchema>;

export const CooldownPlanSchema = z.object({
  kind: CooldownKindSchema,
  durationMinutes: z.number().nonnegative(),
  forcesRecovery: z.boolean(),       // Control Tower consumes this
  forcesLockdown: z.boolean(),
  recoveryChecklist: z.array(z.string()),
  message: z.string(),               // firm-but-respectful trader-facing text
  reasons: z.array(z.string()),
});
export type CooldownPlan = z.infer<typeof CooldownPlanSchema>;

export interface CooldownInput {
  cognitive: CognitiveVerdict;
  cognitiveRisk: CognitiveRiskScore;
  emotional: EmotionalDegradation;
  revenge?: RevengeTradeReport | null;
  overtrade?: OvertradeReport | null;
  trader?: TraderRiskScore;
}

export function planCooldown(input: CooldownInput): CooldownPlan {
  const reasons: string[] = [];

  const traderLockdown = input.trader?.permission === "LOCKDOWN";
  const traderCooldown = input.trader?.permission === "COOLDOWN";

  // Hard order: trader-LOCKDOWN > revenge HIGH/CRITICAL > acute stress > fatigue/load critical
  let kind: CooldownKind = "NONE";
  let durationMinutes = 0;
  let forcesRecovery = false;
  let forcesLockdown = false;

  if (traderLockdown) {
    kind = "LOCKDOWN"; durationMinutes = 240; forcesLockdown = true;
    reasons.push(`trader risk LOCKDOWN — 4h hard pause`);
  } else if (input.revenge?.detected && (input.revenge.severity === "CRITICAL" || input.revenge.severity === "HIGH")) {
    kind = "COOLDOWN"; durationMinutes = 60;
    reasons.push(`revenge trading ${input.revenge.severity} — 60m cooldown`);
  } else if (input.emotional.revengeRiskFlag) {
    kind = "COOLDOWN"; durationMinutes = 45;
    reasons.push(`revenge-risk flag — 45m cooldown`);
  } else if (traderCooldown) {
    // Trader DNA explicit COOLDOWN recommendation — honor it as COOLDOWN, not RECOVERY_MODE.
    kind = "COOLDOWN"; durationMinutes = Math.max(30, input.cognitive.cooldownMinutes);
    reasons.push(`trader DNA permission COOLDOWN — ${durationMinutes}m`);
  } else if (input.cognitive.permission === "COOLDOWN") {
    kind = "COOLDOWN"; durationMinutes = input.cognitive.cooldownMinutes;
    reasons.push(`cognitive verdict COOLDOWN ${durationMinutes}m`);
  } else if (input.cognitive.permission === "RECOVERY_MODE") {
    kind = "RECOVERY_MODE"; durationMinutes = Math.max(30, input.cognitive.cooldownMinutes);
    forcesRecovery = true;
    reasons.push(`cognitive verdict RECOVERY_MODE — ${durationMinutes}m`);
  } else if (input.overtrade?.detected && input.overtrade.recommendBlock) {
    kind = "COOLDOWN"; durationMinutes = 30;
    reasons.push(`overtrading ${input.overtrade.severity} — 30m cooldown`);
  } else if (input.cognitiveRisk.level === "HIGH" || input.cognitiveRisk.level === "CRITICAL") {
    kind = "RECOVERY_MODE"; durationMinutes = 30; forcesRecovery = true;
    reasons.push(`cognitive risk ${input.cognitiveRisk.level} — recovery 30m`);
  }

  if (kind === "RECOVERY_MODE") forcesRecovery = true;
  if (kind === "LOCKDOWN")      forcesLockdown = true;

  const checklist = buildChecklist(kind, input);
  const message = buildMessage(kind, durationMinutes, input);

  return {
    kind, durationMinutes,
    forcesRecovery, forcesLockdown,
    recoveryChecklist: checklist,
    message, reasons,
  };
}

// ── Helpers — firm-but-respectful copy. Never shames the trader. ────────
function buildChecklist(kind: CooldownKind, i: CooldownInput): string[] {
  if (kind === "NONE") return [];
  const items: string[] = [];
  if (i.revenge?.detected || i.emotional.revengeRiskFlag) {
    items.push("Step away from the screen for the cooldown duration");
    items.push("Review the last losing trade in your journal — entry vs plan");
  }
  if (i.overtrade?.detected) items.push("Audit today's trades — were any outside your strategy plan?");
  if (i.cognitive.fatigue.fatigue01 >= 0.55) items.push("Take a 15-minute physical break (water, stretch, daylight)");
  if (i.cognitive.stress.acuteSpike) items.push("3 minutes of slow breathing before reviewing the dashboard");
  if (kind === "RECOVERY_MODE" || kind === "LOCKDOWN") {
    items.push("Resume only on micro-lots and only A-grade setups for the next session");
    items.push("Confirm cooldown completion in the dashboard before any new entry");
  }
  return items;
}
function buildMessage(kind: CooldownKind, mins: number, _i: CooldownInput): string {
  if (kind === "NONE")        return "Cognitive state is stable. Trade your plan.";
  if (kind === "COOLDOWN")    return `Pausing trading for ${mins} minutes. This is protective — not a judgment of you.`;
  if (kind === "RECOVERY_MODE") return `Switching to recovery mode for ${mins} minutes. Smaller size, only A-grade setups. You'll be back to full size shortly.`;
  return `Hard pause for ${mins} minutes. Use the time to reset; the system will re-enable trading after a full review.`;
}
