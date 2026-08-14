// ═══════════════════════════════════════════════════════════════════════════
// Permission Sensitivity
//
// Tunes how strict the permission throttle should be. When the trader's
// recent restoration history shows ineffective recoveries, we tighten;
// when they consistently respond well to lighter touches, we relax.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";

export const PermissionSensitivitySchema = z.object({
  sensitivity: z.enum(["RELAXED", "STANDARD", "STRICT", "MAXIMUM"]),
  thresholdMultiplier: z.number().positive(),
  reasons: z.array(z.string()),
});
export type PermissionSensitivity = z.infer<typeof PermissionSensitivitySchema>;

export function recommendPermissionSensitivity(input: {
  averageRecoveryEffectiveness01: number;   // 0..1, measured
  recentRuleViolations24h: number;
  cognitiveRisk01: number;
}): PermissionSensitivity {
  const reasons: string[] = [];
  let sensitivity: PermissionSensitivity["sensitivity"] = "STANDARD";
  let thresholdMultiplier = 1.0;

  if (input.cognitiveRisk01 >= 0.85 || input.recentRuleViolations24h >= 3) {
    sensitivity = "MAXIMUM"; thresholdMultiplier = 0.7;
    reasons.push("high cognitive risk or repeated violations → maximum sensitivity");
  } else if (input.cognitiveRisk01 >= 0.65) {
    sensitivity = "STRICT"; thresholdMultiplier = 0.85;
    reasons.push("elevated cognitive risk → strict thresholds");
  } else if (input.averageRecoveryEffectiveness01 < 0.45) {
    sensitivity = "STRICT"; thresholdMultiplier = 0.85;
    reasons.push("recent recoveries ineffective → strict thresholds");
  } else if (input.cognitiveRisk01 < 0.35 &&
             input.averageRecoveryEffectiveness01 > 0.70 &&
             input.recentRuleViolations24h === 0) {
    sensitivity = "RELAXED"; thresholdMultiplier = 1.15;
    reasons.push("low risk + effective recoveries + no violations → relaxed thresholds");
  } else {
    reasons.push("standard sensitivity");
  }
  return { sensitivity, thresholdMultiplier, reasons };
}
