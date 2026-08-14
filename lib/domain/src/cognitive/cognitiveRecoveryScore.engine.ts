// ═══════════════════════════════════════════════════════════════════════════
// Cognitive Recovery Score
//
// Tracks whether the trader's cognitive + behavioral state is *improving*
// after a cooldown / recovery event. When recovery is sufficient, the
// Control Tower may restore permissions.
//
// Inputs are observable trends, not self-reports:
//   • cognitiveRisk samples chronologically (latest last) — must be falling
//   • ruleAdherenceLast24h ∈ [0..1]              — higher = better
//   • baselineDeviation01 ∈ [0..1]               — lower  = better
//   • minutesSinceLastCooldown                   — rises with time
//
// recoveryScore01 in [0..1]; canRestorePermissions=true once score ≥ 0.70
// AND there is a downward trend in cognitive risk.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";

export const CognitiveRecoveryScoreSchema = z.object({
  recoveryScore01: z.number().min(0).max(1),
  canRestorePermissions: z.boolean(),
  trend: z.enum(["IMPROVING", "STABLE", "DEGRADING"]),
  components: z.object({
    trendComponent01: z.number().min(0).max(1),
    adherenceComponent01: z.number().min(0).max(1),
    deviationComponent01: z.number().min(0).max(1),
    timeComponent01: z.number().min(0).max(1),
  }),
  reasons: z.array(z.string()),
});
export type CognitiveRecoveryScore = z.infer<typeof CognitiveRecoveryScoreSchema>;

export interface RecoveryInput {
  cognitiveRiskSeries: number[];      // chronological, oldest first; latest last
  ruleAdherenceLast24h: number;
  baselineDeviation01: number;
  minutesSinceLastCooldown: number;
  // Optional: caller can require a higher bar before restoring
  restoreThreshold01?: number;        // default 0.70
}

export function computeCognitiveRecoveryScore(input: RecoveryInput): CognitiveRecoveryScore {
  const reasons: string[] = [];
  const series = input.cognitiveRiskSeries.filter(n => Number.isFinite(n));
  const threshold = input.restoreThreshold01 ?? 0.70;

  // Trend: linear regression slope over last up-to-10 samples (negative = improving)
  const last = series.slice(-10);
  let slope = 0;
  if (last.length >= 2) {
    const n = last.length;
    const xs = last.map((_, i) => i);
    const xMean = (n - 1) / 2;
    const yMean = last.reduce((s, y) => s + y, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - xMean) * (last[i] - yMean); den += (xs[i] - xMean) ** 2; }
    slope = den > 0 ? num / den : 0;
  }
  const trend: "IMPROVING"|"STABLE"|"DEGRADING" =
    slope < -0.005 ? "IMPROVING" : slope > 0.005 ? "DEGRADING" : "STABLE";
  // Trend component: 1 when steeply improving, 0 when degrading.
  const trendComponent01 = clamp01(0.5 - slope * 5);

  const adherenceComponent01 = clamp01(input.ruleAdherenceLast24h);
  const deviationComponent01 = clamp01(1 - input.baselineDeviation01);
  // Time: fully credited at 60 minutes since last cooldown
  const timeComponent01 = clamp01(input.minutesSinceLastCooldown / 60);

  const recoveryScore01 = clamp01(
    0.40 * trendComponent01
    + 0.25 * adherenceComponent01
    + 0.20 * deviationComponent01
    + 0.15 * timeComponent01,
  );

  const canRestorePermissions = recoveryScore01 >= threshold && trend !== "DEGRADING";

  reasons.push(`trend ${trend} (slope ${slope.toFixed(3)}) → trendComp ${trendComponent01.toFixed(2)}`);
  reasons.push(`adherence ${adherenceComponent01.toFixed(2)} · deviation ${deviationComponent01.toFixed(2)} · time ${timeComponent01.toFixed(2)}`);
  reasons.push(`recovery ${recoveryScore01.toFixed(2)} ${canRestorePermissions ? "≥" : "<"} threshold ${threshold} → restore=${canRestorePermissions}`);

  return {
    recoveryScore01,
    canRestorePermissions,
    trend,
    components: { trendComponent01, adherenceComponent01, deviationComponent01, timeComponent01 },
    reasons,
  };
}

function clamp01(x: number): number { return Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0; }
