import {
  type BlueArgument, type BlueTeamArgumentSet, type BlueTeamContext,
  BLUE_TEAM_THRESHOLDS,
} from "./blueTeam.types";

// buildBlueTeamArguments — pure construction of the pro-trade case from
// observable context. Each argument's strength caps at 1.0; case strength
// is the trust-weighted mean of present arguments, NOT the sum, so adding
// many weak arguments cannot inflate the case.
//
// Trust weighting matches the project pattern: sqrt(samples/threshold).
export function buildBlueTeamArguments(ctx: BlueTeamContext): BlueTeamArgumentSet {
  const T = BLUE_TEAM_THRESHOLDS;
  const reasons: string[] = [];
  const args: BlueArgument[] = [];

  if (ctx.hasHistoricalEdge && ctx.edgeValueR > 0) {
    const trust = Math.min(1, Math.sqrt(ctx.edgeSampleCount / T.edgeMinSamplesForFullCredit));
    const strength = Math.min(1, ctx.edgeValueR * trust);
    args.push({ kind: "EDGE_PRESENT", strength01: strength,
      citation: `historical edge ${ctx.edgeValueR.toFixed(2)}R over ${ctx.edgeSampleCount} samples (trust ${trust.toFixed(2)})` });
  }

  if (ctx.regimeFitScore01 >= 0.6) {
    args.push({ kind: "REGIME_FAVORABLE", strength01: ctx.regimeFitScore01,
      citation: `regime fit ${(ctx.regimeFitScore01 * 100).toFixed(0)}%` });
  }

  if (ctx.riskRewardRatio >= T.rrFavorableMinRatio) {
    const strength = Math.min(1, (ctx.riskRewardRatio - T.rrFavorableMinRatio) / 2 + 0.5);
    args.push({ kind: "RISK_REWARD_FAVORABLE", strength01: strength,
      citation: `R:R ${ctx.riskRewardRatio.toFixed(2)} ≥ ${T.rrFavorableMinRatio}` });
  }

  if (ctx.similarPastSampleCount >= T.similarMinSamples && ctx.similarPastWinRate01 >= 0.55) {
    const trust = Math.min(1, Math.sqrt(ctx.similarPastSampleCount / 50));
    const strength = Math.min(1, (ctx.similarPastWinRate01 - 0.5) * 2 * trust);
    args.push({ kind: "SIMILAR_PAST_WINS", strength01: strength,
      citation: `similar setups: ${(ctx.similarPastWinRate01 * 100).toFixed(0)}% wins / ${ctx.similarPastSampleCount} samples` });
  }

  if (ctx.momentumAlignmentScore01 >= T.momentumStrong01) {
    args.push({ kind: "MOMENTUM_CONFIRMS", strength01: ctx.momentumAlignmentScore01,
      citation: `momentum alignment ${(ctx.momentumAlignmentScore01 * 100).toFixed(0)}%` });
  }

  if (ctx.confluenceCount >= T.confluenceStrongCount) {
    const strength = Math.min(1, ctx.confluenceCount / (T.confluenceStrongCount * 2));
    args.push({ kind: "CONFLUENCE", strength01: strength,
      citation: `${ctx.confluenceCount} independent confirming signals` });
  }

  const caseStrength01 = args.length === 0 ? 0 : args.reduce((s, a) => s + a.strength01, 0) / args.length;
  reasons.push(`${args.length} argument(s) constructed; mean strength ${caseStrength01.toFixed(2)}`);
  return { setupId: ctx.setupId, arguments: args, caseStrength01, reasons };
}
