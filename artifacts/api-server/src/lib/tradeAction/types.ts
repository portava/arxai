// Phase UX8 — Trade Action Center types.

export const ACTION_TYPES = [
  "OPEN", "CLOSE", "PARTIAL_CLOSE",
  "MOVE_STOP", "TRAIL_STOP", "MODIFY_TP_SL",
  "CANCEL_ORDER",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_STATUSES = [
  "ai_suggested", "user_reviewing", "awaiting_confirmation",
  "confirmed", "guard_checking", "queued", "sent_to_mt5",
  "executed", "rejected", "failed", "expired", "cancelled",
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<ActionStatus> = new Set([
  "executed", "rejected", "failed", "expired", "cancelled",
]);

export const REQUESTED_MODES = ["SIMULATED", "DEMO", "LIVE"] as const;
export type RequestedMode = (typeof REQUESTED_MODES)[number];

export interface GuardCheckResult {
  id: string;
  name: string;
  passed: boolean;
  detail?: string;
}

export interface GuardChainResult {
  passed: boolean;
  failedCheckId: string | null;
  rejectionReason: string | null;
  checks: GuardCheckResult[];
}

// Common envelope returned to clients alongside SAFETY_ENVELOPE.
export interface ActionSummary {
  id: number;
  userId: number;
  tradeKey: string | null;
  actionType: ActionType;
  requestedMode: RequestedMode;
  accountType: string;
  routingMode: string;
  symbol: string;
  side: string | null;
  lotSize: number | null;
  requestedPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  reason: string | null;
  source: string;
  status: ActionStatus;
  confirmationRequired: boolean;
  confirmedByUser: boolean;
  confirmedAt: string | null;
  rejectionReason: string | null;
  guardResult: GuardChainResult | null;
  mt5Ticket: string | null;
  tradeCommandId: number | null;
  aiDecisionId: number | null;
  // Phase UX9 — execution result surface.
  mt5OrderTicket: string | null;
  mt5PositionTicket: string | null;
  fillPrice: number | null;
  slippage: number | null;
  filledLotSize: number | null;
  brokerMessage: string | null;
  errorCode: string | null;
  executedAt: string | null;
  staleAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}
