// Chart Brain v2 — Task 2: trend & regime engine.
//
// Deterministic trend/regime read from the candle window: SMA stack + slope for
// direction, ATR-vs-range for regime (trending / ranging / volatile / quiet).
// Folds in a higher-timeframe bias hint when provided. Honest: too few bars =>
// not populated, scores null.

import type { NormalizedChartCandle } from "../candleNormalization.js";
import { atr, clamp, mean, round, sma, smaAt } from "./chartMath.js";
import type {
  ChartDirection,
  ChartRegime,
  ChartTrendRead,
} from "./marketUnderstandingTypes.js";

const MIN_BARS = 20;

export function computeTrendRegime(
  closed: NormalizedChartCandle[],
  higherTimeframeBias: ChartDirection = "unknown",
): ChartTrendRead {
  const n = closed.length;
  if (n < MIN_BARS) {
    return {
      populated: false,
      direction: "unknown",
      regime: "unknown",
      strength: null,
      slope: null,
      higherTimeframeBias,
      note: `Not enough closed candles (${n}) to read trend.`,
    };
  }

  const closes = closed.map((c) => c.close);
  const last = closes[n - 1]!;
  const sma20 = sma(closes, Math.min(20, n));
  const sma50 = sma(closes, Math.min(50, n));
  const slopeRef = smaAt(closes, Math.min(20, n), Math.max(0, n - 11));
  const slope = sma20 != null && slopeRef != null ? sma20 - slopeRef : 0;

  const hi = Math.max(...closed.map((c) => c.high));
  const lo = Math.min(...closed.map((c) => c.low));
  const span = hi - lo;
  const sep = span > 0 && sma20 != null && sma50 != null ? Math.abs(sma20 - sma50) / span : 0;

  const stackUp = sma20 != null && sma50 != null && last > sma20 && sma20 >= sma50 && slope > 0;
  const stackDown = sma20 != null && sma50 != null && last < sma20 && sma20 <= sma50 && slope < 0;

  let direction: ChartDirection;
  if (stackUp) direction = "bullish";
  else if (stackDown) direction = "bearish";
  else if (sep < 0.06) direction = "ranging";
  else direction = "mixed";

  // Regime from ATR relative to typical bar range and price.
  const atrVal = atr(closed, Math.min(14, n - 1)) ?? 0;
  const avgRange = mean(closed.slice(Math.max(0, n - 20)).map((c) => c.high - c.low));
  const atrPct = last !== 0 ? (atrVal / Math.abs(last)) * 100 : 0;
  const volRatio = avgRange > 0 ? atrVal / avgRange : 1;

  let regime: ChartRegime;
  if (direction === "bullish" || direction === "bearish") {
    regime = atrPct >= 1.5 || volRatio >= 1.4 ? "volatile" : "trending";
  } else if (atrPct >= 1.5 || volRatio >= 1.4) {
    regime = "volatile";
  } else if (atrPct <= 0.4) {
    regime = "quiet";
  } else {
    regime = "ranging";
  }

  // Strength 0-100: separation of MAs scaled by slope conviction.
  const slopeConviction = atrVal > 0 ? clamp((Math.abs(slope) / atrVal) * 40) : 0;
  let strength = clamp(sep * 600 + slopeConviction * 0.5);
  if (direction === "ranging" || direction === "mixed") strength = clamp(strength * 0.4);

  // HTF disagreement softens a directional read.
  const htfDirectional =
    higherTimeframeBias === "bullish" || higherTimeframeBias === "bearish";
  let note = `Direction ${direction}, regime ${regime}.`;
  if (
    htfDirectional &&
    (direction === "bullish" || direction === "bearish") &&
    higherTimeframeBias !== direction
  ) {
    strength = clamp(strength * 0.6);
    note += " Lower- and higher-timeframe bias disagree.";
  }

  return {
    populated: true,
    direction,
    regime,
    strength: round(strength),
    slope: round(slope, 6),
    higherTimeframeBias,
    note,
  };
}
