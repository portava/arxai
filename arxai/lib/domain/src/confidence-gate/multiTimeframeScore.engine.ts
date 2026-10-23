import type { ConfidenceGateContext, ScoreReport, Blocker } from "./confidenceGate.types";
import { SCORE_WEIGHTS } from "./confidenceGate.types";

// Higher timeframes weigh more — alignment with H4/D1 is what most matters.
const TF_WEIGHT: Record<string, number> = {
  M5: 1, M15: 2, H1: 3, H4: 4, D1: 5,
};

export function scoreMultiTimeframe(ctx: ConfidenceGateContext): ScoreReport {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const blockers: Blocker[] = [];
  const tfs = ctx.timeframes ?? [];

  if (tfs.length < 2) {
    blockers.push({ severity: "DATA", dimension: "multiTimeframe",
      message: `Need ≥2 timeframes for alignment check, got ${tfs.length}` });
  }

  const signalDir = ctx.signal.direction;     // BUY | SELL | null
  if (signalDir == null) {
    blockers.push({ severity: "AI", dimension: "multiTimeframe",
      message: "Signal has no direction" });
  }

  const expectedTrend = signalDir === "BUY" ? "UP" : signalDir === "SELL" ? "DOWN" : null;

  // Score = weighted-aligned strength as a percentage of the maximum possible.
  let maxWeighted = 0;
  let alignedWeighted = 0;
  let conflicts = 0;
  for (const tf of tfs) {
    const w = TF_WEIGHT[tf.timeframe] ?? 1;
    maxWeighted += w * 100;
    if (expectedTrend && tf.trend === expectedTrend) {
      alignedWeighted += w * tf.strength;
      reasons.push(`${tf.timeframe} ${tf.trend} (${tf.strength}) aligned ×${w}`);
    } else if (expectedTrend && tf.trend !== "SIDEWAYS" && tf.trend !== expectedTrend) {
      conflicts += w;
      reasons.push(`${tf.timeframe} ${tf.trend} (${tf.strength}) CONFLICTS ×${w}`);
    } else {
      // Sideways: half-credit at half-strength
      alignedWeighted += (w * tf.strength) / 2;
      reasons.push(`${tf.timeframe} SIDEWAYS (${tf.strength}) neutral ×${w}`);
    }
  }
  const score = maxWeighted > 0 ? Math.round((alignedWeighted / maxWeighted) * 100) : 0;

  // Hard conflict on the highest TF is a blocker — never fight the daily.
  const top = [...tfs].sort((a, b) => (TF_WEIGHT[b.timeframe] ?? 1) - (TF_WEIGHT[a.timeframe] ?? 1))[0];
  if (top && expectedTrend && top.trend !== "SIDEWAYS" && top.trend !== expectedTrend) {
    blockers.push({ severity: "AI", dimension: "multiTimeframe",
      message: `Top timeframe ${top.timeframe} trends ${top.trend} but signal is ${signalDir}` });
  }
  if (conflicts > 0) {
    warnings.push(`${conflicts} weighted-points of timeframe conflict against signal`);
  }

  return {
    dimension: "multiTimeframe",
    score, weight: SCORE_WEIGHTS.multiTimeframe,
    blockers, warnings, reasons,
    evidence: { signalDirection: signalDir, expectedTrend, timeframes: tfs, conflicts },
  };
}
