import { z } from "zod/v4";
import type { StrategyInput, StrategyResult } from "./strategy.types";
import type { Trade } from "../trade/trade.types";
import type { Candle } from "../market/marketRegime.engine";

// ── analyze() — pre-signal market read ──────────────────────────────────────
// Pure inspection: does the market currently look like this strategy's
// preferred setup? Used by the explainability panel and by scoreSetup().
export interface StrategyAnalysis {
  strategyName: string;
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  conditions: AnalysisCondition[];   // each precondition this strategy cares about
  notes: string[];
}

export interface AnalysisCondition {
  name: string;
  met: boolean;
  weight: number;          // 0..100 — how much this condition contributes to score
  observed?: string;       // observed value rendered for UI
  required?: string;       // required value rendered for UI
}

// ── scoreSetup() — quality scoring 0..100 with breakdown ───────────────────
export interface SetupScore {
  strategyName: string;
  score: number;                     // 0..100
  threshold: number;                 // strategy-specific pass mark
  passed: boolean;
  breakdown: SetupScoreFactor[];
  reasons: string[];
}

export interface SetupScoreFactor {
  factor: string;
  earned: number;
  max: number;
  note?: string;
}

// ── manageTrade() — per-strategy active management ─────────────────────────
// Strategies can implement their own trail / BE move / partial logic. The
// default lifecycle composer falls back to a generic implementation when a
// strategy doesn't override this.
export interface ManageContext {
  strategyName: string;        // Trade has no `strategy` field — supplied by caller
  trade: Trade;
  candles: Candle[];
  pipSize: number;
  currentPrice: number;
  highSinceOpen: number;
  lowSinceOpen: number;
  ageSeconds: number;
  now: Date;
}

export const ManageActionSchema = z.enum([
  "HOLD",
  "MOVE_SL_TO_BREAKEVEN",
  "TRAIL_SL",
  "PARTIAL_CLOSE",
  "FULL_CLOSE",
]);
export type ManageAction = z.infer<typeof ManageActionSchema>;

export interface ManageDecision {
  strategyName: string;
  action: ManageAction;
  newStopLoss?: number;
  partialFraction?: number;          // 0..1 — fraction of position to close
  reasons: string[];
}

// ── exitRules() — when to exit early (separate from broker SL/TP) ──────────
export const ExitTypeSchema = z.enum([
  "TP_HIT",
  "SL_HIT",
  "TRAIL_STOP",
  "TIME_STOP",
  "INVALIDATION",        // setup thesis no longer valid
  "REGIME_FLIP",         // market regime turned against the trade
  "VOLATILITY_SHOCK",    // EXTREME volatility while in trade
]);
export type ExitType = z.infer<typeof ExitTypeSchema>;

export interface ExitDecision {
  strategyName: string;
  shouldExit: boolean;
  exitType: ExitType | null;
  reasons: string[];
}

// ── The full lifecycle contract ─────────────────────────────────────────────
// Strategies opt into this richer shape when they want per-strategy
// management/exit. Otherwise they stay on the simple `Strategy` interface
// and the default lifecycle composer fills in generic implementations.
export interface StrategyLifecycle {
  name: string;
  label: string;
  version: string;

  analyze(input: StrategyInput): StrategyAnalysis;
  scoreSetup(input: StrategyInput, analysis: StrategyAnalysis): SetupScore;
  generateSignal(input: StrategyInput, analysis: StrategyAnalysis, score: SetupScore): StrategyResult;
  manageTrade(ctx: ManageContext): ManageDecision;
  exitRules(ctx: ManageContext): ExitDecision;
}
