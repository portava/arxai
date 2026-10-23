import {
  type DecisionRecord, type ExpectancyMetrics, clamp01,
} from "./decisionIntelligence.types";

// ═══════════════════════════════════════════════════════════════════════════
// Expectancy — long-horizon process metrics over RESOLVED trades only.
// Computes:
//
//   • winRate
//   • avgWinR / avgLossR
//   • expectancyR = winRate · avgWin + (1-winRate) · avgLoss
//   • expectancyQuality01 — ratio metric tanh-squashed into [0,1]
//   • survivalQuality01 — penalises asymmetric blow-ups (large worst loss
//     relative to avg win)
//   • optimalRiskFraction01 — half-Kelly clamped to [0, 0.25]
//
// Pure. Empty / underspecified input returns zeroed metrics with a reason.
// ═══════════════════════════════════════════════════════════════════════════

export interface ExpectancyInput {
  records: ReadonlyArray<DecisionRecord>;
  // Only resolved trade-class decisions are used; NO_TRADE/BLOCKED/PENDING
  // are filtered out. Caller may pre-filter by strategyId etc.
}

export function computeExpectancy(input: ExpectancyInput): ExpectancyMetrics {
  const reasons: string[] = [];
  const resolved = input.records.filter((r) =>
    (r.kind === "ENTRY" || r.kind === "SCALE_IN" || r.kind === "SCALE_OUT" || r.kind === "EXIT")
    && typeof r.realizedR === "number"
    && r.outcome !== "PENDING");

  if (resolved.length === 0) {
    reasons.push(`no resolved trades — returning zero metrics`);
    return zero(reasons);
  }

  const wins   = resolved.filter((r) => (r.realizedR ?? 0) > 0);
  const losses = resolved.filter((r) => (r.realizedR ?? 0) <= 0);
  const winRate01 = clamp01(wins.length / resolved.length);
  const avgWinR  = wins.length   ? mean(wins.map((r) => r.realizedR ?? 0))   : 0;
  const avgLossR = losses.length ? mean(losses.map((r) => r.realizedR ?? 0)) : 0;
  const expectancyR = winRate01 * avgWinR + (1 - winRate01) * avgLossR;
  reasons.push(`n=${resolved.length} · winRate ${winRate01.toFixed(3)} · avgWin ${avgWinR.toFixed(3)} · avgLoss ${avgLossR.toFixed(3)} · E[R] ${expectancyR.toFixed(3)}`);

  // expectancyQuality01: 0.5 = E[R]=0; tanh squashes ±2R window to [0,1].
  const expectancyQuality01 = clamp01((Math.tanh(expectancyR / 2) + 1) / 2);

  // survivalQuality01 — penalises tail blow-ups. Worst loss relative to
  // mean win. quality = 1 / (1 + ratio) where ratio = |worstLoss|/max(avgWin, ε).
  const worstLoss = losses.length ? Math.min(...losses.map((r) => r.realizedR ?? 0)) : 0;
  const eps = 1e-6;
  const ratio = avgWinR > eps ? Math.abs(worstLoss) / avgWinR : Math.abs(worstLoss);
  const survivalQuality01 = clamp01(1 / (1 + ratio));
  reasons.push(`worstLoss ${worstLoss.toFixed(3)} · survivalQuality ${survivalQuality01.toFixed(3)}`);

  // Half-Kelly: f = (b·p - q) / b where b = avgWin/|avgLoss|, p = winRate.
  let optimalRiskFraction01 = 0;
  const absAvgLoss = Math.abs(avgLossR);
  if (absAvgLoss > eps && expectancyR > 0) {
    const b = avgWinR / absAvgLoss;
    if (b > eps) {
      const fullKelly = (b * winRate01 - (1 - winRate01)) / b;
      // Half-Kelly, clamped to a sane portfolio-friendly cap.
      optimalRiskFraction01 = clamp01(Math.min(0.25, Math.max(0, fullKelly / 2)));
      reasons.push(`half-Kelly ${optimalRiskFraction01.toFixed(3)} (b=${b.toFixed(2)}, p=${winRate01.toFixed(2)})`);
    }
  } else {
    reasons.push(`negative or zero E[R] / no losses — optimalRiskFraction = 0`);
  }

  return {
    sampleSize: resolved.length,
    winRate01, avgWinR, avgLossR,
    expectancyR, expectancyQuality01, survivalQuality01,
    optimalRiskFraction01, reasons,
  };
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function zero(reasons: string[]): ExpectancyMetrics {
  return {
    sampleSize: 0, winRate01: 0, avgWinR: 0, avgLossR: 0,
    expectancyR: 0, expectancyQuality01: 0.5, survivalQuality01: 0.5,
    optimalRiskFraction01: 0, reasons,
  };
}
