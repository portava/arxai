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
  const rawLot = riskAmount / (stopLossPips * pipValuePerLot);

  // Snap to lotStep, clamp to broker bounds.
  const stepped = Math.floor(rawLot / lotStep) * lotStep;
  const clamped = Math.max(minLot, Math.min(maxLot, stepped));
  if (rawLot < minLot)         notes.push(`Computed lot ${rawLot.toFixed(4)} below broker min ${minLot}`);
  if (rawLot > maxLot)         notes.push(`Computed lot ${rawLot.toFixed(2)} above broker max ${maxLot}`);

  return {
    recommendedLot: Number(clamped.toFixed(2)),
    riskAmount: Number(riskAmount.toFixed(2)),
    stopLossPips: Number(stopLossPips.toFixed(1)),
    notes,
  };
}

function zero(notes: string[]): PositionSizeResult {
  return { recommendedLot: 0, riskAmount: 0, stopLossPips: 0, notes };
}
