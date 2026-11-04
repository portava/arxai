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
const round2 = (n: number) => Math.round(n * 100) / 100;

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

  if (stopDistance === 0) {
    return {
      riskAmount: round2(riskAmount), stopDistance: 0, suggestedLot: 0, maxLotAllowed: maxLotSize, finalLot: 0,
      warning: "Stop loss distance is zero — cannot calculate lot size.",
    };
  }

  let warning: string | null = null;
  // V75 (1s) requires a smaller lot: halve it by doubling the value per unit.
  const isV75_1s = symbol.includes("(1s)") || symbol.toLowerCase().includes("1s");
  if (isV75_1s) warning = "V75 (1s): lot size halved due to extreme tick volatility.";

  const sized = lotForRisk({
    riskAmount, stopDistance, valuePerUnitPerLot: valuePerUnitPerLot(symbol) * (isV75_1s ? 2 : 1),
    minLot: 0.01, maxLot: NO_MAX, lotStep: 0.01, rounding: "nearest",
  });
  const suggestedLot = sized.invalid ? 0.01 : sized.lot;
  if (sized.invalid || sized.clampedToMin) warning = (warning ? warning + " " : "") + "Lot clamped to minimum 0.01.";

  const finalLot = round2(Math.min(suggestedLot, maxLotSize));
  if (finalLot < suggestedLot) warning = (warning ? warning + " " : "") + `Lot capped at max allowed (${maxLotSize}).`;

  return {
    riskAmount: round2(riskAmount),
    stopDistance: Math.round(stopDistance * 10000) / 10000,
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
  const equity = Math.max(0, args.accountEquity || 0);
  const riskPct = args.riskPercentOverride ?? PAPER_DEFAULTS.riskPercent;
  const maxLot = args.maxLotSizeOverride ?? PAPER_DEFAULTS.maxLotSize;
  const riskAmount = equity * riskPct;
  const stopDistance = Math.abs(args.entryPrice - args.stopLoss);

  const sized = lotForRisk({
    riskAmount, stopDistance, valuePerUnitPerLot: PAPER_DEFAULTS.pointValuePerLot,
    minLot: PAPER_DEFAULTS.minLotSize, maxLot, lotStep: 0.01, rounding: "nearest",
  });
  let reason = "ok";
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) reason = "stop distance is zero or invalid — cannot size";
  else if (riskAmount <= 0) reason = "risk amount is zero — equity is zero or risk percent is zero";
  else if (sized.clampedToMax) reason = `capped at maxLotSize=${maxLot}`;
  else if (sized.rawLot < PAPER_DEFAULTS.minLotSize) reason = `floored at minLotSize=${PAPER_DEFAULTS.minLotSize}`;

  return {
    account_equity: equity,
    risk_percent: riskPct,
    risk_amount: Number(riskAmount.toFixed(2)),
    stop_distance: Number(stopDistance.toFixed(5)),
    calculated_position_size: Number(sized.rawLot.toFixed(4)) || 0,
    capped_position_size: sized.invalid ? PAPER_DEFAULTS.minLotSize : sized.lot,
    reason,
  };
}
