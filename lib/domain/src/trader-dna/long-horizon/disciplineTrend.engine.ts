// ═══════════════════════════════════════════════════════════════════════════
// Discipline Trend (long-horizon)
//
// Linear regression of daily discipline scores. Direction = IMPROVING /
// FLAT / DEGRADING. Used by drift detector and Control Tower.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import { linearTrend } from "./_trend";

export const DailyDisciplinePointSchema = z.object({
  date: z.string(),
  disciplineScore01: z.number().min(0).max(1),
}).strict();
export type DailyDisciplinePoint = z.infer<typeof DailyDisciplinePointSchema>;

export const DisciplineTrendReportSchema = z.object({
  sampleDays: z.number().int().nonnegative(),
  slopePerDay: z.number(),
  rSquared: z.number().min(0).max(1),
  direction: z.enum(["IMPROVING", "FLAT", "DEGRADING", "INSUFFICIENT"]),
  neutralLanguage: z.string(),
});
export type DisciplineTrendReport = z.infer<typeof DisciplineTrendReportSchema>;

export function analyzeDisciplineTrend(points: DailyDisciplinePoint[]): DisciplineTrendReport {
  const indexed = points
    .slice().sort((a, b) => a.date.localeCompare(b.date))
    .map((p, i) => ({ dayIndex: i, value: p.disciplineScore01 }));
  const t = linearTrend(indexed, /* improvingIsHigher */ true);
  return {
    sampleDays: points.length,
    slopePerDay: t.slopePerDay, rSquared: t.rSquared, direction: t.direction,
    neutralLanguage: `Discipline trend ${t.direction.toLowerCase()} (slope ${t.slopePerDay}/day, R²=${t.rSquared}).`,
  };
}
