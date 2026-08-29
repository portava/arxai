// Pure helpers for drag-to-modify SL/TP on the ARX charts (Task #764).
//
// No React, no DOM, no network — just the math + validation the chart drag UI
// needs to (a) show a candidate SL/TP price, point/pip distance, and risk/reward
// live during a drag, and (b) decide whether a candidate modify may be submitted
// (side rules + broker minimum stop distance). Kept in a sibling module (not the
// component) so it is unit-testable and Vite fast-refresh stays clean — the same
// convention as scannerChartFormat.ts / structureLines.ts.
//
// HONESTY: these are display/decision-support helpers only. They never place,
// dispatch, or gate a trade — the backend 23-gate dispatch remains the single
// authority. A returned `reason` is always a plain-English phrase, never a raw
// gate code.

export type TradeSide = "BUY" | "SELL";

// Display decimal places by symbol family. JPY pairs use 3, most FX majors use
// 5. DISPLAY/granularity only — never a price source.
export function inferDecimals(symbol: string | null | undefined): number {
  const s = (symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!s) return 5;
  if (s.includes("JPY")) return 3;
  return 5;
}

// Conventional 1-pip increment for a symbol. With decimals d, a pip is the
// second-to-last place (10^-(d-1)) — FX majors 0.0001, JPY pairs 0.01. This is a
// conventional display unit for the "distance in points/pips" readout, not an
// execution constant.
export function pipSize(symbol: string | null | undefined): number {
  const d = inferDecimals(symbol);
  return Math.pow(10, -(d - 1));
}

// One price point (smallest quoted increment) for a symbol — 10^-decimals.
export function pointSize(symbol: string | null | undefined): number {
  return Math.pow(10, -inferDecimals(symbol));
}

// Absolute distance between two prices expressed in pips (>= 0). null when
// either input is not a finite, positive price.
export function pipDistance(
  symbol: string | null | undefined,
  a: number | null | undefined,
  b: number | null | undefined,
): number | null {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a <= 0 || b <= 0) return null;
  const pip = pipSize(symbol);
  if (!(pip > 0)) return null;
  return Math.abs(a - b) / pip;
}

// Risk/reward ratio (reward / risk) for a setup. Returns a positive number, or
// null when it can't be computed honestly: a missing leg, zero risk, or a leg on
// the WRONG side of entry (e.g. a BUY whose SL is above entry is not real risk).
export function computeRiskReward(args: {
  side: TradeSide;
  entry: number | null | undefined;
  stopLoss: number | null | undefined;
  takeProfit: number | null | undefined;
}): number | null {
  const { side, entry, stopLoss, takeProfit } = args;
  if (
    entry == null || stopLoss == null || takeProfit == null ||
    !Number.isFinite(entry) || !Number.isFinite(stopLoss) || !Number.isFinite(takeProfit)
  ) {
    return null;
  }
  const slRight = side === "BUY" ? stopLoss < entry : stopLoss > entry;
  const tpRight = side === "BUY" ? takeProfit > entry : takeProfit < entry;
  if (!slRight || !tpRight) return null;
  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);
  if (!(risk > 0)) return null;
  return reward / risk;
}

export type ModifyValidation = { ok: boolean; reason: string | null };

// Validate a candidate SL/TP for a drag-modify before allowing a submit. Checks
// side rules and (when provided) the broker minimum stop distance. Either leg may
// be null (leaving that leg unchanged), but at least one leg must be a finite,
// positive price. `reason` is a humanized phrase when ok is false.
export function validateModifyLevels(args: {
  side: TradeSide;
  entry: number | null | undefined;
  newStopLoss: number | null | undefined;
  newTakeProfit: number | null | undefined;
  // Smallest allowed |price - entry| in PRICE units (broker stops level). When
  // omitted, the distance check is skipped — never fabricated.
  minStopDistance?: number | null;
}): ModifyValidation {
  const { side, entry, newStopLoss, newTakeProfit, minStopDistance } = args;

  if (entry == null || !Number.isFinite(entry) || entry <= 0) {
    return { ok: false, reason: "Entry price is unavailable, so the new level can't be checked." };
  }

  const hasSl = newStopLoss != null && Number.isFinite(newStopLoss) && newStopLoss > 0;
  const hasTp = newTakeProfit != null && Number.isFinite(newTakeProfit) && newTakeProfit > 0;
  if (!hasSl && !hasTp) {
    return { ok: false, reason: "Move the Stop Loss or Take Profit line to a valid price first." };
  }

  if (hasSl) {
    const slRight = side === "BUY" ? newStopLoss! < entry : newStopLoss! > entry;
    if (!slRight) {
      return {
        ok: false,
        reason: side === "BUY"
          ? "Stop Loss must sit below entry for a Buy."
          : "Stop Loss must sit above entry for a Sell.",
      };
    }
  }

  if (hasTp) {
    const tpRight = side === "BUY" ? newTakeProfit! > entry : newTakeProfit! < entry;
    if (!tpRight) {
      return {
        ok: false,
        reason: side === "BUY"
          ? "Take Profit must sit above entry for a Buy."
          : "Take Profit must sit below entry for a Sell.",
      };
    }
  }

  if (minStopDistance != null && Number.isFinite(minStopDistance) && minStopDistance > 0) {
    if (hasSl && Math.abs(entry - newStopLoss!) < minStopDistance) {
      return { ok: false, reason: "Stop Loss is too close to price for the broker's minimum stop distance." };
    }
    if (hasTp && Math.abs(entry - newTakeProfit!) < minStopDistance) {
      return { ok: false, reason: "Take Profit is too close to price for the broker's minimum stop distance." };
    }
  }

  return { ok: true, reason: null };
}
