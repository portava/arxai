// Build H — Live Position evaluator I/O. Pure types only.

export type LivePositionStatus =
  | "OPEN"
  | "PARTIALLY_CLOSED"
  | "CLOSED"
  | "STOP_LOSS_HIT"
  | "TAKE_PROFIT_HIT"
  | "MANUALLY_CLOSED"
  | "BROKER_ERROR"
  | "SYNC_PENDING";

export const POSITION_STATUS_TERMINAL: Record<LivePositionStatus, boolean> = {
  OPEN: false,
  PARTIALLY_CLOSED: false,
  SYNC_PENDING: false,
  BROKER_ERROR: false,
  CLOSED: true,
  STOP_LOSS_HIT: true,
  TAKE_PROFIT_HIT: true,
  MANUALLY_CLOSED: true,
};

export interface LivePositionInput {
  direction: "BUY" | "SELL";
  lotSize: number;
  entryPrice: number;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Number of other open positions on correlated symbols (caller-provided). */
  correlatedOpenCount: number;
  /** Account equity at evaluation time, for exposure ratio. */
  accountEquity: number | null;
  /** Was a stopLoss previously set and is now null? Caller computes by diff. */
  stopLossWasRemoved: boolean;
}

export type RiskWarningCode =
  | "PRICE_NEAR_SL"
  | "STOP_LOSS_REMOVED"
  | "EXPOSURE_HIGH"
  | "CORRELATED_TRADES"
  | "ADVERSE_DRIFT"
  | "REWARD_RISK_LOW";

export interface RiskWarning {
  code: RiskWarningCode;
  severity: "INFO" | "WARN" | "DANGER";
  message: string;
  aiExplanation: string;
}

export interface PositionRiskVerdict {
  status: LivePositionStatus;
  unrealizedPnL: number | null;
  rewardToRisk: number | null;
  /** Distance from current price to stop-loss as a fraction of entry→SL distance. 0 = AT_SL, 1 = AT_ENTRY. */
  slProximity: number | null;
  warnings: RiskWarning[];
  blockers: string[];
}

/** Mutations the API allows operators to make to a live position. */
export type PositionMutationKind =
  | "UPDATE_STOP_LOSS"
  | "UPDATE_TAKE_PROFIT"
  | "REMOVE_STOP_LOSS"
  | "MANUAL_CLOSE";
