import { z } from "zod/v4";
import type { SignalState } from "../state/appState.types";
import type { AccountState, RiskState } from "../state/appState.types";
import type { RiskCheckResult, RiskLimits } from "../risk/riskProfile.types";
import type { TraderProfile, TraderHistoryWindow } from "../trader-dna/traderProfile.types";
import type { BehaviorPatternReport } from "../trader-dna/behaviorPattern.engine";
import type { OvertradeReport } from "../trader-dna/overtradeGuard.engine";
import type { RevengeTradeReport } from "../trader-dna/revengeTradingDetector.engine";

// ── Gate stages — ordered, must run in this sequence ───────────────────────
export const GateStageSchema = z.enum([
  "MARKET_AI",      // 1. Is the opportunity real?
  "RISK_ENGINE",    // 2. Can the account safely take it?
  "TRADER_DNA",     // 3. Is the human safe to take it?
  "EXECUTION",      // 4. Action layer — only entered if all 3 above APPROVE
]);
export type GateStage = z.infer<typeof GateStageSchema>;

// ── Per-stage verdict ──────────────────────────────────────────────────────
export const GateVerdictSchema = z.enum(["APPROVE", "WARN", "BLOCK"]);
export type GateVerdict = z.infer<typeof GateVerdictSchema>;

export interface StageResult {
  stage: GateStage;
  verdict: GateVerdict;
  reasons: string[];                 // structured rule-by-rule explanation
  warnings: string[];                // non-blocking concerns surfaced to UI
  evaluatedAt: string;               // ISO
  durationMs: number;
}

// ── Final decision returned by the orchestrator ────────────────────────────
export const FinalDecisionSchema = z.enum([
  "APPROVED",            // all 3 gates APPROVE — execution may proceed
  "BLOCKED",             // a gate returned BLOCK — execution must NOT proceed
  "APPROVED_WITH_WARN",  // all gates APPROVE but ≥1 returned warnings
]);
export type FinalDecision = z.infer<typeof FinalDecisionSchema>;

export interface ExecutionGateResult {
  decision: FinalDecision;
  blockedAt: GateStage | null;       // the stage that blocked, if any
  stages: StageResult[];             // ordered, stops at the blocking stage
  signalId: string;
  decidedAt: string;                 // ISO
  totalDurationMs: number;
}

// ── Inputs the orchestrator collects from each layer of the app ────────────
export interface ExecutionGateContext {
  signal: SignalState;
  account: AccountState;
  risk: RiskState;
  baselineRiskLimits: RiskLimits;
  trader: {
    profile: TraderProfile;
    window: TraderHistoryWindow;
    patterns: BehaviorPatternReport;
    overtrade: OvertradeReport | null;
    revenge: RevengeTradeReport | null;
  };
  now?: Date;
}

// ── Per-stage evaluators (Ports) — lets the orchestrator stay pure and the
//    real engines be plugged in or mocked in tests. ────────────────────────
export interface GateEvaluators {
  evaluateMarketAi: (ctx: ExecutionGateContext) => Pick<StageResult, "verdict" | "reasons" | "warnings">;
  evaluateRisk:     (ctx: ExecutionGateContext) => Pick<StageResult, "verdict" | "reasons" | "warnings"> & { underlying?: RiskCheckResult };
  evaluateTraderDna:(ctx: ExecutionGateContext) => Pick<StageResult, "verdict" | "reasons" | "warnings">;
}
