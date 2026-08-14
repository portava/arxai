import { z } from "zod/v4";
import type { AiDecision } from "../ai/aiInsight.types";
import type { RiskProfile } from "../risk/riskProfile.types";
import type { DrawdownReport } from "../risk/drawdownGuard.engine";
import type { ExposureReport } from "../risk/exposure.engine";
import type { SignalState, AccountState } from "../state/appState.types";
import type { Mt5ConnectionState } from "../broker/mt5.types";
import type { Trade } from "../trade/trade.types";
import type { DomainEvent } from "../events/domainEvents.types";

// ── Stage identifiers ───────────────────────────────────────────────────────
export const PipelineStageSchema = z.enum([
  "DECIDE",   // AI decides
  "APPROVE",  // Risk approves
  "PLACE",    // Execution places
  "MANAGE",   // Monitor manages
  "AUDIT",    // Audit records (always runs, even on rejection)
]);
export type PipelineStage = z.infer<typeof PipelineStageSchema>;

// ── Per-stage status ────────────────────────────────────────────────────────
export const StageStatusSchema = z.enum(["PASSED", "REJECTED", "ERRORED", "SKIPPED"]);
export type StageStatus = z.infer<typeof StageStatusSchema>;

export interface StageResult<T = unknown> {
  stage: PipelineStage;
  status: StageStatus;
  output: T | null;
  reasons: string[];           // human + machine readable
  events: DomainEvent[];       // events emitted at this stage
  durationMs: number;
}

// ── Inputs the orchestrator threads through every stage ────────────────────
// PipelineContext is built once per pipeline run by the route handler from
// the current TradingAppState. It is read-only inside the pipeline.
export interface PipelineContext {
  signal: SignalState;
  account: AccountState;
  broker: Mt5ConnectionState;
  riskProfile: RiskProfile;
  drawdown: DrawdownReport | null;
  exposure: ExposureReport | null;
  openTrades: Trade[];
  source: string;              // for event envelopes
  correlationId?: string | null;
}

// ── Stage outputs ───────────────────────────────────────────────────────────
export interface DecideOutput {
  decision: AiDecision;
}

export interface ApproveOutput {
  decision: AiDecision;
  // Risk-adjusted sizing for the place stage. Stops the place stage from
  // re-deriving lot size from a possibly stale snapshot.
  approvedLotSize: number;
  approvedStopLoss: number;
  approvedTakeProfit: number | null;
}

export interface PlaceOutput {
  trade: Trade;                // post-fill, includes broker ticket as id
  filledPrice: number;
  filledAt: string;            // ISO
  slippage: number;            // price units
  latencyMs: number;
}

// What the management decision phase produces. The actual SL/TP push is
// performed by ExecutionPort in a follow-up call.
export interface ManageOutput {
  tradeId: Trade["id"];
  action: "MOVE_SL" | "MOVE_TP" | "PARTIAL_CLOSE" | "FULL_CLOSE" | "TRAIL" | "HOLD";
  newStopLoss?: number;
  newTakeProfit?: number;
  closeFraction?: number;
  reason: string;
}

// ── Final pipeline outcome ──────────────────────────────────────────────────
export interface PipelineOutcome {
  finalStage: PipelineStage;       // last stage that ran
  passed: boolean;                 // true only if PLACE succeeded
  results: StageResult[];          // every stage that ran, in order
  events: DomainEvent[];           // flattened event log for the run
  rejectionReasons: string[];      // collected reasons if !passed
  trade: Trade | null;             // populated on PLACE success
}
