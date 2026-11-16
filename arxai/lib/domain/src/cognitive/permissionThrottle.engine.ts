// ═══════════════════════════════════════════════════════════════════════════
// Permission Throttle
//
// Composes traderRiskScore + behaviorEvidenceScore + disciplineScore into
// a permission throttle level that the Control Tower consumes:
//
//   FULL              — no throttle
//   REDUCED           — size × 0.66, no confirmation needed
//   MICRO             — size × 0.33, confirmation required
//   CONFIRM_REQUIRED  — full size, but each trade needs explicit confirm
//   PAPER_ONLY        — paper trading mode only
//   COOLDOWN          — block new entries entirely
//
// Output never increases permissions beyond FULL. Multi-axis severity:
// the worst single axis wins.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";

export const PermissionThrottleLevelSchema = z.enum([
  "FULL", "REDUCED", "MICRO", "CONFIRM_REQUIRED", "PAPER_ONLY", "COOLDOWN",
]);
export type PermissionThrottleLevel = z.infer<typeof PermissionThrottleLevelSchema>;

export const PermissionThrottleSchema = z.object({
  level: PermissionThrottleLevelSchema,
  sizeMultiplier: z.number().min(0).max(1),
  requireConfirmation: z.boolean(),
  paperOnly: z.boolean(),
  blockNewEntries: z.boolean(),
  maxTradesPerSession: z.number().int().min(0),
  reasons: z.array(z.string()),
});
export type PermissionThrottle = z.infer<typeof PermissionThrottleSchema>;

export interface PermissionThrottleInput {
  traderRiskScore01:        number;     // 0..1
  behaviorEvidenceScore01:  number;     // 0..1
  disciplineScore01:        number;     // 0..1, higher better
  cognitiveRiskScore01:     number;     // 0..1
  baselineMature:           boolean;
  // Override switch (e.g., user explicitly turned on PAPER_ONLY for the day)
  forcePaperOnly?:          boolean;
}

export function recommendPermissionThrottle(input: PermissionThrottleInput): PermissionThrottle {
  const reasons: string[] = [];
  const worstAxis = Math.max(
    input.traderRiskScore01,
    input.behaviorEvidenceScore01,
    input.cognitiveRiskScore01,
    1 - input.disciplineScore01,           // discipline-deficit
  );
  reasons.push(`worst axis ${worstAxis.toFixed(2)} (trader ${input.traderRiskScore01.toFixed(2)} · evidence ${input.behaviorEvidenceScore01.toFixed(2)} · cognitive ${input.cognitiveRiskScore01.toFixed(2)} · disc-deficit ${(1-input.disciplineScore01).toFixed(2)})`);

  let level: PermissionThrottleLevel;
  if (input.forcePaperOnly) {
    level = "PAPER_ONLY";
    reasons.push("forcePaperOnly switch active");
  } else if (worstAxis >= 0.85) {
    level = "COOLDOWN";
  } else if (worstAxis >= 0.65) {
    level = "PAPER_ONLY";
  } else if (worstAxis >= 0.50) {
    level = "MICRO";
  } else if (worstAxis >= 0.35) {
    level = "REDUCED";
  } else if (worstAxis >= 0.25 || !input.baselineMature) {
    // Immature baseline always nudges to CONFIRM_REQUIRED to keep humans-in-loop early
    level = "CONFIRM_REQUIRED";
    if (!input.baselineMature) reasons.push("baseline immature — defaulting to CONFIRM_REQUIRED");
  } else {
    level = "FULL";
  }

  const cfg = configFor(level);
  reasons.push(`throttle ${level}: size ×${cfg.sizeMultiplier} · confirm=${cfg.requireConfirmation} · paper=${cfg.paperOnly} · block=${cfg.blockNewEntries}`);

  return {
    level,
    sizeMultiplier: cfg.sizeMultiplier,
    requireConfirmation: cfg.requireConfirmation,
    paperOnly: cfg.paperOnly,
    blockNewEntries: cfg.blockNewEntries,
    maxTradesPerSession: cfg.maxTradesPerSession,
    reasons,
  };
}

function configFor(level: PermissionThrottleLevel): {
  sizeMultiplier: number; requireConfirmation: boolean; paperOnly: boolean;
  blockNewEntries: boolean; maxTradesPerSession: number;
} {
  switch (level) {
    case "FULL":             return { sizeMultiplier: 1.00, requireConfirmation: false, paperOnly: false, blockNewEntries: false, maxTradesPerSession: 100 };
    case "REDUCED":          return { sizeMultiplier: 0.66, requireConfirmation: false, paperOnly: false, blockNewEntries: false, maxTradesPerSession: 20 };
    case "CONFIRM_REQUIRED": return { sizeMultiplier: 1.00, requireConfirmation: true,  paperOnly: false, blockNewEntries: false, maxTradesPerSession: 15 };
    case "MICRO":            return { sizeMultiplier: 0.33, requireConfirmation: true,  paperOnly: false, blockNewEntries: false, maxTradesPerSession: 8 };
    case "PAPER_ONLY":       return { sizeMultiplier: 1.00, requireConfirmation: true,  paperOnly: true,  blockNewEntries: false, maxTradesPerSession: 100 };
    case "COOLDOWN":         return { sizeMultiplier: 0.00, requireConfirmation: true,  paperOnly: false, blockNewEntries: true,  maxTradesPerSession: 0 };
  }
}
