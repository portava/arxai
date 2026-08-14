// ═══════════════════════════════════════════════════════════════════════════
// Override Trend (long-horizon)
//
// Tracks override frequency and rule-violation rate over time.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import { linearTrend } from "./_trend";

export const DailyOverridePointSchema = z.object({
  date: z.string(),
  overridesCount: z.number().int().nonnegative(),
  ruleViolationsCount: z.number().int().nonnegative(),
}).strict();
export type DailyOverridePoint = z.infer<typeof DailyOverridePointSchema>;

export const OverrideTrendReportSchema = z.object({
  sampleDays: z.number().int().nonnegative(),
  overrideSlopePerDay: z.number(),
  violationSlopePerDay: z.number(),
  rSquaredOverride: z.number().min(0).max(1),
  rSquaredViolation: z.number().min(0).max(1),
  direction: z.enum(["IMPROVING", "FLAT", "DEGRADING", "INSUFFICIENT"]),
  neutralLanguage: z.string(),
});
export type OverrideTrendReport = z.infer<typeof OverrideTrendReportSchema>;

export function analyzeOverrideTrend(points: DailyOverridePoint[]): OverrideTrendReport {
  const sorted = points.slice().sort((a, b) => a.date.localeCompare(b.date));
  const oPts = sorted.map((p, i) => ({ dayIndex: i, value: p.overridesCount }));
  const vPts = sorted.map((p, i) => ({ dayIndex: i, value: p.ruleViolationsCount }));
  // More overrides/violations = degrading
  const oT = linearTrend(oPts, /* improvingIsHigher */ false);
  const vT = linearTrend(vPts, /* improvingIsHigher */ false);
  let direction: OverrideTrendReport["direction"];
  if (oT.direction === "INSUFFICIENT" && vT.direction === "INSUFFICIENT") direction = "INSUFFICIENT";
  else if (vT.direction === "DEGRADING" || oT.direction === "DEGRADING") direction = "DEGRADING";
  else if (vT.direction === "IMPROVING") direction = "IMPROVING";
  else direction = "FLAT";
  return {
    sampleDays: points.length,
    overrideSlopePerDay: oT.slopePerDay, violationSlopePerDay: vT.slopePerDay,
    rSquaredOverride: oT.rSquared, rSquaredViolation: vT.rSquared,
    direction,
    neutralLanguage: `Override trend ${direction.toLowerCase()} (overrides slope ${oT.slopePerDay}/day, violations slope ${vT.slopePerDay}/day).`,
  };
}
