import { favoredScenario } from "./learning.js";
import type { StructuralBar, Triple } from "./contracts.js";

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

/** Frozen paper hypothesis. The later executable quote sets the actual entry. */
export function forecastPaperInstruction(
  bars: StructuralBar[],
  odds?: Triple,
): ForecastPaperInstruction {
  const hold = (reason: string): ForecastPaperInstruction => ({
    action: "HOLD",
    reason,
  });
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
