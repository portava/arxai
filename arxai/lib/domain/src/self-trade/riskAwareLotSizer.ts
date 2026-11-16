// Self-Trade AI — risk-aware lot sizing (Autonomous Live Execution, Task #213).
// PURE / deterministic. Converts a risk budget + a real protective stop into a
// broker-legal lot size.
//
// HONESTY CONTRACT:
// - No protective stop (or zero/negative stop distance) ⇒ CANNOT size. We never
//   guess a stop and never size a stop-less position. Phase B gate #16 also
//   requires a stop; this refuses earlier and honestly.
// - No contract spec / no risk budget ⇒ CANNOT size. Never fabricate a lot.
// - The final lot is the broker-legal value; `withinRiskBudget` tells the caller
//   whether honouring the broker minimum would exceed the configured risk. The
//   caller decides whether to proceed — this module never silently over-risks.

import type { TradeSide } from "./selfTradeDecision.types.js";

export interface RiskAwareLotInput {
  side: TradeSide;
  entryPrice: number;
  stopLossPrice: number | null;

  /** Risk budget for this trade, in account currency (USD). */
  riskBudgetUsd: number;

  /**
   * USD P/L change per 1.0 lot per 1.0 unit of price movement for this symbol.
   * (e.g. for a standard FX lot of 100,000 units this is 100,000 × quote-conv.)
   * Supplied by the api-server from real contract specs; never assumed here.
   */
  valuePerUnitPerLot: number;

  /** Broker lot constraints. */
  minLot: number;
  maxLot: number;
  lotStep: number;

  /** Agent per-trade lot cap (self_trade_agent_settings.maxLotPerTrade). */
  agentMaxLot: number;

  /** Multiplier from quota pressure / APPROVED_REDUCED (default 1). */
  sizeMultiplier: number;
}

export type LotClampReason =
  | "MIN_LOT"
  | "MAX_LOT"
  | "AGENT_CAP"
  | "LOT_STEP"
  | null;

export interface RiskAwareLotResult {
  cannotSize: boolean;
  reasonCode:
    | "NO_PROTECTIVE_STOP"
    | "NO_STOP_DISTANCE"
    | "NO_CONTRACT_SPEC"
    | "NO_RISK_BUDGET"
    | "NON_POSITIVE_LOT"
    | null;
  lot: number;            // 0 when cannotSize
  rawLot: number;         // pre-clamp, pre-rounding
  stopDistance: number;
  riskBudgetUsd: number;
  actualRiskUsd: number;  // risk at the final lot
  withinRiskBudget: boolean;
  clampedBy: LotClampReason;
}

const EPS = 1e-9;

export function computeRiskAwareLot(input: RiskAwareLotInput): RiskAwareLotResult {
  const fail = (
    reasonCode: NonNullable<RiskAwareLotResult["reasonCode"]>,
    stopDistance = 0,
  ): RiskAwareLotResult => ({
    cannotSize: true,
    reasonCode,
    lot: 0,
    rawLot: 0,
    stopDistance,
    riskBudgetUsd: input.riskBudgetUsd,
    actualRiskUsd: 0,
    withinRiskBudget: false,
    clampedBy: null,
  });

  if (input.stopLossPrice == null) return fail("NO_PROTECTIVE_STOP");
  const stopDistance = Math.abs(input.entryPrice - input.stopLossPrice);
  if (!(stopDistance > EPS)) return fail("NO_STOP_DISTANCE", stopDistance);
  if (!(input.valuePerUnitPerLot > EPS)) return fail("NO_CONTRACT_SPEC", stopDistance);
  if (!(input.riskBudgetUsd > EPS)) return fail("NO_RISK_BUDGET", stopDistance);

  const mult = input.sizeMultiplier > 0 ? input.sizeMultiplier : 1;
  const riskPerLot = stopDistance * input.valuePerUnitPerLot;
  const rawLot = (input.riskBudgetUsd / riskPerLot) * mult;
  if (!(rawLot > EPS)) {
    return { ...fail("NON_POSITIVE_LOT", stopDistance), rawLot };
  }

  // Round DOWN to the lot step (never round up into more risk).
  const step = input.lotStep > EPS ? input.lotStep : 0.01;
  let lot = Math.floor((rawLot + EPS) / step) * step;
  let clampedBy: LotClampReason = lot < rawLot - EPS ? "LOT_STEP" : null;

  // Apply the per-trade ceilings (broker max ∧ agent cap).
  const ceiling = Math.min(
    input.maxLot > EPS ? input.maxLot : Number.POSITIVE_INFINITY,
    input.agentMaxLot > EPS ? input.agentMaxLot : Number.POSITIVE_INFINITY,
  );
  if (Number.isFinite(ceiling) && lot > ceiling + EPS) {
    lot = Math.floor((ceiling + EPS) / step) * step;
    clampedBy =
      input.agentMaxLot > EPS && input.agentMaxLot <= (input.maxLot || Infinity)
        ? "AGENT_CAP"
        : "MAX_LOT";
  }

  // Enforce the broker minimum. Honouring it may exceed the risk budget — we
  // surface that honestly rather than silently over-risking.
  const minLot = input.minLot > EPS ? input.minLot : step;
  let withinRiskBudget = true;
  if (lot < minLot - EPS) {
    lot = minLot;
    clampedBy = "MIN_LOT";
  }

  const lotRounded = roundToStep(lot, step);
  const actualRiskUsd = lotRounded * riskPerLot;
  withinRiskBudget = actualRiskUsd <= input.riskBudgetUsd + EPS;

  if (!(lotRounded > EPS)) {
    return { ...fail("NON_POSITIVE_LOT", stopDistance), rawLot };
  }

  return {
    cannotSize: false,
    reasonCode: null,
    lot: lotRounded,
    rawLot,
    stopDistance,
    riskBudgetUsd: input.riskBudgetUsd,
    actualRiskUsd,
    withinRiskBudget,
    clampedBy,
  };
}

function roundToStep(value: number, step: number): number {
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  return Number(value.toFixed(decimals));
}
