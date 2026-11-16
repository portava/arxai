import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Blue Team — pro-trade arguers. Generates arguments FOR taking the
// proposed setup. Distinct from agents (which vote APPROVE/REJECT) and
// trade-court (which adjudicates). Blue Team explicitly steel-mans the
// "take it" case so the Judge has both sides to weigh.
// ═══════════════════════════════════════════════════════════════════════════

export const BlueArgumentKindSchema = z.enum([
  "EDGE_PRESENT",
  "REGIME_FAVORABLE",
  "STRUCTURAL_SUPPORT",
  "RISK_REWARD_FAVORABLE",
  "SIMILAR_PAST_WINS",
  "MOMENTUM_CONFIRMS",
  "CONFLUENCE",
]);
export type BlueArgumentKind = z.infer<typeof BlueArgumentKindSchema>;

export interface BlueArgument {
  kind: BlueArgumentKind;
  strength01: number;                   // 0..1 — how strong is this argument
  citation: string;                     // human-readable evidence
}

export interface BlueTeamContext {
  setupId: string;
  hasHistoricalEdge: boolean;
  edgeValueR: number;                   // historical expectancy
  edgeSampleCount: number;
  regimeFitScore01: number;             // 0..1
  riskRewardRatio: number;              // tp/sl in R
  similarPastWinRate01: number;         // win rate of similar setups
  similarPastSampleCount: number;
  momentumAlignmentScore01: number;     // 0..1 — does momentum agree with direction?
  confluenceCount: number;              // count of independent confirming signals
}

export interface BlueTeamArgumentSet {
  setupId: string;
  arguments: BlueArgument[];
  caseStrength01: number;               // composite blue case strength
  reasons: string[];
}

export const BLUE_TEAM_THRESHOLDS = {
  edgeMinSamplesForFullCredit: 30,      // sqrt(samples/30) trust ramp (matches project pattern)
  rrFavorableMinRatio: 1.5,
  similarMinSamples: 20,
  momentumStrong01: 0.7,
  confluenceStrongCount: 3,
} as const;
