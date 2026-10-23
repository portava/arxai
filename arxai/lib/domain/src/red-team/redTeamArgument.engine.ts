import {
  type RedArgument, type RedTeamArgumentSet, type RedTeamContext,
  RED_TEAM_THRESHOLDS,
} from "./redTeam.types";

// buildRedTeamArguments — pure construction of the anti-trade case.
// Same trust-weighted, mean-not-sum aggregation pattern as Blue Team.
export function buildRedTeamArguments(ctx: RedTeamContext): RedTeamArgumentSet {
  const T = RED_TEAM_THRESHOLDS;
  const reasons: string[] = [];
  const args: RedArgument[] = [];

  if (ctx.regimeFitScore01 < 0.4) {
    args.push({ kind: "REGIME_HOSTILE", strength01: 1 - ctx.regimeFitScore01,
      citation: `regime fit only ${(ctx.regimeFitScore01 * 100).toFixed(0)}%` });
  }

  if (ctx.riskRewardRatio <= T.poorRRMaxRatio) {
    const strength = Math.min(1, (T.poorRRMaxRatio - ctx.riskRewardRatio) / T.poorRRMaxRatio + 0.4);
    args.push({ kind: "POOR_RISK_REWARD", strength01: strength,
      citation: `R:R ${ctx.riskRewardRatio.toFixed(2)} ≤ ${T.poorRRMaxRatio}` });
  }

  if (ctx.similarPastSampleCount >= T.similarMinSamples && ctx.similarPastWinRate01 <= T.similarLossWinRateMax) {
    const trust = Math.min(1, Math.sqrt(ctx.similarPastSampleCount / 50));
    const strength = Math.min(1, (T.similarLossWinRateMax - ctx.similarPastWinRate01 + 0.05) * 2 * trust + 0.3);
    args.push({ kind: "SIMILAR_PAST_LOSSES", strength01: strength,
      citation: `similar setups: ${(ctx.similarPastWinRate01 * 100).toFixed(0)}% win rate / ${ctx.similarPastSampleCount} samples` });
  }

  if (ctx.isInNewsBlackout) {
    args.push({ kind: "ADVERSE_NEWS_WINDOW", strength01: 0.9, citation: "in scheduled news blackout window" });
  }

  if (ctx.overlappingPositionCount >= T.overlappingExposureCount) {
    args.push({ kind: "OVERLAPPING_EXPOSURE", strength01: Math.min(1, ctx.overlappingPositionCount / 5),
      citation: `${ctx.overlappingPositionCount} overlapping correlated positions open` });
  }

  if (ctx.currentDrawdownPct >= T.drawdownPressurePct) {
    args.push({ kind: "DRAWDOWN_PRESSURE", strength01: Math.min(1, ctx.currentDrawdownPct / 15),
      citation: `currently in ${ctx.currentDrawdownPct.toFixed(1)}% drawdown` });
  }

  if (ctx.spreadPips >= T.wideSpreadPips) {
    args.push({ kind: "WIDE_SPREAD", strength01: Math.min(1, ctx.spreadPips / 10),
      citation: `spread ${ctx.spreadPips.toFixed(1)}p ≥ ${T.wideSpreadPips}p` });
  }

  if (ctx.volumeRatio < T.thinVolumeRatio) {
    args.push({ kind: "LIQUIDITY_THIN", strength01: Math.min(1, (T.thinVolumeRatio - ctx.volumeRatio) * 2),
      citation: `volume ratio ${ctx.volumeRatio.toFixed(2)} < ${T.thinVolumeRatio}` });
  }

  if (!ctx.alignsWithHigherTimeframe) {
    args.push({ kind: "AGAINST_HIGHER_TIMEFRAME", strength01: 0.7,
      citation: "setup contradicts higher-timeframe direction" });
  }

  if (ctx.edgeRecentSampleCount >= T.edgeDecayMinSamples && ctx.edgeRecentVsHistoricalDelta <= T.edgeDecayDeltaR) {
    args.push({ kind: "EDGE_DECAY_DETECTED",
      strength01: Math.min(1, Math.abs(ctx.edgeRecentVsHistoricalDelta) / 0.3),
      citation: `recent edge ${ctx.edgeRecentVsHistoricalDelta.toFixed(2)}R vs historical (${ctx.edgeRecentSampleCount} samples)` });
  }

  const caseStrength01 = args.length === 0 ? 0 : args.reduce((s, a) => s + a.strength01, 0) / args.length;
  reasons.push(`${args.length} argument(s) constructed; mean strength ${caseStrength01.toFixed(2)}`);
  return { setupId: ctx.setupId, arguments: args, caseStrength01, reasons };
}
