// ── CANDLESTICK REVERSAL TRUTH (Task #654) ──────────────────────────────────
//
// PURE detectors for the core multi-candle reversal candlesticks alongside the
// dedicated shooting star: the hammer (bullish mirror of the shooting star),
// bullish/bearish engulfing, and the morning/evening star three-candle
// reversals. Each honours the same TRUTH rules: a reversal candle is read in the
// context of the PRIOR trend, and a single-candle signal (hammer) stays
// UNCONFIRMED until the next candle closes in its favour.
//
// DISPLAY / DECISION-SUPPORT only. No IO, no clock. Honest empty: too few
// candles ⇒ status "none". Nothing here grants entry or overrides a feed.

import type {
  PatternDirection,
  PatternQuality,
} from "./patternDetectionContract";

export interface OHLC {
  open: number;
  high: number;
  low: number;
  close: number;
}

export type CandlestickPatternId =
  | "hammer"
  | "bullish_engulfing"
  | "bearish_engulfing"
  | "morning_star"
  | "evening_star";

export type CandlestickStatus = "none" | "forming" | "confirmed";

export interface CandlestickSignal {
  id: CandlestickPatternId;
  name: string;
  detected: boolean;
  status: CandlestickStatus;
  direction: PatternDirection;
  confidence: number;
  quality: PatternQuality;
  confirmationLevel: number | null;
  invalidationLevel: number | null;
  candlesUsed: number;
  minCandles: number;
  reasons: string[];
}

export interface CandlestickInput {
  candles: OHLC[];
  feedConfirmed: boolean;
  feedStale: boolean;
}

function none(id: CandlestickPatternId, name: string, min: number): CandlestickSignal {
  return {
    id,
    name,
    detected: false,
    status: "none",
    direction: "neutral",
    confidence: 0,
    quality: "none",
    confirmationLevel: null,
    invalidationLevel: null,
    candlesUsed: 0,
    minCandles: min,
    reasons: [],
  };
}

function body(c: OHLC): number {
  return Math.abs(c.close - c.open);
}
function isBull(c: OHLC): boolean {
  return c.close > c.open;
}
function isBear(c: OHLC): boolean {
  return c.close < c.open;
}
function upperWick(c: OHLC): number {
  return c.high - Math.max(c.open, c.close);
}
function lowerWick(c: OHLC): number {
  return Math.min(c.open, c.close) - c.low;
}

/** Net-down over the lookback closes ending at (and excluding) idx. */
function priorDowntrend(candles: OHLC[], idx: number, lookback: number): boolean {
  const start = idx - lookback;
  if (start < 0) return false;
  return candles[idx - 1].close < candles[start].close;
}
/** Net-up over the lookback closes ending at (and excluding) idx. */
function priorUptrend(candles: OHLC[], idx: number, lookback: number): boolean {
  const start = idx - lookback;
  if (start < 0) return false;
  return candles[idx - 1].close > candles[start].close;
}

function capForFeed(confidence: number, contextOnly: boolean): number {
  const c = contextOnly ? Math.min(confidence, 35) : confidence;
  return Math.max(0, Math.min(100, Math.round(c)));
}

function gradeQuality(confidence: number): PatternQuality {
  return confidence >= 70 ? "high" : confidence >= 45 ? "medium" : "low";
}

const HAMMER_MIN = 6;
const ENGULF_MIN = 6;
const STAR_MIN = 7;
const LOOKBACK = 4;

/**
 * Hammer: bullish single-candle reversal — long LOWER wick (≥ 2× body), small
 * body near the HIGH, small upper wick, after a downtrend. Unconfirmed until the
 * next candle closes above the hammer's high.
 */
export function detectHammer(input: CandlestickInput): CandlestickSignal {
  const candles = input.candles ?? [];
  const contextOnly = !input.feedConfirmed || input.feedStale;
  const base = none("hammer", "Hammer", HAMMER_MIN);
  if (candles.length < HAMMER_MIN) return base;

  const last = candles.length - 1;
  for (let idx = last; idx >= last - 1 && idx >= LOOKBACK; idx--) {
    const c = candles[idx];
    const b = body(c);
    const range = c.high - c.low;
    if (range <= 0) continue;
    const longLower = lowerWick(c) >= 2 * b && lowerWick(c) >= 0.5 * range;
    const smallUpper = upperWick(c) <= b && upperWick(c) <= 0.15 * range;
    const bodyNearHigh = b <= 0.4 * range;
    if (!(longLower && smallUpper && bodyNearHigh)) continue;
    if (!priorDowntrend(candles, idx, LOOKBACK)) continue;

    let status: CandlestickStatus = "forming";
    const reasons = [
      "Long lower wick after a decline — buyers rejected lower prices.",
      "Small body near the high — classic hammer shape.",
    ];
    if (idx < last) {
      if (candles[idx + 1].close > c.high) {
        status = "confirmed";
        reasons.push("Next candle closed above the hammer's high — confirmed.");
      } else {
        reasons.push("Next candle has not confirmed yet — still forming.");
      }
    } else {
      reasons.push("Unconfirmed — needs a close above the hammer's high.");
    }
    const confidence = capForFeed(status === "confirmed" ? 70 : 55, contextOnly);
    return {
      ...base,
      detected: true,
      status,
      direction: "buy",
      confidence,
      quality: gradeQuality(confidence),
      confirmationLevel: c.high,
      invalidationLevel: c.low,
      candlesUsed: candles.length,
      reasons,
    };
  }
  return base;
}

/**
 * Engulfing: two-candle reversal. Bullish = a down candle then an up candle
 * whose body fully engulfs it (after a downtrend). Bearish = mirror after an
 * uptrend. Confirmed on close of the engulfing candle.
 */
export function detectEngulfing(input: CandlestickInput): CandlestickSignal {
  const candles = input.candles ?? [];
  const contextOnly = !input.feedConfirmed || input.feedStale;
  if (candles.length < ENGULF_MIN) return none("bullish_engulfing", "Bullish Engulfing", ENGULF_MIN);

  const i = candles.length - 1;
  const prev = candles[i - 1];
  const cur = candles[i];
  const prevBody = body(prev);
  const curBody = body(cur);

  // Bullish engulfing
  if (
    isBear(prev) &&
    isBull(cur) &&
    cur.close >= prev.open &&
    cur.open <= prev.close &&
    curBody > prevBody &&
    priorDowntrend(candles, i, LOOKBACK)
  ) {
    const confidence = capForFeed(68, contextOnly);
    return {
      id: "bullish_engulfing",
      name: "Bullish Engulfing",
      detected: true,
      status: "confirmed",
      direction: "buy",
      confidence,
      quality: gradeQuality(confidence),
      confirmationLevel: cur.high,
      invalidationLevel: cur.low,
      candlesUsed: candles.length,
      minCandles: ENGULF_MIN,
      reasons: [
        "An up candle's body fully engulfs the prior down candle after a decline.",
        "Buyers overwhelmed the previous session — bullish reversal.",
      ],
    };
  }

  // Bearish engulfing
  if (
    isBull(prev) &&
    isBear(cur) &&
    cur.open >= prev.close &&
    cur.close <= prev.open &&
    curBody > prevBody &&
    priorUptrend(candles, i, LOOKBACK)
  ) {
    const confidence = capForFeed(68, contextOnly);
    return {
      id: "bearish_engulfing",
      name: "Bearish Engulfing",
      detected: true,
      status: "confirmed",
      direction: "sell",
      confidence,
      quality: gradeQuality(confidence),
      confirmationLevel: cur.low,
      invalidationLevel: cur.high,
      candlesUsed: candles.length,
      minCandles: ENGULF_MIN,
      reasons: [
        "A down candle's body fully engulfs the prior up candle after an advance.",
        "Sellers overwhelmed the previous session — bearish reversal.",
      ],
    };
  }

  return none("bullish_engulfing", "Bullish Engulfing", ENGULF_MIN);
}

/**
 * Morning/evening star: three-candle reversal. Morning (bullish) = a strong down
 * candle, a small-bodied indecision candle, then a strong up candle closing well
 * into the first candle's body, after a downtrend. Evening = mirror.
 */
export function detectStar(input: CandlestickInput): CandlestickSignal {
  const candles = input.candles ?? [];
  const contextOnly = !input.feedConfirmed || input.feedStale;
  if (candles.length < STAR_MIN) return none("morning_star", "Morning Star", STAR_MIN);

  const i = candles.length - 1;
  const a = candles[i - 2];
  const b = candles[i - 1];
  const c = candles[i];
  const aBody = body(a);
  const bBody = body(b);
  const cBody = body(c);
  const smallMiddle = bBody <= aBody * 0.5;

  // Morning star (bullish)
  if (
    isBear(a) &&
    smallMiddle &&
    isBull(c) &&
    cBody > bBody &&
    c.close > a.open - aBody * 0.5 && // closes well into the first body
    c.close > (a.open + a.close) / 2 &&
    priorDowntrend(candles, i - 1, LOOKBACK)
  ) {
    const confidence = capForFeed(66, contextOnly);
    return {
      id: "morning_star",
      name: "Morning Star",
      detected: true,
      status: "confirmed",
      direction: "buy",
      confidence,
      quality: gradeQuality(confidence),
      confirmationLevel: c.high,
      invalidationLevel: Math.min(a.low, b.low, c.low),
      candlesUsed: candles.length,
      minCandles: STAR_MIN,
      reasons: [
        "Down candle, small indecision candle, then a strong up candle into the first body.",
        "Selling stalled and buyers reclaimed control — bullish reversal.",
      ],
    };
  }

  // Evening star (bearish)
  if (
    isBull(a) &&
    smallMiddle &&
    isBear(c) &&
    cBody > bBody &&
    c.close < a.close + aBody * 0.5 &&
    c.close < (a.open + a.close) / 2 &&
    priorUptrend(candles, i - 1, LOOKBACK)
  ) {
    const confidence = capForFeed(66, contextOnly);
    return {
      id: "evening_star",
      name: "Evening Star",
      detected: true,
      status: "confirmed",
      direction: "sell",
      confidence,
      quality: gradeQuality(confidence),
      confirmationLevel: c.low,
      invalidationLevel: Math.max(a.high, b.high, c.high),
      candlesUsed: candles.length,
      minCandles: STAR_MIN,
      reasons: [
        "Up candle, small indecision candle, then a strong down candle into the first body.",
        "Buying stalled and sellers took control — bearish reversal.",
      ],
    };
  }

  return none("morning_star", "Morning Star", STAR_MIN);
}

/** Run every candlestick-reversal detector and return only those that fired. */
export function detectCandlestickReversals(
  input: CandlestickInput,
): CandlestickSignal[] {
  return [detectHammer(input), detectEngulfing(input), detectStar(input)].filter(
    (s) => s.detected,
  );
}
