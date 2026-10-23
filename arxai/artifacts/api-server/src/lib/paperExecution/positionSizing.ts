// Build EE — Paper position sizing.
//
// Conservative bounded sizing. NEVER calls live broker; never asks MT5 for
// margin/leverage. Inputs are pure numbers + paper account equity.

import type { PositionSizingResult } from "./types.js";

// Configurable defaults — also used as fallbacks if risk_settings missing.
export const PAPER_DEFAULTS = {
  riskPercent: 0.01,            // 1% of equity per paper trade
  defaultEquity: 10_000,
  maxOpenPaperTrades: 3,
  maxSameSymbolPaperTrades: 1,
  maxLotSize: 5,                // hard cap so a single trade never blows up
  minLotSize: 0.01,
  pointValuePerLot: 100,        // matches existing paperTrading pnlFor()
} as const;

export function calculatePositionSize(args: {
  accountEquity: number;
  entryPrice: number;
  stopLoss: number;
  riskPercentOverride?: number;
  maxLotSizeOverride?: number;
}): PositionSizingResult {
  const equity = Math.max(0, args.accountEquity || 0);
  const riskPct = args.riskPercentOverride ?? PAPER_DEFAULTS.riskPercent;
  const maxLot  = args.maxLotSizeOverride  ?? PAPER_DEFAULTS.maxLotSize;
  const riskAmount = equity * riskPct;
  const stopDistance = Math.abs(args.entryPrice - args.stopLoss);

  let calc = 0;
  let reason = "ok";
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
    reason = "stop distance is zero or invalid — cannot size";
    calc = 0;
  } else if (riskAmount <= 0) {
    reason = "risk amount is zero — equity is zero or risk percent is zero";
    calc = 0;
  } else {
    calc = riskAmount / (stopDistance * PAPER_DEFAULTS.pointValuePerLot);
  }

  const capped = Math.max(
    PAPER_DEFAULTS.minLotSize,
    Math.min(maxLot, Number(calc.toFixed(2)) || 0),
  );
  if (capped >= maxLot && calc > maxLot) reason = `capped at maxLotSize=${maxLot}`;
  if (calc < PAPER_DEFAULTS.minLotSize && calc > 0) reason = `floored at minLotSize=${PAPER_DEFAULTS.minLotSize}`;

  return {
    account_equity: equity,
    risk_percent: riskPct,
    risk_amount: Number(riskAmount.toFixed(2)),
    stop_distance: Number(stopDistance.toFixed(5)),
    calculated_position_size: Number(calc.toFixed(4)) || 0,
    capped_position_size: capped,
    reason,
  };
}
