// Build EE — Paper Execution Engine types.
//
// SAFETY: paper-only. None of these types reference live execution surfaces.

export type PaperExecutionStatus =
  | "PAPER_OPENED"
  | "PAPER_REJECTED"
  | "PAPER_PENDING"
  | "PAPER_CLOSED_WIN"
  | "PAPER_CLOSED_LOSS"
  | "PAPER_CLOSED_BREAK_EVEN"
  | "PAPER_CLOSED_MANUAL"
  | "PAPER_CANCELLED";

export type FillType = "SIMULATED_MARKET" | "SIMULATED_LIMIT";

export interface PaperExecutionResult {
  execution_id: string;
  decision_id: number | null;
  trade_id: number | null;
  symbol: string;
  action: "BUY" | "SELL" | "HOLD";
  status: PaperExecutionStatus;
  entry_price_requested: number | null;
  entry_price_filled: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  position_size: number | null;
  risk_amount: number | null;
  confidence: number | null;
  risk_score: number | null;
  execution_mode: "PAPER";
  fill_type: FillType;
  slippage_applied: number | null;
  spread_applied: number | null;
  rejection_reason: string | null;
  warnings: string[];
  created_at: string;
  idempotent_replay: boolean;
}

export interface PositionSizingResult {
  account_equity: number;
  risk_percent: number;
  risk_amount: number;
  stop_distance: number;
  calculated_position_size: number;
  capped_position_size: number;
  reason: string;
}

export interface ExecuteFromDecisionOpts {
  // If provided, use this paper account; else pick the active one.
  paperAccountId?: number;
  // If true, allow taking the trade even with a same-symbol+direction
  // already open. Default false (conservative).
  allowConflicts?: boolean;
}
