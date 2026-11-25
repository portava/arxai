import { favoredScenario } from "./learning.js";
import type { StructuralBar, StructuralForecast, Triple } from "./contracts.js";

export type ForecastPaperInstruction =
  | { action: "HOLD"; reason: string }
  | {
      action: "BUY" | "SELL";
      reference: number;
      stop: number;
      target: number;
      entryLimit?: number;
      breakoutLevel?: number;
      reason: string;
    };

/** The forecast facts that decide whether its odds may issue a paper order. */
export type PaperForecastBasis = Pick<StructuralForecast, "mode" | "gateReason">;

function baselineHoldReason(gateReason: string): string {
  if (gateReason === "PERFORMANCE_QUARANTINE")
    return "This window is quarantined after weak recent scores, so no paper order is issued.";
  if (gateReason === "OUT_OF_DISTRIBUTION")
    return "Current conditions are outside the model's training range, so no paper order is issued.";
  return "No first-break model has passed its independent test here, so no paper order is issued.";
}

/** Frozen paper hypothesis. The later executable quote sets the actual entry. */
export function forecastPaperInstruction(
  bars: StructuralBar[],
  odds: Triple | undefined,
  basis: PaperForecastBasis,
): ForecastPaperInstruction {
  const hold = (reason: string): ForecastPaperInstruction => ({
    action: "HOLD",
    reason,
  });
  // A BASELINE forecast has no first-break model in use (rejected, untested,
  // quarantined or out of range), so its leader is the historical favourite,
  // not a tested direction. Replayed with this code on 75 real Deriv series
  // (2026-11-25), 5,431 such paper orders averaged -0.058R before costs and
  // -0.297R after the measured MT5 spread. None is issued.
  if (basis.mode === "BASELINE") return hold(baselineHoldReason(basis.gateReason));
  if (
    !odds ||
    !odds.every((p) => Number.isFinite(p) && p >= 0 && p <= 1) ||
    Math.abs(odds.reduce((a, b) => a + b, 0) - 1) > 1e-6
  )
    return hold("First-break odds unavailable.");
  const recent = bars.slice(-15);
  if (
    recent.length !== 15 ||
    recent.some(
      (b, i) =>
        !b.isFinal ||
        ![b.high, b.low, b.close].every((n) => Number.isFinite(n) && n > 0) ||
        (i > 0 && b.openTime !== recent[i - 1]!.closeTime),
    )
  )
    return hold("Waiting for 15 consecutive closed candles.");
  const leader = favoredScenario(odds);
  if (!leader || leader === "NEITHER")
    return hold("No single direction leads the first-break forecast.");
  const last = recent[14]!,
    prev = recent[13]!,
    buy = leader === "UP_FIRST",
    sign = buy ? 1 : -1;
  if (buy ? last.close <= prev.high : last.close >= prev.low)
    return hold(
      buy
        ? "A close above the previous high is required."
        : "A close below the previous low is required.",
    );
  const atr =
    recent
      .slice(1)
      .reduce(
        (sum, b, i) =>
          sum +
          Math.max(
            b.high - b.low,
            Math.abs(b.high - recent[i]!.close),
            Math.abs(b.low - recent[i]!.close),
          ),
        0,
      ) / 14;
  const stop = last.close - sign * atr,
    target = last.close + sign * 1.5 * atr;
  if (!(atr > 0 && stop > 0 && target > 0))
    return hold("No valid volatility bracket.");
  return {
    action: buy ? "BUY" : "SELL",
    reference: last.close,
    stop,
    target,
    entryLimit: (stop + target) / 2,
    breakoutLevel: buy ? prev.high : prev.low,
    reason: "The first-break leader agrees with a closed-candle breakout.",
  };
}

/** Evaluate the first later executable quote for the issued paper ticket. */
export function executableForecastPaperOrder(
  plan: ForecastPaperInstruction,
  bid: number,
  ask: number,
): boolean {
  if (
    plan.action === "HOLD" ||
    !Number.isFinite(bid) ||
    !Number.isFinite(ask) ||
    !(bid > 0 && ask >= bid)
  )
    return false;
  return plan.action === "BUY"
    ? (plan.breakoutLevel == null || bid > plan.breakoutLevel) &&
        bid > plan.stop &&
        ask < plan.target &&
        (plan.entryLimit == null || ask <= plan.entryLimit)
    : (plan.breakoutLevel == null || ask < plan.breakoutLevel) &&
        ask < plan.stop &&
        bid > plan.target &&
        (plan.entryLimit == null || bid >= plan.entryLimit);
}

export interface ForecastPaperGrade {
  state: "PENDING" | "SKIPPED" | "OPEN" | "TARGET" | "STOP" | "UNVERIFIED";
  entry?: number;
  exit?: number;
  observedAt?: number;
}

export function settledPaperGrade(grade: ForecastPaperGrade): boolean {
  return grade.state === "TARGET" || grade.state === "STOP" || grade.state === "SKIPPED";
}
