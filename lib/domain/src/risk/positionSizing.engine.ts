// The one position-sizing formula (Tier 1 Risk Governor: one sizer).
//
//   lot = risk budget / (stop distance × money per 1.0 price unit per 1.0 lot)
//
// snapped to the broker volume step and clamped to [minLot, maxLot]. Every
// sizer in ARX (the instrument-class calculator, paper execution, the scalp
// engine, the pipeline approve stage) supplies its own value model and calls
// this; none keeps its own formula.

export interface LotForRiskInput {
  riskAmount: number;          // currency the trade may lose at its stop
  stopDistance: number;        // price units from entry to stop
  valuePerUnitPerLot: number;  // currency per 1.0 price move per 1.0 lot
  minLot?: number;
  maxLot?: number;
  lotStep?: number;
  /** "floor" (risk-conservative, default) or "nearest" step rounding. */
  rounding?: "floor" | "nearest";
}

export interface LotForRiskResult {
  rawLot: number;              // unrounded, unclamped (0 when inputs are invalid)
  lot: number;                 // stepped and clamped (0 when inputs are invalid)
  clampedToMin: boolean;
  clampedToMax: boolean;
  invalid: string | null;      // why no lot could be computed
}

function decimalsOf(step: number): number {
  const s = String(step);
  if (s.includes("e-")) { const m = /e-(\d+)/.exec(s); return m ? Number(m[1]) : 8; }
  return (s.split(".")[1] || "").length;
}

/** Snap `raw` to the volume step, then clamp to [min, max]. */
export function clampLotToStep(raw: number, step: number, min: number, max: number, rounding: "floor" | "nearest" = "floor"): { lot: number; clampedToMin: boolean; clampedToMax: boolean } {
  const safeStep = step > 0 ? step : 0.01;
  const dec = decimalsOf(safeStep);
  const snap = rounding === "nearest" ? Math.round : Math.floor;
  // Bias by a tiny epsilon so 0.29999999 / 0.01 floors to 29, not 28.
  let lot = Number((snap(raw / safeStep + (rounding === "floor" ? 1e-9 : 0)) * safeStep).toFixed(dec));
  let clampedToMin = false;
  let clampedToMax = false;
  if (lot < min) { lot = min; clampedToMin = true; }
  if (lot > max) {
    lot = Number((Math.floor(max / safeStep + 1e-9) * safeStep).toFixed(dec));
    if (lot > max) lot = max;
    clampedToMax = true;
  }
  return { lot: Number(lot.toFixed(dec)), clampedToMin, clampedToMax };
}

export function lotForRisk(input: LotForRiskInput): LotForRiskResult {
  const minLot = input.minLot ?? 0.01;
  const maxLot = input.maxLot ?? 100;
  const bad = (invalid: string): LotForRiskResult => ({ rawLot: 0, lot: 0, clampedToMin: false, clampedToMax: false, invalid });
  if (!(Number.isFinite(input.riskAmount) && input.riskAmount > 0)) return bad("risk amount is zero or invalid");
  if (!(Number.isFinite(input.stopDistance) && input.stopDistance > 0)) return bad("stop distance is zero or invalid");
  if (!(Number.isFinite(input.valuePerUnitPerLot) && input.valuePerUnitPerLot > 0)) return bad("value per unit per lot is zero or invalid");
  const rawLot = input.riskAmount / (input.stopDistance * input.valuePerUnitPerLot);
  const c = clampLotToStep(rawLot, input.lotStep ?? 0.01, minLot, maxLot, input.rounding ?? "floor");
  return { rawLot, lot: c.lot, clampedToMin: c.clampedToMin, clampedToMax: c.clampedToMax, invalid: null };
}

export interface PositionSizeInput {
  accountBalance: number;
  riskPct: number;             // % of balance to risk on this trade
  stopLossDistance: number;    // price units from entry to SL
  pipSize: number;             // price units per pip (e.g. 0.0001 EURUSD)
  pipValuePerLot: number;      // currency per pip per 1.0 lot
  minLot?: number;
  maxLot?: number;
  lotStep?: number;
}

export interface PositionSizeResult {
  recommendedLot: number;
  riskAmount: number;          // currency that will be risked
  stopLossPips: number;
  notes: string[];
}

// Pure position sizing. Returns 0 lots when inputs are invalid rather than
// throwing, with a note explaining why.
export function calcLotSize(input: PositionSizeInput): PositionSizeResult {
  const { accountBalance, riskPct, stopLossDistance, pipSize, pipValuePerLot } = input;
  const minLot = input.minLot ?? 0.01;
  const maxLot = input.maxLot ?? 100;
  const lotStep = input.lotStep ?? 0.01;
  const notes: string[] = [];

  if (accountBalance <= 0)    { notes.push("Account balance ≤ 0"); return zero(notes); }
  if (riskPct <= 0)           { notes.push("Risk % ≤ 0");          return zero(notes); }
  if (stopLossDistance <= 0)  { notes.push("Stop loss distance ≤ 0"); return zero(notes); }
  if (pipSize <= 0)           { notes.push("pipSize must be > 0"); return zero(notes); }
  if (pipValuePerLot <= 0)    { notes.push("pipValuePerLot must be > 0"); return zero(notes); }

  const riskAmount = accountBalance * (riskPct / 100);
  const stopLossPips = stopLossDistance / pipSize;
  // Money per 1.0 price unit per lot = pip value / pip size.
  const { rawLot, lot } = lotForRisk({
    riskAmount, stopDistance: stopLossDistance, valuePerUnitPerLot: pipValuePerLot / pipSize, minLot, maxLot, lotStep,
  });
  if (rawLot < minLot)         notes.push(`Computed lot ${rawLot.toFixed(4)} below broker min ${minLot}`);
  if (rawLot > maxLot)         notes.push(`Computed lot ${rawLot.toFixed(2)} above broker max ${maxLot}`);

  return {
    recommendedLot: Number(lot.toFixed(2)),
    riskAmount: Number(riskAmount.toFixed(2)),
    stopLossPips: Number(stopLossPips.toFixed(1)),
    notes,
  };
}

function zero(notes: string[]): PositionSizeResult {
  return { recommendedLot: 0, riskAmount: 0, stopLossPips: 0, notes };
}
