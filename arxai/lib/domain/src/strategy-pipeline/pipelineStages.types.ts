import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Strategy Pipeline — the 7-stage promotion gauntlet every strategy must
// pass before reaching FULL_APPROVAL. Distinct from trust-ladder (which
// governs the AI's authority) — this governs each STRATEGY's authority.
// Both must align: a strategy at FULL_APPROVAL still cannot run beyond
// what the AI's trust rung allows.
// ═══════════════════════════════════════════════════════════════════════════

export const PipelineStageSchema = z.enum([
  "HYPOTHESIS",
  "BACKTEST",
  "WALK_FORWARD",
  "PAPER_TEST",
  "MICRO_LOT_TEST",
  "LIMITED_LIVE",
  "FULL_APPROVAL",
]);
export type PipelineStage = z.infer<typeof PipelineStageSchema>;

export const PIPELINE_STAGE_ORDER: PipelineStage[] = [
  "HYPOTHESIS", "BACKTEST", "WALK_FORWARD", "PAPER_TEST",
  "MICRO_LOT_TEST", "LIMITED_LIVE", "FULL_APPROVAL",
];

export function pipelineStageIndex(s: PipelineStage): number { return PIPELINE_STAGE_ORDER.indexOf(s); }

export interface StagePromotionCriteria {
  minSampleCount: number;
  minExpectancyR: number;
  maxDrawdownPct: number;
  minWinRate01: number;
  minSharpeRatio: number;
}

export interface StagePerformance {
  sampleCount: number;
  expectancyR: number;
  maxDrawdownPct: number;
  winRate01: number;
  sharpeRatio: number;
}

export const PipelineDecisionKindSchema = z.enum(["PROMOTE", "HOLD", "DEMOTE", "RETIRE"]);
export type PipelineDecisionKind = z.infer<typeof PipelineDecisionKindSchema>;

export interface PipelineDecision {
  kind: PipelineDecisionKind;
  strategyId: string;
  fromStage: PipelineStage;
  toStage: PipelineStage;
  failedGates: string[];
  reasons: string[];
}

export interface PipelineRecord {
  strategyId: string;
  currentStage: PipelineStage;
  enteredStageAt: string;
  history: { stage: PipelineStage; enteredAt: string }[];
}

export interface PipelineStorePort {
  load(strategyId: string): Promise<PipelineRecord | null>;
  save(record: PipelineRecord): Promise<void>;
  appendDecision(decision: PipelineDecision, atIso: string): Promise<void>;
  listAll(): Promise<PipelineRecord[]>;
}

// Default criteria to advance INTO each stage (gradually stricter).
export const DEFAULT_PIPELINE_CRITERIA: Record<PipelineStage, StagePromotionCriteria> = {
  HYPOTHESIS:     { minSampleCount: 0,    minExpectancyR: -Infinity, maxDrawdownPct: 100, minWinRate01: 0,    minSharpeRatio: -Infinity },
  BACKTEST:       { minSampleCount: 0,    minExpectancyR: -Infinity, maxDrawdownPct: 100, minWinRate01: 0,    minSharpeRatio: -Infinity },
  WALK_FORWARD:   { minSampleCount: 100,  minExpectancyR: 0.10,      maxDrawdownPct: 25,  minWinRate01: 0.40, minSharpeRatio: 0.5 },
  PAPER_TEST:     { minSampleCount: 200,  minExpectancyR: 0.15,      maxDrawdownPct: 20,  minWinRate01: 0.42, minSharpeRatio: 0.8 },
  MICRO_LOT_TEST: { minSampleCount: 50,   minExpectancyR: 0.15,      maxDrawdownPct: 15,  minWinRate01: 0.45, minSharpeRatio: 0.9 },
  LIMITED_LIVE:   { minSampleCount: 100,  minExpectancyR: 0.20,      maxDrawdownPct: 12,  minWinRate01: 0.48, minSharpeRatio: 1.0 },
  FULL_APPROVAL:  { minSampleCount: 200,  minExpectancyR: 0.25,      maxDrawdownPct: 10,  minWinRate01: 0.50, minSharpeRatio: 1.2 },
};

export const PIPELINE_DEMOTION = {
  drawdownSevereMultiplier: 1.5,
  expectancyFloorR: -0.10,
  minDemotionSamples: 30,
  retireExpectancyR: -0.30,             // catastrophic underperformance → RETIRE
  retireMinSamples: 100,
} as const;
