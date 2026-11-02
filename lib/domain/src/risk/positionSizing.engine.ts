// The one position-sizing formula (Tier 1 Risk Governor: one sizer).
//
//   lot = risk budget / (stop distance × money per 1.0 price unit per 1.0 lot)
//
// snapped to the broker volume step without enlarging the risk budget. A
// minimum volume that cannot fit the budget returns no size. Every
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
  /** Preferred rounding; even "nearest" may never enlarge the risk budget. */
  rounding?: "floor" | "nearest";
}

export interface LotForRiskResult {
  rawLot: number;              // unrounded, unclamped (0 when inputs are invalid)
  lot: number;                 // stepped within budget and bounds (0 when unavailable)
  clampedToMin: boolean;
  clampedToMax: boolean;
  invalid: string | null;      // why no lot could be computed
}

function decimalsOf(step: number): number {
  const s = String(step);
  const [coefficient, exponent = "0"] = s.split("e");
  return Math.max(0, (coefficient.split(".")[1] || "").length - Number(exponent));
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
  const step = input.lotStep ?? 0.01;
  if (!(Number.isFinite(minLot) && minLot > 0 && Number.isFinite(maxLot) && maxLot >= minLot)) return bad("broker volume bounds are invalid");
  if (!(Number.isFinite(step) && step > 0 && decimalsOf(step) <= 15)) return bad("broker volume step is invalid or unsupported");
  const costPerLot = input.stopDistance * input.valuePerUnitPerLot;
  if (!(Number.isFinite(costPerLot) && costPerLot > 0)) return bad("risk per lot is zero or invalid");
  const rawLot = input.riskAmount / costPerLot;
  if (!(Number.isFinite(rawLot) && rawLot > 0)) return bad("computed lot is zero or invalid");
  const unavailable = (invalid: string): LotForRiskResult => ({ ...bad(invalid), rawLot });
  // Relative roundoff only (e.g. subtracting 1.095 from 1.1); never a volume-step allowance.
  // Compare the difference to avoid overflowing an enlarged budget to Infinity.
  const exceedsBudget = (lot: number) => {
    const loss = lot * costPerLot;
    return !Number.isFinite(loss) || (loss > input.riskAmount && (loss - input.riskAmount) / input.riskAmount > 1e-12);
  };
  if (exceedsBudget(minLot)) return unavailable("minimum lot exceeds risk budget");
  // Step indices beyond safe integer precision cannot establish a valid volume.
  if (Math.min(rawLot, maxLot) / step > Number.MAX_SAFE_INTEGER) return unavailable("volume step precision is insufficient");
  let c = clampLotToStep(rawLot, step, minLot, maxLot, input.rounding ?? "floor");
  if (exceedsBudget(c.lot)) c = clampLotToStep(rawLot, step, minLot, maxLot, "floor");
  const units = c.lot / step;
  if (!(Number.isFinite(c.lot) && c.lot > 0 && c.lot >= minLot && c.lot <= maxLot)
      || Math.abs(units - Math.round(units)) > 8 * Number.EPSILON * Math.max(1, Math.abs(units))
      || exceedsBudget(c.lot)) return unavailable("no valid broker volume fits the risk budget and bounds");
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
  riskAmount: number;          // supplied risk budget, not a guarantee of actual loss
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

  for (const [name, value] of Object.entries({ accountBalance, riskPct, stopLossDistance, pipSize, pipValuePerLot })) {
    if (!(Number.isFinite(value) && value > 0)) return zero([`${name} must be finite and positive`]);
  }

  const riskAmount = accountBalance * (riskPct / 100);
  const stopLossPips = stopLossDistance / pipSize;
  // Money per 1.0 price unit per lot = pip value / pip size.
  const sized = lotForRisk({
    riskAmount, stopDistance: stopLossDistance, valuePerUnitPerLot: pipValuePerLot / pipSize, minLot, maxLot, lotStep,
  });
  if (sized.invalid) return zero([sized.invalid]);
  if (!Number.isFinite(stopLossPips)) return zero(["stop loss pips are invalid"]);
  const { rawLot, lot } = sized;
  if (rawLot < minLot)         notes.push(`Computed lot ${rawLot.toFixed(4)} below broker min ${minLot}`);
  if (rawLot > maxLot)         notes.push(`Computed lot ${rawLot.toFixed(2)} above broker max ${maxLot}`);

  return {
    recommendedLot: lot,
    riskAmount,
    stopLossPips,
    notes,
  };
}

function zero(notes: string[]): PositionSizeResult {
  return { recommendedLot: 0, riskAmount: 0, stopLossPips: 0, notes };
}
