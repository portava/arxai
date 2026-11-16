// Chart Brain v2 — Task 2, Engine 3: candle intent & pressure.
//
// Deterministic wick/body/sequence analysis. For the most recent closed bars we
// assign an intent label (pushing / rejecting / trapping / exhausting /
// absorbing / continuing / breaking_structure / failing_to_break / noise) plus
// buyer / seller / rejection / exhaustion / continuation / trap / importance
// scores. Honest: with too few bars `populated` is false and nothing is faked.

import type { NormalizedChartCandle } from "../candleNormalization.js";
import { atr, clamp, mean, round } from "./chartMath.js";
import type {
  ChartCandleIntentRead,
  ChartCandleSignal,
  ChartPressure,
} from "./marketUnderstandingTypes.js";

const MIN_BARS = 6;
// How many of the most recent closed bars get a per-candle signal.
const SIGNAL_BARS = 5;

interface BarParts {
  range: number;
  body: number;
  upperWick: number;
  lowerWick: number;
  bullish: boolean;
  bearish: boolean;
}

function parts(c: NormalizedChartCandle): BarParts {
  const range = c.high - c.low;
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  return {
    range,
    body,
    upperWick: Math.max(0, upperWick),
    lowerWick: Math.max(0, lowerWick),
    bullish: c.close > c.open,
    bearish: c.close < c.open,
  };
}

function analyzeBar(
  closed: NormalizedChartCandle[],
  i: number,
  avgRange: number,
  atrVal: number,
  recentHigh: number,
  recentLow: number,
): ChartCandleSignal {
  const c = closed[i]!;
  const p = parts(c);
  const prev = i > 0 ? closed[i - 1]! : null;

  const ref = p.range > 0 ? p.range : 1;
  const bodyFrac = p.body / ref; // 0..1
  const upperFrac = p.upperWick / ref;
  const lowerFrac = p.lowerWick / ref;
  const sizeVsAvg = avgRange > 0 ? p.range / avgRange : 1;

  // Pressure scores from where the close sits + which wick dominates.
  let buyerScore = 0;
  let sellerScore = 0;
  if (p.bullish) buyerScore += bodyFrac * 60;
  if (p.bearish) sellerScore += bodyFrac * 60;
  buyerScore += lowerFrac * 40; // long lower wick = buyers defended
  sellerScore += upperFrac * 40; // long upper wick = sellers defended

  // Rejection: a dominant wick against a small body.
  const dominantWick = Math.max(upperFrac, lowerFrac);
  const rejectionScore = clamp(dominantWick * 100 * (1 - bodyFrac));

  // Exhaustion: large range vs ATR but small body (a blow-off / climax bar).
  const atrRatio = atrVal > 0 ? p.range / atrVal : 1;
  const exhaustionScore = clamp((atrRatio - 1) * 50 * (1 - bodyFrac));

  // Continuation: strong body in the prior bar's direction.
  let continuationScore = 0;
  if (prev) {
    const pp = parts(prev);
    const sameDir =
      (p.bullish && pp.bullish) || (p.bearish && pp.bearish);
    if (sameDir) continuationScore = clamp(bodyFrac * 100);
  }

  // Trap: pierced the recent extreme then closed back inside (failed break).
  let trapScore = 0;
  const pierceHigh = c.high > recentHigh && c.close < recentHigh;
  const pierceLow = c.low < recentLow && c.close > recentLow;
  if (pierceHigh || pierceLow) {
    trapScore = clamp(40 + dominantWick * 60);
  }

  // Importance: bigger-than-average, decisive, or a trap/rejection bar matters.
  const importanceScore = clamp(
    Math.max(
      (sizeVsAvg - 1) * 50,
      bodyFrac * 60,
      trapScore * 0.8,
      rejectionScore * 0.7,
    ),
  );

  // Label resolution — most specific wins.
  let intent: ChartCandleSignal["intent"];
  if (importanceScore < 25) {
    intent = "noise";
  } else if (trapScore >= 55) {
    intent = "trapping";
  } else if (pierceHigh && p.bullish && p.body / ref < 0.5) {
    intent = "failing_to_break";
  } else if (
    (c.high > recentHigh && p.bullish && bodyFrac >= 0.5) ||
    (c.low < recentLow && p.bearish && bodyFrac >= 0.5)
  ) {
    intent = "breaking_structure";
  } else if (exhaustionScore >= 50) {
    intent = "exhausting";
  } else if (rejectionScore >= 55) {
    intent = "rejecting";
  } else if (sizeVsAvg < 0.7 && dominantWick < 0.4) {
    intent = "absorbing";
  } else if (continuationScore >= 55) {
    intent = "continuing";
  } else if (bodyFrac >= 0.55) {
    intent = "pushing";
  } else {
    intent = "noise";
  }

  return {
    offsetFromLatest: closed.length - 1 - i,
    intent,
    buyerScore: round(clamp(buyerScore)),
    sellerScore: round(clamp(sellerScore)),
    rejectionScore: round(rejectionScore),
    exhaustionScore: round(exhaustionScore),
    continuationScore: round(continuationScore),
    trapScore: round(trapScore),
    importanceScore: round(importanceScore),
  };
}

export function computeCandleIntent(
  closed: NormalizedChartCandle[],
): ChartCandleIntentRead {
  const n = closed.length;
  if (n < MIN_BARS) {
    return {
      populated: false,
      latestIntent: "noise",
      dominantPressure: "unknown",
      signals: [],
      note: `Not enough closed candles (${n}) to read candle intent.`,
    };
  }

  const recentWin = closed.slice(Math.max(0, n - 20));
  const avgRange = mean(recentWin.map((c) => c.high - c.low));
  const atrVal = atr(closed, Math.min(14, n - 1)) ?? avgRange;

  const signals: ChartCandleSignal[] = [];
  const startIdx = Math.max(1, n - SIGNAL_BARS);
  for (let i = startIdx; i < n; i++) {
    // Recent extreme is measured EXCLUDING the bar under analysis, so a true
    // pierce/break is detected honestly.
    const priorWin = closed.slice(Math.max(0, i - 20), i);
    const recentHigh =
      priorWin.length > 0 ? Math.max(...priorWin.map((c) => c.high)) : closed[i]!.high;
    const recentLow =
      priorWin.length > 0 ? Math.min(...priorWin.map((c) => c.low)) : closed[i]!.low;
    signals.push(analyzeBar(closed, i, avgRange, atrVal, recentHigh, recentLow));
  }

  const latest = signals[signals.length - 1]!;
  const buyers = mean(signals.map((s) => s.buyerScore));
  const sellers = mean(signals.map((s) => s.sellerScore));
  let dominantPressure: ChartPressure;
  if (Math.abs(buyers - sellers) < 8) dominantPressure = "balanced";
  else dominantPressure = buyers > sellers ? "buyers" : "sellers";

  return {
    populated: true,
    latestIntent: latest.intent,
    dominantPressure,
    signals,
    note: `Read ${signals.length} recent bar(s); latest bar reads "${latest.intent}".`,
  };
}
