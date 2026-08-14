// agentPerformance — types used by the accountability layer (scoring,
// calibration, false-approval / false-block tracking).

import type { AgentVote } from "../agentVote.types";

/** Letter grade per agent per decision.
 *  Named CouncilAgentGrade to avoid clashing with the legacy
 *  `AgentGrade` interface in agentSystem.types (a different concept). */
export type CouncilAgentGrade = "A" | "B" | "C" | "D" | "F";

/** Outcome of the trade (or replay) the agent voted on. */
export type TradeOutcome =
  | "WIN"                  // trade taken, profit
  | "LOSS"                 // trade taken, loss
  | "BREAKEVEN"            // trade taken, ~0
  | "SKIPPED"              // no trade taken; outcome unknown
  | "BLOCKED_CORRECTLY"    // blocked, would have lost
  | "BLOCKED_WRONGLY";     // blocked, would have won

export interface AgentPerformanceRecord {
  agentId: string;
  agentName: string;
  decisionId: string;
  vote: AgentVote;
  confidence01: number;
  outcome: TradeOutcome;
  pnlR: number | null;       // realized PnL in R-multiples (null if not taken)
  scoreDelta: number;        // -2..+2
  grade: CouncilAgentGrade;
  rationale: string;
  recordedAtIso: string;
}

/** One bucket of confidence vs realised win-rate for calibration scoring. */
export interface CalibrationBucket {
  rangeLow01: number;
  rangeHigh01: number;
  count: number;
  positiveOutcomes: number;       // WIN + BLOCKED_CORRECTLY
  empiricalRate01: number;        // positives / count, or 0 if count===0
  expectedRate01: number;         // bucket midpoint
  calibrationError01: number;     // |empirical − expected|
}

export interface AgentCalibrationReport {
  agentId: string;
  buckets: CalibrationBucket[];
  /** Mean of |empirical − expected|, weighted by bucket count. */
  meanAbsError01: number;
  isHonest: boolean;              // meanAbsError01 <= 0.15
  sampleSize: number;
  recordedAtIso: string;
}
