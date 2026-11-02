// Position sizing for the API (Tier 1 Risk Governor: one sizer).
//
// The formula lives in one place, @workspace/domain/risk lotForRisk():
//   lot = risk budget / (stop distance × money per 1.0 price unit per lot),
// stepped and clamped. This module only supplies the value models the API
// uses and keeps the result shapes its callers read:
//   - calculatePositionSize       instrument-class model (risk calculator,
//                                 missions, paper intelligence)
//   - calculatePaperPositionSize  paper execution (100 per point per lot)
// It replaces lib/positionSizing.ts and lib/paperExecution/positionSizing.ts,
// which each carried their own copy of the formula.

import { lotForRisk } from "@workspace/domain/risk";
import type { PositionSizingResult } from "../paperExecution/types.js";

const NO_MAX = Number.MAX_SAFE_INTEGER;

// ── Instrument-class model ──────────────────────────────────────────────────

export interface PositionSizeInput {
  accountBalance: number;
  riskPercent: number;
  entry: number;
  stopLoss: number;
  symbol: string;
  maxLotSize?: number;
}

export interface PositionSizeResult {
  riskAmount: number;
  stopDistance: number;
  suggestedLot: number;
  maxLotAllowed: number;
  finalLot: number;
  warning: string | null;
}

function isSynthetic(symbol: string): boolean {
  return symbol.toLowerCase().includes("volatility") || symbol.toLowerCase().includes("boom") || symbol.toLowerCase().includes("crash");
}

function isForex(symbol: string): boolean {
  return /^[A-Z]{6}$/.test(symbol.replace(/\s/g, "")) || symbol.includes("USD") || symbol.includes("EUR") || symbol.includes("GBP");
}

/** Money per 1.0 price move per 1.0 lot for a symbol class. */
function valuePerUnitPerLot(symbol: string): number {
  // Synthetic indices, indices and stocks: $1 per point per lot.
  if (isSynthetic(symbol) || !isForex(symbol)) return 1;
  // Forex standard lot: pip value ≈ $10, pip = 0.0001 (0.01 for JPY).
  return 10 / (symbol.includes("JPY") ? 0.01 : 0.0001);
}

export function calculatePositionSize(input: PositionSizeInput): PositionSizeResult {
  const { accountBalance, riskPercent, entry, stopLoss, symbol, maxLotSize = 10 } = input;
  const riskAmount = accountBalance * (riskPercent / 100);
  const stopDistance = Math.abs(entry - stopLoss);
  if (![accountBalance, riskPercent, entry, stopLoss, maxLotSize, riskAmount, stopDistance].every(n => Number.isFinite(n) && n > 0)) {
    return { riskAmount: 0, stopDistance: 0, suggestedLot: 0, maxLotAllowed: Number.isFinite(maxLotSize) ? maxLotSize : 0, finalLot: 0,
      warning: "Sizing inputs or stop distance are zero or invalid — no position size available." };
  }

  let warning: string | null = null;
  // V75 (1s) requires a smaller lot: halve it by doubling the value per unit.
  const isV75_1s = symbol.includes("(1s)") || symbol.toLowerCase().includes("1s");
  if (isV75_1s) warning = "V75 (1s): lot size halved due to extreme tick volatility.";

  const sized = lotForRisk({
    riskAmount, stopDistance, valuePerUnitPerLot: valuePerUnitPerLot(symbol) * (isV75_1s ? 2 : 1),
    minLot: 0.01, maxLot: NO_MAX, lotStep: 0.01, rounding: "nearest",
  });
  const bounded = lotForRisk({
    riskAmount, stopDistance, valuePerUnitPerLot: valuePerUnitPerLot(symbol) * (isV75_1s ? 2 : 1),
    minLot: 0.01, maxLot: maxLotSize, lotStep: 0.01,
  });
  const finalLot = bounded.lot;
  const suggestedLot = sized.invalid ? finalLot : sized.lot;
  if (bounded.invalid) warning = (warning ? warning + " " : "") + `No size: ${bounded.invalid}.`;
  else if (sized.invalid) warning = (warning ? warning + " " : "") + "Only the bounded lot is available; the uncapped size exceeds numeric precision.";
  else if (finalLot < suggestedLot) warning = (warning ? warning + " " : "") + `Lot capped at max allowed (${maxLotSize}).`;

  return {
    riskAmount, // budget, not actual loss or broker-confirmed risk
    stopDistance,
    suggestedLot,
    maxLotAllowed: maxLotSize,
    finalLot,
    warning: warning?.trim() ?? null,
  };
}

// ── Paper execution model ───────────────────────────────────────────────────

// Configurable defaults — also used as fallbacks if risk settings are missing.
export const PAPER_DEFAULTS = {
  riskPercent: 0.01,            // 1% of equity per paper trade
  defaultEquity: 10_000,
  maxOpenPaperTrades: 3,
  maxSameSymbolPaperTrades: 1,
  maxLotSize: 5,                // hard cap so a single trade never blows up
  minLotSize: 0.01,
  pointValuePerLot: 100,        // matches existing paperTrading pnlFor()
} as const;

/** Conservative bounded paper sizing. Never asks a broker for margin or leverage. */
export function calculatePaperPositionSize(args: {
  accountEquity: number;
  entryPrice: number;
  stopLoss: number;
  riskPercentOverride?: number;
  maxLotSizeOverride?: number;
}): PositionSizingResult {
  const equity = args.accountEquity;
  const riskPct = args.riskPercentOverride ?? PAPER_DEFAULTS.riskPercent;
  const maxLot = args.maxLotSizeOverride ?? PAPER_DEFAULTS.maxLotSize;
  const riskAmount = equity * riskPct;
  const stopDistance = Math.abs(args.entryPrice - args.stopLoss);
  if (![equity, riskPct, maxLot, args.entryPrice, args.stopLoss, riskAmount, stopDistance].every(n => Number.isFinite(n) && n > 0)) {
    return { account_equity: Number.isFinite(equity) ? equity : 0, risk_percent: Number.isFinite(riskPct) ? riskPct : 0,
      risk_amount: 0, stop_distance: 0, calculated_position_size: 0, capped_position_size: 0,
      reason: "sizing inputs or stop distance are zero or invalid — cannot size" };
  }

  const sized = lotForRisk({
    riskAmount, stopDistance, valuePerUnitPerLot: PAPER_DEFAULTS.pointValuePerLot,
    minLot: PAPER_DEFAULTS.minLotSize, maxLot, lotStep: 0.01, rounding: "nearest",
  });
  let reason = sized.invalid ?? "ok";
  if (!sized.invalid && sized.clampedToMax) reason = `capped at maxLotSize=${maxLot}`;

  return {
    account_equity: equity,
    risk_percent: riskPct,
    risk_amount: riskAmount,
    stop_distance: stopDistance,
    calculated_position_size: Number(sized.rawLot.toFixed(4)) || 0,
    capped_position_size: sized.lot,
    reason,
  };
}
