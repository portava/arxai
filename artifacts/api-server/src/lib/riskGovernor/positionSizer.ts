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

/**
 * Which value model sized the lot (money per 1.0 price move per 1.0 lot).
 * This is an instrument-class heuristic, not the broker's contract spec:
 *   forex_usd_quote      XXXUSD currency pair: $10 per 0.0001 pip (standard lot, USD account)
 *   forex_other_quote    other currency pair: pip value is in the quote currency, $10 assumed
 *   synthetic_per_point  synthetic index: $1 per point per lot assumed
 *   per_point            index / stock CFD: $1 per point per lot assumed
 *   unknown_contract     not a known currency pair but sized as one (XAUUSD, BTCUSD…): not usable
 */
export type SizingValueModel = "forex_usd_quote" | "forex_other_quote" | "synthetic_per_point" | "per_point" | "unknown_contract";

export interface PositionSizeResult {
  riskAmount: number;
  stopDistance: number;
  suggestedLot: number;
  maxLotAllowed: number;
  finalLot: number;
  warning: string | null;
  /** The value model behind the lot (see SizingValueModel). */
  valueModel: SizingValueModel;
  /** true unless the model is the standard USD-quoted forex lot. */
  estimate: boolean;
  /** The assumed money per 1.0 price move per 1.0 lot. */
  valuePerUnitPerLot: number;
  /** Plain-English statement of the assumption, for display. */
  basis: string;
}

function isSynthetic(symbol: string): boolean {
  return symbol.toLowerCase().includes("volatility") || symbol.toLowerCase().includes("boom") || symbol.toLowerCase().includes("crash");
}

function isForex(symbol: string): boolean {
  return /^[A-Z]{6}$/.test(symbol.replace(/\s/g, "")) || symbol.includes("USD") || symbol.includes("EUR") || symbol.includes("GBP");
}

const ISO_CURRENCIES = new Set([
  "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK", "DKK", "SGD", "HKD", "ZAR", "MXN", "TRY", "PLN", "CNH", "HUF", "CZK",
]);

/**
 * Which model valuePerUnitPerLot() applies, classified by the same tests it
 * uses, so the label always describes the number that was computed.
 */
function sizingModelOf(symbol: string, unitValue: number): { model: SizingValueModel; basis: string } {
  if (isSynthetic(symbol)) {
    return { model: "synthetic_per_point", basis: `Synthetic index: assumes $${unitValue} per 1.0 price move per lot. Your broker's contract size may differ, so the lot is an estimate.` };
  }
  if (!isForex(symbol)) {
    return { model: "per_point", basis: `${symbol} is not a currency pair: assumes $${unitValue} per 1.0 price move per lot (index or stock CFD). Contract sizes vary by broker, so the lot is an estimate.` };
  }
  const compact = symbol.replace(/\s/g, "");
  const base = compact.slice(0, 3); const quote = compact.slice(3);
  if (/^[A-Z]{6}$/.test(compact) && ISO_CURRENCIES.has(base) && ISO_CURRENCIES.has(quote)) {
    const pip = symbol.includes("JPY") ? "0.01" : "0.0001";
    return quote === "USD"
      ? { model: "forex_usd_quote", basis: `Standard forex lot (100,000 units) of a USD-quoted pair: $10 per ${pip} pip, with the balance in USD.` }
      : { model: "forex_other_quote", basis: `${compact}'s pip value is in ${quote}, not USD. The calculator assumes $10 per ${pip} pip, so the lot is an estimate.` };
  }
  return {
    model: "unknown_contract",
    basis: `${symbol} is not a currency pair this calculator knows (metals, crypto and similar), but it was sized as one at $10 per pip. `
      + "That can be wrong by a factor of 1,000 or more, so the lot is not usable. Use your broker's contract specification.",
  };
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
  // V75 (1s) requires a smaller lot: halve it by doubling the value per unit.
  const isV75_1s = symbol.includes("(1s)") || symbol.toLowerCase().includes("1s");
  const unitValue = valuePerUnitPerLot(symbol) * (isV75_1s ? 2 : 1);
  const { model, basis } = sizingModelOf(symbol, unitValue);
  const disclosure = { valueModel: model, estimate: model !== "forex_usd_quote", valuePerUnitPerLot: unitValue, basis };

  if (stopDistance === 0) {
    return {
      riskAmount: round2(riskAmount), stopDistance: 0, suggestedLot: 0, maxLotAllowed: maxLotSize, finalLot: 0,
      warning: "Stop loss distance is zero — cannot calculate lot size.", ...disclosure,
    };
  }

  let warning: string | null = null;
  if (isV75_1s) warning = "V75 (1s): lot size halved due to extreme tick volatility.";

  const sized = lotForRisk({
    riskAmount, stopDistance, valuePerUnitPerLot: unitValue,
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
    ...disclosure,
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
