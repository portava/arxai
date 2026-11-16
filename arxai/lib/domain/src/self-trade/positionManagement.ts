// Self-Trade AI — autonomous position management (Autonomous Live Execution,
// Task #213). PURE / deterministic. Given an OPEN agent position + the live
// price + the original thesis levels, decide the next management action.
//
// SAFETY (inviolable):
// - This module NEVER closes/modifies an order. It only computes an action. The
//   api-server position manager turns an action into a REAL command through the
//   same executeInstant pipeline (MODIFY/CLOSE), honouring all 16 gates.
// - A protective stop is never relaxed: a proposed new stop must improve on the
//   current one (closer to price on the favourable side) or the action degrades
//   to HOLD. We never move a stop further from price.
// - No invented levels: with no usable risk distance we HOLD (or EXIT only on a
//   real invalidation breach), never guess a trail.

import type { TradeSide } from "./selfTradeDecision.types.js";

export type ManagementAction =
  | "HOLD"
  | "MOVE_TO_BE"
  | "TIGHTEN_SL"
  | "TAKE_PARTIAL"
  | "EXIT";

export interface PositionManagementInput {
  side: TradeSide;
  entryPrice: number;
  currentPrice: number;
  /** Original protective stop from the thesis (price). */
  stopLoss: number | null;
  /** The stop currently active on the broker position (price). */
  currentSl: number | null;
  /** Ordered take-profit zones from the thesis. */
  takeProfits: { from: number; to: number }[];
  invalidation: number | null;

  /** Management memory (from self_trade_agent_executions.managementState). */
  beMoved: boolean;
  partialsTaken: number;

  autonomyLevel: number; // L3 manage; L4 also extend (handled by caller)
}

export interface PositionManagementVerdict {
  action: ManagementAction;
  reason: string;
  rMultiple: number;
  /** Proposed new stop for MOVE_TO_BE / TIGHTEN_SL (else null). */
  newStopLoss: number | null;
  /** Fraction to close for TAKE_PARTIAL (else null). */
  partialFraction: number | null;
}

const EPS = 1e-9;

export function evaluateManagementAction(
  input: PositionManagementInput,
): PositionManagementVerdict {
  const isBuy = input.side === "BUY";
  const profitDistance = isBuy
    ? input.currentPrice - input.entryPrice
    : input.entryPrice - input.currentPrice;

  const riskDistance =
    input.stopLoss != null ? Math.abs(input.entryPrice - input.stopLoss) : 0;
  const rMultiple = riskDistance > EPS ? profitDistance / riskDistance : 0;

  const hold = (reason: string): PositionManagementVerdict => ({
    action: "HOLD",
    reason,
    rMultiple,
    newStopLoss: null,
    partialFraction: null,
  });

  // 1. Invalidation breach → EXIT (highest priority; a real structural break).
  if (input.invalidation != null) {
    const breached = isBuy
      ? input.currentPrice <= input.invalidation
      : input.currentPrice >= input.invalidation;
    if (breached) {
      return {
        action: "EXIT",
        reason: "Invalidation level breached.",
        rMultiple,
        newStopLoss: null,
        partialFraction: null,
      };
    }
  }

  // 2. Final target reached → EXIT.
  const finalTp = lastTarget(input.takeProfits);
  if (finalTp != null) {
    const reached = isBuy
      ? input.currentPrice >= finalTp
      : input.currentPrice <= finalTp;
    if (reached) {
      return {
        action: "EXIT",
        reason: "Final take-profit target reached.",
        rMultiple,
        newStopLoss: null,
        partialFraction: null,
      };
    }
  }

  // 3. First target reached + no partial yet → TAKE_PARTIAL (de-risk).
  const firstTp = firstTarget(input.takeProfits);
  if (firstTp != null && input.partialsTaken <= 0) {
    const reached = isBuy
      ? input.currentPrice >= firstTp
      : input.currentPrice <= firstTp;
    if (reached) {
      return {
        action: "TAKE_PARTIAL",
        reason: "First take-profit reached — banking partial, de-risking.",
        rMultiple,
        partialFraction: 0.5,
        newStopLoss: null,
      };
    }
  }

  // Stop management requires a real risk distance.
  if (riskDistance <= EPS) {
    return hold("No usable risk distance — holding (no synthetic trail).");
  }

  // 4. ≥ 1R and break-even not yet moved → MOVE_TO_BE.
  if (rMultiple >= 1 && !input.beMoved) {
    const newSl = input.entryPrice;
    if (improvesStop(isBuy, newSl, input.currentSl)) {
      return {
        action: "MOVE_TO_BE",
        reason: "Reached 1R — moving stop to break-even.",
        rMultiple,
        newStopLoss: newSl,
        partialFraction: null,
      };
    }
  }

  // 5. ≥ 1.5R and already at break-even → TIGHTEN_SL (lock half the gain).
  if (rMultiple >= 1.5 && input.beMoved) {
    const lock = profitDistance * 0.5;
    const newSl = isBuy ? input.entryPrice + lock : input.entryPrice - lock;
    if (improvesStop(isBuy, newSl, input.currentSl)) {
      return {
        action: "TIGHTEN_SL",
        reason: "Beyond 1.5R — trailing stop to lock in gains.",
        rMultiple,
        newStopLoss: newSl,
        partialFraction: null,
      };
    }
  }

  return hold("No management trigger met — holding.");
}

function firstTarget(tps: { from: number; to: number }[]): number | null {
  if (tps.length === 0) return null;
  return tps[0].from;
}

function lastTarget(tps: { from: number; to: number }[]): number | null {
  if (tps.length === 0) return null;
  return tps[tps.length - 1].to;
}

// A new stop only counts if it moves CLOSER to price on the protective side
// (never further away). For BUY the stop rises; for SELL it falls.
function improvesStop(
  isBuy: boolean,
  newSl: number,
  currentSl: number | null,
): boolean {
  if (currentSl == null) return true;
  return isBuy ? newSl > currentSl + EPS : newSl < currentSl - EPS;
}
