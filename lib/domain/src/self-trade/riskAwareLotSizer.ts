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
    /** Broker minimum lot is above the broker max / agent cap: no legal lot. */
    | "MIN_LOT_EXCEEDS_CAP"
    | null;
  lot: number;            // 0 when cannotSize
  rawLot: number;         // pre-clamp, pre-rounding
  stopDistance: number;
  riskBudgetUsd: number;
  /** riskBudgetUsd × the (≤1) size multiplier — what withinRiskBudget is judged against. */
  effectiveRiskBudgetUsd: number;
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
    effectiveRiskBudgetUsd: 0,
    actualRiskUsd: 0,
    withinRiskBudget: false,
    clampedBy: null,
  });

  if (input.stopLossPrice == null) return fail("NO_PROTECTIVE_STOP");
  const stopDistance = Math.abs(input.entryPrice - input.stopLossPrice);
  // Non-finite inputs refuse with a structured reason; they never reach the
  // arithmetic (an Infinity budget used to come back as lot=Infinity).
  if (!(Number.isFinite(stopDistance) && stopDistance > EPS)) return fail("NO_STOP_DISTANCE", stopDistance);
  if (!(Number.isFinite(input.valuePerUnitPerLot) && input.valuePerUnitPerLot > EPS)) {
    return fail("NO_CONTRACT_SPEC", stopDistance);
  }
  if (!(Number.isFinite(input.riskBudgetUsd) && input.riskBudgetUsd > EPS)) {
    return fail("NO_RISK_BUDGET", stopDistance);
  }

  // Multipliers only ever REDUCE size. ≤0 / NaN keep the historical defensive
  // default of 1; anything above 1 (incl. Infinity) is capped at 1 so no
  // upstream factor can size past the configured risk budget.
  const mult = input.sizeMultiplier > 0 ? Math.min(input.sizeMultiplier, 1) : 1;
  const effectiveBudgetUsd = input.riskBudgetUsd * mult;
  const riskPerLot = stopDistance * input.valuePerUnitPerLot;
  const rawLot = (input.riskBudgetUsd / riskPerLot) * mult;
  if (!(rawLot > EPS)) {
    return { ...fail("NON_POSITIVE_LOT", stopDistance), rawLot };
  }

  // All lot arithmetic is done in INTEGER step counts and converted back with
  // the step's exact decimal precision. This keeps the result exactly on the
  // broker grid for non-decimal steps (0.25 / 0.5 / 0.05) where the previous
  // `toFixed(round(-log10(step)))` rounded 1.5 → 2 and 0.25 → 0.3.
  const step = input.lotStep > EPS ? input.lotStep : 0.01;
  // step = stepUnits / scale exactly (0.25 → 25/100), so n × stepUnits is an
  // exact integer and dividing by the power-of-ten scale yields the double
  // nearest the decimal lot (0.1 + 0.2 style drift cannot appear).
  const scale = 10 ** stepDecimals(step);
  const stepUnits = Math.round(step * scale);
  const lotOf = (n: number): number => (n * stepUnits) / scale;
  const withinBudget = (n: number): boolean =>
    lotOf(n) * riskPerLot <= effectiveBudgetUsd * (1 + RISK_REL_TOL);

  // Round DOWN to the step (never round up into more risk). The small slack
  // absorbs representation noise such as 0.29 / 0.01 = 28.999999999999996;
  // the budget check below then backs off one step if the slack overshot.
  let n = Math.floor(rawLot / step + 1e-9);
  if (n > 0 && !withinBudget(n)) n -= 1;
  let clampedBy: LotClampReason = lotOf(n) < rawLot - EPS ? "LOT_STEP" : null;

  // Apply the per-trade ceilings (broker max ∧ agent cap).
  const ceiling = Math.min(
    input.maxLot > EPS ? input.maxLot : Number.POSITIVE_INFINITY,
    input.agentMaxLot > EPS ? input.agentMaxLot : Number.POSITIVE_INFINITY,
  );
  const ceilingSteps = Number.isFinite(ceiling)
    ? Math.floor(ceiling / step + 1e-9)
    : Number.POSITIVE_INFINITY;
  if (n > ceilingSteps) {
    n = ceilingSteps;
    clampedBy =
      input.agentMaxLot > EPS && input.agentMaxLot <= (input.maxLot || Infinity)
        ? "AGENT_CAP"
        : "MAX_LOT";
  }

  // Enforce the broker minimum. Honouring it may exceed the risk budget — we
  // surface that honestly (withinRiskBudget=false) rather than silently
  // over-risking. If the minimum is ABOVE the broker max / agent cap there is
  // no legal lot at all: refuse instead of upsizing past the cap.
  const minLot = input.minLot > EPS ? input.minLot : step;
  const minSteps = Math.max(1, Math.ceil(minLot / step - 1e-9));
  if (n < minSteps) {
    if (minSteps > ceilingSteps) {
      return { ...fail("MIN_LOT_EXCEEDS_CAP", stopDistance), rawLot, effectiveRiskBudgetUsd: effectiveBudgetUsd };
    }
    n = minSteps;
    clampedBy = "MIN_LOT";
  }

  const lotRounded = lotOf(n);
  if (!(Number.isFinite(lotRounded) && lotRounded > EPS)) {
    return { ...fail("NON_POSITIVE_LOT", stopDistance), rawLot };
  }
  const actualRiskUsd = lotRounded * riskPerLot;
  // Judged against the multiplier-REDUCED budget: a min-lot clamp that only
  // fits the unreduced budget would silently undo a PROTECT/RECOVERY cut.
  const withinRiskBudget = withinBudget(n);

  return {
    cannotSize: false,
    reasonCode: null,
    lot: lotRounded,
    rawLot,
    stopDistance,
    riskBudgetUsd: input.riskBudgetUsd,
    effectiveRiskBudgetUsd: effectiveBudgetUsd,
    actualRiskUsd,
    withinRiskBudget,
    clampedBy,
  };
}

/** Relative tolerance for risk comparisons (input price representation noise). */
const RISK_REL_TOL = 1e-9;

/** Decimal places needed to write `step` exactly: 0.01 → 2, 0.25 → 2, 0.5 → 1, 2 → 0. */
function stepDecimals(step: number): number {
  for (let d = 0; d <= 10; d++) {
    const scaled = step * 10 ** d;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9 * Math.max(1, scaled)) return d;
  }
  return 10;
}
