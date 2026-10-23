// ═══════════════════════════════════════════════════════════════════════════
// Behavioral Drift (long-horizon composer)
//
// Combines discipline + aggression + override trends into a single drift
// classification: IMPROVING / STABLE / DEGRADING. Surfaces dominant
// driver(s) and a [0..1] driftRiskScore.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import { analyzeDisciplineTrend, type DailyDisciplinePoint, DisciplineTrendReportSchema } from "./disciplineTrend.engine";
import { analyzeAggressionTrend, type DailyAggressionPoint, AggressionTrendReportSchema } from "./aggressionTrend.engine";
import { analyzeOverrideTrend,    type DailyOverridePoint,    OverrideTrendReportSchema   } from "./overrideTrend.engine";

export const BehavioralDriftReportSchema = z.object({
  sampleDays: z.number().int().nonnegative(),
  driftClassification: z.enum(["IMPROVING", "STABLE", "DEGRADING", "INSUFFICIENT"]),
  driftRiskScore01: z.number().min(0).max(1),
  dominantDriver: z.string(),
  components: z.object({
    discipline: DisciplineTrendReportSchema,
    aggression: AggressionTrendReportSchema,
    override:   OverrideTrendReportSchema,
  }),
  neutralLanguage: z.string(),
});
export type BehavioralDriftReport = z.infer<typeof BehavioralDriftReportSchema>;

export function detectBehavioralDrift(input: {
  disciplinePoints: DailyDisciplinePoint[];
  aggressionPoints: DailyAggressionPoint[];
  overridePoints:   DailyOverridePoint[];
}): BehavioralDriftReport {
  const d = analyzeDisciplineTrend(input.disciplinePoints);
  const a = analyzeAggressionTrend(input.aggressionPoints);
  const o = analyzeOverrideTrend(input.overridePoints);
  const sampleDays = Math.max(input.disciplinePoints.length, input.aggressionPoints.length, input.overridePoints.length);

  // Classification — require ≥2 mature trends before labeling DEGRADING/
  // IMPROVING so partial history cannot drive vaulted drift events.
  const dirs = [d.direction, a.direction, o.direction];
  const degrading = dirs.filter(x => x === "DEGRADING").length;
  const improving = dirs.filter(x => x === "IMPROVING").length;
  const insufficient = dirs.filter(x => x === "INSUFFICIENT").length;
  const mature = 3 - insufficient;
  let drift: BehavioralDriftReport["driftClassification"];
  if (mature < 2)               drift = "INSUFFICIENT";
  else if (degrading >= 2)      drift = "DEGRADING";
  else if (improving >= 2)      drift = "IMPROVING";
  else if (degrading === 1 && improving === 0 && mature === 3) drift = "DEGRADING";
  else                          drift = "STABLE";

  // Risk score: normalized magnitude of degrading slopes
  const dDeg = d.direction === "DEGRADING" ? Math.min(1, Math.abs(d.slopePerDay) * 10) : 0;
  const aDeg = a.direction === "DEGRADING" ? Math.min(1, Math.max(Math.abs(a.sizeSlopePerDay) * 5, Math.abs(a.freqSlopePerDay) * 0.05)) : 0;
  const oDeg = o.direction === "DEGRADING" ? Math.min(1, Math.max(Math.abs(o.overrideSlopePerDay) * 0.20, Math.abs(o.violationSlopePerDay) * 0.20)) : 0;
  const driftRisk = clamp01((dDeg * 0.4 + aDeg * 0.3 + oDeg * 0.3) * (drift === "DEGRADING" ? 1 : drift === "STABLE" ? 0.5 : 0));

  // Dominant driver
  const drivers: { name: string; w: number }[] = [
    { name: "DISCIPLINE", w: dDeg }, { name: "AGGRESSION", w: aDeg }, { name: "OVERRIDES", w: oDeg },
  ];
  const dominant = drivers.reduce((x, y) => x.w >= y.w ? x : y).name;

  return {
    sampleDays,
    driftClassification: drift,
    driftRiskScore01: round2(driftRisk),
    dominantDriver: dominant,
    components: { discipline: d, aggression: a, override: o },
    neutralLanguage: `Drift ${drift.toLowerCase()} over ${sampleDays} days; dominant driver ${dominant}; risk ${driftRisk.toFixed(2)}.`,
  };
}
function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }
function round2(n: number) { return Math.round(n * 100) / 100; }
