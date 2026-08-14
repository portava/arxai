// ═══════════════════════════════════════════════════════════════════════════
// Personal Risk Prescription
//
// Composes all behavior + cognitive evidence + sub-policies into a single
// concrete prescription the Control Tower can enforce. Trader DNA does
// not just warn — it prescribes:
//
//   • prescriptionLevel        — coarse intent (NONE..LOCKDOWN)
//   • restrictedActions[]      — what the trader may NOT do
//   • allowedActions[]         — what the trader MAY do
//   • recoveryRequirements[]   — what the trader must do to recover
//   • permissionRestoreConditions[] — checkable conditions
//   • explanation              — neutral language summary
//   • hardBlock                — true when severity demands governor block
//
// Pure. No I/O. Deterministic given inputs.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import {
  recommendSizingThrottle, SizingThrottleSchema,
} from "./sizingThrottlePolicy.engine";
import {
  recommendTradeLimitPolicy, TradeLimitPolicySchema,
} from "./tradeLimitPolicy.engine";
import {
  recommendConfirmationPolicy, ConfirmationPolicySchema,
} from "./confirmationPolicy.engine";
import {
  recommendPaperModeFallback, PaperModeFallbackSchema,
} from "./paperModeFallback.engine";
import {
  buildRecoveryProtocol, RecoveryProtocolSchema,
} from "./recoveryProtocol.engine";
import { type EdgeFingerprint } from "../edgeFingerprint.engine";

export const PrescriptionLevelSchema = z.enum([
  "NONE", "ADVISORY", "REDUCED", "RESTRICTED", "RECOVERY", "PAPER_ONLY", "LOCKDOWN",
]);
export type PrescriptionLevel = z.infer<typeof PrescriptionLevelSchema>;

export const RestrictedActionSchema = z.enum([
  "FULL_SIZE_TRADES",
  "NEW_TRADES",
  "AUTO_EXECUTION",
  "OVERRIDE_RISK_CAPS",
  "BYPASS_FILTERS",
  "TRADE_RESTRICTED_SYMBOLS",
  "TRADE_RESTRICTED_SESSIONS",
  "RAPID_ENTRIES",
  "LIVE_ORDERS",
]);
export type RestrictedAction = z.infer<typeof RestrictedActionSchema>;

export const AllowedActionSchema = z.enum([
  "FULL_SIZE_TRADES",
  "REDUCED_SIZE_TRADES",
  "MICRO_LOT_TRADES",
  "A_PLUS_SETUPS_ONLY",
  "PAPER_TRADES_ONLY",
  "EDIT_OPEN_TRADES",
  "CLOSE_OPEN_TRADES",
  "REVIEW_ONLY",
]);
export type AllowedAction = z.infer<typeof AllowedActionSchema>;

export const PersonalRiskPrescriptionSchema = z.object({
  prescriptionLevel: PrescriptionLevelSchema,
  severity01: z.number().min(0).max(1),
  hardBlock: z.boolean(),
  restrictedActions: z.array(RestrictedActionSchema),
  allowedActions: z.array(AllowedActionSchema),
  recoveryRequirements: z.array(z.string()),
  permissionRestoreConditions: RecoveryProtocolSchema.shape.permissionRestoreConditions,
  policies: z.object({
    sizing: SizingThrottleSchema,
    tradeLimit: TradeLimitPolicySchema,
    confirmation: ConfirmationPolicySchema,
    paperMode: PaperModeFallbackSchema,
  }),
  cooldownMinutes: z.number().nonnegative(),
  explanation: z.string(),
  reasons: z.array(z.string()),
});
export type PersonalRiskPrescription = z.infer<typeof PersonalRiskPrescriptionSchema>;

export interface PrescriptionInput {
  // Composite scores (already produced upstream)
  traderRiskScore01:        number;
  behaviorEvidenceScore01:  number;
  cognitiveRiskScore01:     number;
  disciplineScore01:        number;
  postLossRiskScore01?:     number;
  drawdownRiskScore01?:     number;
  baselineMature:           boolean;
  baselineLotSize:          number;
  ruleViolationsLast24h:    number;
  cooldownMinutes:          number;
  forcePaperOnly?:          boolean;
  // Personal danger fingerprint (symbols/sessions to restrict)
  dangerFingerprint?:       EdgeFingerprint | null;
}

export function buildPersonalRiskPrescription(input: PrescriptionInput): PersonalRiskPrescription {
  const reasons: string[] = [];
  // Worst-axis severity drives the prescription
  const severity01 = clamp01(Math.max(
    input.traderRiskScore01,
    input.behaviorEvidenceScore01,
    input.cognitiveRiskScore01,
    1 - input.disciplineScore01,
    input.postLossRiskScore01 ?? 0,
    input.drawdownRiskScore01 ?? 0,
  ));
  reasons.push(`worst-axis severity ${severity01.toFixed(2)} (trader ${input.traderRiskScore01.toFixed(2)} · evidence ${input.behaviorEvidenceScore01.toFixed(2)} · cognitive ${input.cognitiveRiskScore01.toFixed(2)} · disc-deficit ${(1-input.disciplineScore01).toFixed(2)} · post-loss ${(input.postLossRiskScore01 ?? 0).toFixed(2)} · drawdown ${(input.drawdownRiskScore01 ?? 0).toFixed(2)})`);

  // Sub-policies
  const sizing = recommendSizingThrottle({
    severity01,
    baselineLotSize: input.baselineLotSize,
    forceMicro: severity01 >= 0.50,
  });
  const tradeLimit = recommendTradeLimitPolicy({
    severity01, dangerFingerprint: input.dangerFingerprint ?? null,
  });
  const confirmation = recommendConfirmationPolicy({
    severity01, baselineMature: input.baselineMature,
  });
  const paperMode = recommendPaperModeFallback({
    severity01,
    baselineMature: input.baselineMature,
    ruleViolationsLast24h: input.ruleViolationsLast24h,
    forcePaperOnly: input.forcePaperOnly,
  });

  // Coarse level
  let prescriptionLevel: PrescriptionLevel;
  if (input.forcePaperOnly && severity01 < 0.65) prescriptionLevel = "PAPER_ONLY";
  else if (severity01 >= 0.85) prescriptionLevel = "LOCKDOWN";
  else if (severity01 >= 0.65) prescriptionLevel = "PAPER_ONLY";
  else if (severity01 >= 0.50) prescriptionLevel = "RECOVERY";
  else if (severity01 >= 0.35) prescriptionLevel = "RESTRICTED";
  else if (severity01 >= 0.25) prescriptionLevel = "REDUCED";
  else if (!input.baselineMature) prescriptionLevel = "ADVISORY";
  else prescriptionLevel = "NONE";

  // Restricted / allowed action sets
  const restricted = new Set<RestrictedAction>();
  const allowed    = new Set<AllowedAction>();

  if (prescriptionLevel !== "NONE") {
    restricted.add("OVERRIDE_RISK_CAPS");
    restricted.add("BYPASS_FILTERS");
    restricted.add("RAPID_ENTRIES");
  }
  if (sizing.microLotsOnly || prescriptionLevel === "RESTRICTED" || prescriptionLevel === "RECOVERY"
      || prescriptionLevel === "PAPER_ONLY" || prescriptionLevel === "LOCKDOWN") {
    restricted.add("FULL_SIZE_TRADES");
  }
  if (tradeLimit.restrictedSymbols.length > 0)  restricted.add("TRADE_RESTRICTED_SYMBOLS");
  if (tradeLimit.restrictedSessions.length > 0) restricted.add("TRADE_RESTRICTED_SESSIONS");
  if (paperMode.forced || prescriptionLevel === "PAPER_ONLY" || prescriptionLevel === "LOCKDOWN") {
    restricted.add("LIVE_ORDERS");
    restricted.add("AUTO_EXECUTION");
  }
  if (prescriptionLevel === "LOCKDOWN") restricted.add("NEW_TRADES");

  // Allowed
  if (prescriptionLevel === "NONE" || prescriptionLevel === "ADVISORY") {
    allowed.add("FULL_SIZE_TRADES");
  }
  if (prescriptionLevel === "REDUCED" || prescriptionLevel === "RESTRICTED") {
    allowed.add("REDUCED_SIZE_TRADES");
  }
  if (sizing.microLotsOnly) {
    allowed.add("MICRO_LOT_TRADES");
  }
  if (tradeLimit.aPlusOnly) allowed.add("A_PLUS_SETUPS_ONLY");
  if (paperMode.forced || prescriptionLevel === "PAPER_ONLY") allowed.add("PAPER_TRADES_ONLY");
  // Always permit closing open trades and reviewing — never trap a trader in a position
  allowed.add("CLOSE_OPEN_TRADES");
  allowed.add("EDIT_OPEN_TRADES");
  allowed.add("REVIEW_ONLY");
  if (prescriptionLevel === "LOCKDOWN") {
    // No live entries during LOCKDOWN, but paper trading must remain
    // available so the trader can satisfy the PAPER_TRADE_WINS recovery
    // condition. Otherwise restoration becomes impossible (deadlock).
    allowed.delete("FULL_SIZE_TRADES");
    allowed.delete("REDUCED_SIZE_TRADES");
    allowed.delete("MICRO_LOT_TRADES");
    allowed.add("PAPER_TRADES_ONLY");
    reasons.push("LOCKDOWN keeps PAPER_TRADES_ONLY allowed so recovery (paper wins) is reachable");
  }

  const recovery = buildRecoveryProtocol({
    severity01,
    baselineMature: input.baselineMature,
    paperModeForced: paperMode.forced,
    requiredPaperWins: paperMode.requiredPaperWinsToRestore,
    minPaperWinRate: paperMode.minPaperWinRate,
    cooldownMinutes: input.cooldownMinutes,
  });

  const hardBlock = severity01 >= 0.85;
  if (hardBlock) reasons.push("severity ≥0.85 — Risk Governor hard block recommended");

  const explanation = neutralExplanation({
    level: prescriptionLevel, severity01,
    sizing, tradeLimit, confirmation, paperMode,
  });

  return {
    prescriptionLevel,
    severity01,
    hardBlock,
    restrictedActions: Array.from(restricted),
    allowedActions: Array.from(allowed),
    recoveryRequirements: recovery.recoveryRequirements,
    permissionRestoreConditions: recovery.permissionRestoreConditions,
    policies: { sizing, tradeLimit, confirmation, paperMode },
    cooldownMinutes: input.cooldownMinutes,
    explanation, reasons,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────
function neutralExplanation(args: {
  level: PrescriptionLevel; severity01: number;
  sizing: ReturnType<typeof recommendSizingThrottle>;
  tradeLimit: ReturnType<typeof recommendTradeLimitPolicy>;
  confirmation: ReturnType<typeof recommendConfirmationPolicy>;
  paperMode: ReturnType<typeof recommendPaperModeFallback>;
}): string {
  const parts: string[] = [];
  switch (args.level) {
    case "NONE":       return "No restrictions — behavior consistent with personal baseline.";
    case "ADVISORY":   parts.push("Advisory mode while personal baseline builds."); break;
    case "REDUCED":    parts.push(`Reduced posture: size ×${args.sizing.sizeMultiplier.toFixed(2)}, max ${args.tradeLimit.maxTradesPerSession} trades/session.`); break;
    case "RESTRICTED": parts.push(`Restricted posture: size ×${args.sizing.sizeMultiplier.toFixed(2)}, max ${args.tradeLimit.maxTradesPerSession} trades/session, ${args.confirmation.kind} confirmation.`); break;
    case "RECOVERY":   parts.push(`Recovery mode: micro size, A+ setups only, ${args.confirmation.kind} confirmation.`); break;
    case "PAPER_ONLY": parts.push(`Paper mode: live orders paused. Restore via ${args.paperMode.requiredPaperWinsToRestore} winning paper trades.`); break;
    case "LOCKDOWN":   parts.push(`Hard pause: no new entries until cooldown completes and recovery conditions are met.`); break;
  }
  if (args.tradeLimit.restrictedSymbols.length)  parts.push(`Symbols paused: ${args.tradeLimit.restrictedSymbols.join(", ")}.`);
  if (args.tradeLimit.restrictedSessions.length) parts.push(`Sessions paused: ${args.tradeLimit.restrictedSessions.join(", ")}.`);
  parts.push("Observation, not judgment — recovery requirements are in the prescription.");
  return parts.join(" ");
}
function clamp01(x: number): number { return Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0; }
