// ═══════════════════════════════════════════════════════════════════════════
// Aggression Trend (long-horizon)
//
// Tracks how aggressive the trader is becoming over time, measured by
// daily average lot size relative to baseline + daily trade count.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import { linearTrend } from "./_trend";

export const DailyAggressionPointSchema = z.object({
  date: z.string(),
  avgLotRatio: z.number().nonnegative(),  // lot / baseline lot
  tradesCount: z.number().int().nonnegative(),
}).strict();
export type DailyAggressionPoint = z.infer<typeof DailyAggressionPointSchema>;

export const AggressionTrendReportSchema = z.object({
  sampleDays: z.number().int().nonnegative(),
  sizeSlopePerDay: z.number(),
  freqSlopePerDay: z.number(),
  rSquaredSize: z.number().min(0).max(1),
  rSquaredFreq: z.number().min(0).max(1),
  direction: z.enum(["IMPROVING", "FLAT", "DEGRADING", "INSUFFICIENT"]),
  neutralLanguage: z.string(),
});
export type AggressionTrendReport = z.infer<typeof AggressionTrendReportSchema>;

export function analyzeAggressionTrend(points: DailyAggressionPoint[]): AggressionTrendReport {
  const sorted = points.slice().sort((a, b) => a.date.localeCompare(b.date));
  const sizePts = sorted.map((p, i) => ({ dayIndex: i, value: p.avgLotRatio }));
  const freqPts = sorted.map((p, i) => ({ dayIndex: i, value: p.tradesCount }));
  // Increasing aggression is degrading
  const sizeT = linearTrend(sizePts, /* improvingIsHigher */ false);
  const freqT = linearTrend(freqPts, /* improvingIsHigher */ false);
  let direction: AggressionTrendReport["direction"];
  if (sizeT.direction === "INSUFFICIENT" && freqT.direction === "INSUFFICIENT") direction = "INSUFFICIENT";
  else if (sizeT.direction === "DEGRADING" || freqT.direction === "DEGRADING") direction = "DEGRADING";
  else if (sizeT.direction === "IMPROVING") direction = "IMPROVING";
  else direction = "FLAT";
  return {
    sampleDays: points.length,
    sizeSlopePerDay: sizeT.slopePerDay, freqSlopePerDay: freqT.slopePerDay,
    rSquaredSize: sizeT.rSquared, rSquaredFreq: freqT.rSquared,
    direction,
    neutralLanguage: `Aggression trend ${direction.toLowerCase()} (size slope ${sizeT.slopePerDay}/day, freq slope ${freqT.slopePerDay}/day).`,
  };
}
