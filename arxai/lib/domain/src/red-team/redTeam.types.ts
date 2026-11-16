import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Red Team — anti-trade arguers. Steel-mans the case AGAINST the proposed
// setup. Together with Blue Team they give the Judge both sides. Red Team
// is intentionally biased toward caution — its job is to find every
// reason NOT to take, even when most reasons are weak.
// ═══════════════════════════════════════════════════════════════════════════

export const RedArgumentKindSchema = z.enum([
  "REGIME_HOSTILE",
  "POOR_RISK_REWARD",
  "SIMILAR_PAST_LOSSES",
  "ADVERSE_NEWS_WINDOW",
  "OVERLAPPING_EXPOSURE",
  "DRAWDOWN_PRESSURE",
  "WIDE_SPREAD",
  "LIQUIDITY_THIN",
  "AGAINST_HIGHER_TIMEFRAME",
  "EDGE_DECAY_DETECTED",
]);
export type RedArgumentKind = z.infer<typeof RedArgumentKindSchema>;

export interface RedArgument {
  kind: RedArgumentKind;
  strength01: number;
  citation: string;
}

export interface RedTeamContext {
  setupId: string;
  regimeFitScore01: number;             // low = bad
  riskRewardRatio: number;              // low = bad
  similarPastWinRate01: number;
  similarPastSampleCount: number;
  isInNewsBlackout: boolean;
  overlappingPositionCount: number;
  currentDrawdownPct: number;
  spreadPips: number;
  volumeRatio: number;
  alignsWithHigherTimeframe: boolean;
  edgeRecentVsHistoricalDelta: number;  // negative = decay
  edgeRecentSampleCount: number;
}

export interface RedTeamArgumentSet {
  setupId: string;
  arguments: RedArgument[];
  caseStrength01: number;
  reasons: string[];
}

export const RED_TEAM_THRESHOLDS = {
  poorRRMaxRatio: 1.2,
  similarLossWinRateMax: 0.45,
  similarMinSamples: 20,
  overlappingExposureCount: 2,
  drawdownPressurePct: 5,
  wideSpreadPips: 4,
  thinVolumeRatio: 0.5,
  edgeDecayDeltaR: -0.10,
  edgeDecayMinSamples: 20,
} as const;
