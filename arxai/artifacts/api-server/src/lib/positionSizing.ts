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

export function calculatePositionSize(input: PositionSizeInput): PositionSizeResult {
  const { accountBalance, riskPercent, entry, stopLoss, symbol, maxLotSize = 10 } = input;

  const riskAmount = accountBalance * (riskPercent / 100);
  const stopDistance = Math.abs(entry - stopLoss);

  let warning: string | null = null;

  if (stopDistance === 0) {
    return {
      riskAmount: Math.round(riskAmount * 100) / 100,
      stopDistance: 0,
      suggestedLot: 0,
      maxLotAllowed: maxLotSize,
      finalLot: 0,
      warning: "Stop loss distance is zero — cannot calculate lot size.",
    };
  }

  let suggestedLot: number;

  if (isSynthetic(symbol)) {
    // Synthetic indices: lot = riskAmount / stopDistance
    // Each lot = $1 per point movement on Deriv synthetics
    suggestedLot = riskAmount / stopDistance;
  } else if (isForex(symbol)) {
    // Forex standard: 1 lot = 100,000 units; pip = 0.0001; pip value ≈ $10/lot
    const pipValue = 10;
    const pipSize = symbol.includes("JPY") ? 0.01 : 0.0001;
    const stopInPips = stopDistance / pipSize;
    suggestedLot = riskAmount / (stopInPips * pipValue);
  } else {
    // Indices / stocks: treat as synthetic-style dollar-per-point
    suggestedLot = riskAmount / stopDistance;
  }

  // V75 1s requires smaller lot (50% reduction)
  const isV75_1s = symbol.includes("(1s)") || symbol.toLowerCase().includes("1s");
  if (isV75_1s) {
    suggestedLot *= 0.5;
    warning = "V75 (1s): lot size halved due to extreme tick volatility.";
  }

  // Round to 2 decimal places
  suggestedLot = Math.round(suggestedLot * 100) / 100;

  // Clamp to minimum
  if (suggestedLot < 0.01) {
    suggestedLot = 0.01;
    warning = (warning ? warning + " " : "") + "Lot clamped to minimum 0.01.";
  }

  const finalLot = Math.round(Math.min(suggestedLot, maxLotSize) * 100) / 100;

  if (finalLot < suggestedLot) {
    warning = (warning ? warning + " " : "") + `Lot capped at max allowed (${maxLotSize}).`;
  }

  return {
    riskAmount: Math.round(riskAmount * 100) / 100,
    stopDistance: Math.round(stopDistance * 10000) / 10000,
    suggestedLot,
    maxLotAllowed: maxLotSize,
    finalLot,
    warning: warning?.trim() ?? null,
  };
}
