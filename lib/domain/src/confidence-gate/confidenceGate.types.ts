import { z } from "zod/v4";
import type { SignalState, AccountState, RiskState } from "../state/appState.types";
import type { RiskLimits } from "../risk/riskProfile.types";
import type { SymbolMarketSnapshot } from "../state/appState.types";
import type { BrokerConnectionState } from "../state/appState.types";
import type { TraderProfile } from "../trader-dna/traderProfile.types";
import type { BehaviorPatternReport } from "../trader-dna/behaviorPattern.engine";
import type { OvertradeReport } from "../trader-dna/overtradeGuard.engine";
import type { RevengeTradeReport } from "../trader-dna/revengeTradingDetector.engine";
import type { HorizonFrameEvidence } from "../horizons";

// ── Required score ─────────────────────────────────────────────────────────
export const REQUIRED_SCORE = 95 as const;
export type RequiredScore = typeof REQUIRED_SCORE;

// ── Score dimensions (7) ───────────────────────────────────────────────────
export const ScoreDimensionSchema = z.enum([
  "strategyEdge",
  "marketRegime",
  "multiTimeframe",
  "executionQuality",
  "riskApproval",
  "traderBehavior",
  "liveValidation",
]);
export type ScoreDimension = z.infer<typeof ScoreDimensionSchema>;

// Weights must sum to 100. Risk + StrategyEdge dominate.
export const SCORE_WEIGHTS: Record<ScoreDimension, number> = {
  strategyEdge:     20,
  marketRegime:     15,
  multiTimeframe:   15,
  executionQuality: 10,
  riskApproval:     20,
  traderBehavior:   15,
  liveValidation:    5,
};

// ── Blocker severity — encodes the hierarchy ───────────────────────────────
//   BROKER (10) > RISK (5) > AI (1)
//   Risk cannot override broker; AI cannot override risk.
export const BlockerSeveritySchema = z.enum(["BROKER", "RISK", "AI", "BEHAVIOR", "DATA"]);
export type BlockerSeverity = z.infer<typeof BlockerSeveritySchema>;

export interface Blocker {
  severity: BlockerSeverity;
  dimension: ScoreDimension;
  message: string;
}

// ── Per-dimension scorer output ────────────────────────────────────────────
export interface ScoreReport {
  dimension: ScoreDimension;
  score: number;                    // 0..100
  weight: number;                   // 0..100, contribution to final
  blockers: Blocker[];              // any present → final BLOCK regardless of score
  warnings: string[];
  reasons: string[];                // structured per-rule explanation
  evidence: Record<string, unknown>;
}

// ── Advisory conformal evidence (capability #4) ────────────────────────────
// Structural mirror of lib/validation `ConformalGateVerdict` — @workspace/domain
// deliberately does NOT depend on @workspace/validation (the package graph is
// frozen; lib/discovery and api-server edgePromotion mirror validation types
// the same way). Structural fidelity to the real conformalGate output is
// pinned by the scripts-package conformal-bounds test, which drives the REAL
// lib/validation gate and assigns its verdict into this shape.
//
// ADVISORY ONLY. This is journal/display evidence riding on the confidence
// gate result. It is NOT a gate key, NOT a blocker source, and can never
// change `approved` / `finalScore` / `recommendation` — pinned by test.
export interface ConformalAdvisoryEvidence {
  admissible: boolean;
  interval: { lower: number; upper: number; unbounded: boolean } | null;
  outcomeSet: string[] | null;
  coverage: number;
  calibrationSize: number;
  reason: string;
  advisoryOnly: true;
}

export interface ConfidenceGateAdvisory {
  conformal?: ConformalAdvisoryEvidence;
  /**
   * Unified horizon-frame evidence (capability #10): per-horizon state, state
   * age, and reliability across microstructure/entry/position/session/regime/
   * strategy/capital. Journal/display evidence only — `attachHorizonAdvisory`
   * is the only writer and it copies every verdict field through unchanged.
   */
  horizons?: HorizonFrameEvidence;
}

// ── Recommendation ─────────────────────────────────────────────────────────
export const RecommendationSchema = z.enum(["ENTER", "WAIT", "REDUCE_RISK", "BLOCK"]);
export type Recommendation = z.infer<typeof RecommendationSchema>;

// ── Final result — exactly the shape the spec requires ─────────────────────
export interface ConfidenceGateResult {
  approved: boolean;
  finalScore: number;               // 0..100, weighted average
  requiredScore: RequiredScore;     // always 95
  blockers: string[];               // formatted "[SEV][dim] message"
  warnings: string[];
  scoreBreakdown: {
    strategyEdge:     number;
    marketRegime:     number;
    multiTimeframe:   number;
    executionQuality: number;
    riskApproval:     number;
    traderBehavior:   number;
    liveValidation:   number;
  };
  recommendation: Recommendation;

  /**
   * Advisory evidence riding on the result for journal/display consumers.
   * NEVER consulted by the verdict logic — `attachConformalAdvisory` is the
   * only writer and it copies every verdict field through unchanged.
   */
  advisory?: ConfidenceGateAdvisory;

  // Audit-grade extras (not in the minimum spec but required by the rules:
  // "every blocked trade must explain why", "every approved trade stored
  // for replay"). These are the fields a persistence layer captures verbatim.
  reports: ScoreReport[];           // full per-dimension reports
  signalId: string;
  decidedAt: string;                // ISO
  totalDurationMs: number;
}

// ── User override audit record ─────────────────────────────────────────────
// "User override must be logged." The engine itself never flips the verdict;
// it produces an OverrideRecord that the caller persists alongside the
// ConfidenceGateResult. Approval at execution time consults both.
export const OverrideRecordSchema = z.object({
  resultDecidedAt: z.string(),      // ties back to ConfidenceGateResult.decidedAt
  signalId: z.string(),
  by: z.string(),                   // operator id
  reason: z.string().min(10, "Override reason must be ≥10 chars"),
  acknowledgedBlockers: z.array(z.string()),
  acknowledgedScore: z.number(),
  overriddenAt: z.string(),         // ISO
  confirmedBy: z.string().nullable(),  // optional second-party confirmer
});
export type OverrideRecord = z.infer<typeof OverrideRecordSchema>;

// ── Replay record — every APPROVED trade is stored as one of these ─────────
export const ReplayRecordSchema = z.object({
  signalId: z.string(),
  decidedAt: z.string(),
  finalScore: z.number(),
  recommendation: RecommendationSchema,
  contextFingerprint: z.string(),   // hash of inputs for reproducibility
  result: z.unknown(),              // serialized ConfidenceGateResult
});
export type ReplayRecord = z.infer<typeof ReplayRecordSchema>;

// ── Strategy edge stats (input to strategyEdgeScore) ──────────────────────
export interface StrategyEdgeStats {
  strategyName: string;
  backtestWinRate: number;          // 0..1
  backtestProfitFactor: number;
  backtestSampleSize: number;
  backtestExpectancyR: number;
  lastBacktestAt: string;           // ISO
  recentLiveWinRate: number | null; // 0..1, last N forward trades
  recentLiveSampleSize: number;
}

// ── Multi-timeframe input ─────────────────────────────────────────────────
export interface TimeframeView {
  timeframe: "M5" | "M15" | "H1" | "H4" | "D1";
  trend: "UP" | "DOWN" | "SIDEWAYS";
  regime: "TRENDING" | "RANGING" | "VOLATILE" | "QUIET";
  strength: number;                 // 0..100
}

// ── Live validation input — forward-test performance ─────────────────────
export interface LiveValidationStats {
  forwardTradesCount: number;
  forwardWinRate: number | null;    // 0..1
  forwardExpectancyR: number | null;
  expectedWinRate: number;          // 0..1, from backtest
  expectedExpectancyR: number;
  lastUpdatedAt: string;
}

// ── Full context the orchestrator needs ────────────────────────────────────
export interface ConfidenceGateContext {
  signal: SignalState;
  account: AccountState;
  risk: RiskState;
  baselineRiskLimits: RiskLimits;
  marketSnapshot: SymbolMarketSnapshot;
  broker: BrokerConnectionState;
  strategyStats: StrategyEdgeStats;
  timeframes: TimeframeView[];      // typically [M15, H1, H4]
  trader: {
    profile: TraderProfile;
    patterns: BehaviorPatternReport;
    overtrade: OvertradeReport | null;
    revenge: RevengeTradeReport | null;
  };
  liveValidation: LiveValidationStats;
  now?: Date;
}
