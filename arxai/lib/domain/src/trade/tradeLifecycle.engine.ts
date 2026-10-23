import type { Trade, TradeStatus } from "./trade.types";

// Allowed transitions in the trade state machine. Anything not listed is rejected.
const TRANSITIONS: Record<TradeStatus, TradeStatus[]> = {
  PENDING:           ["OPEN", "CANCELLED", "EXPIRED"],
  OPEN:              ["MANAGING", "CLOSED_WIN", "CLOSED_LOSS", "CLOSED_BREAKEVEN"],
  MANAGING:          ["CLOSED_WIN", "CLOSED_LOSS", "CLOSED_BREAKEVEN"],
  CLOSED_WIN:        [],
  CLOSED_LOSS:       [],
  CLOSED_BREAKEVEN:  [],
  CANCELLED:         [],
  EXPIRED:           [],
};

export interface TransitionResult {
  ok: boolean;
  reason?: string;
  next?: Trade;
}

export function canTransition(from: TradeStatus, to: TradeStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function transition(trade: Trade, to: TradeStatus, patch: Partial<Trade> = {}): TransitionResult {
  if (!canTransition(trade.status, to)) {
    return { ok: false, reason: `Illegal transition ${trade.status} → ${to}` };
  }
  return { ok: true, next: { ...trade, ...patch, status: to } };
}

// Convenience: classify the closed reason from current price + R-multiple.
export function classifyClose(args: {
  trade: Trade;
  exitPrice: number;
}): "CLOSED_WIN" | "CLOSED_LOSS" | "CLOSED_BREAKEVEN" {
  const { trade, exitPrice } = args;
  const sign = trade.direction === "BUY" ? 1 : -1;
  const move = (exitPrice - trade.entryPrice) * sign;
  const slDist = Math.abs(trade.entryPrice - trade.stopLoss);
  if (slDist > 0 && Math.abs(move) / slDist < 0.1) return "CLOSED_BREAKEVEN";
  return move > 0 ? "CLOSED_WIN" : "CLOSED_LOSS";
}

export function isTerminal(status: TradeStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
