// ── CHART PATTERN DETECTION ENGINE (Phase 3) ─────────────────────────────────
//
// Pure, deterministic geometric detector. Consumes the normalized closed-candle
// window from the truth layer and the shared chart-math primitives, and emits
// `DetectedPattern[]` (the raw, pre-display-fold shape defined by the domain
// display contract `@workspace/domain/market`). It NEVER fabricates: below a
// pattern's minimum candle count it simply does not emit that pattern (fail
// closed). Same candles ⇒ same patterns.
//
// SAFETY: this module only MEASURES geometry. It carries no feed/execution
// knowledge and no display caps — `resolvePatternTruth` (domain) folds the feed/
// sufficiency facts and applies every display cap downstream. The detector
// therefore imports ONLY the display-side `DetectedPattern`/enum TYPES from the
// domain barrel, never any execution/safety surface.

import type {
  DetectedPattern,
  PatternBias,
  PatternQuality,
  PatternEntryTiming,
  PatternRiskBand,
  PatternStatus,
} from "../market/patternTruthContract.js";
import type { ChartPatternCandle } from "./types.js";
import { atr, clamp, findSwings, type Swing } from "./chartMath.js";

export interface PatternEngineResult {
  patterns: DetectedPattern[];
  /** Closed candles considered (post-filter). */
  candlesConsidered: number;
  /** True when the window was too short for ANY pattern (fail closed). */
  insufficient: boolean;
}

// ── Pattern definitions (the thresholds ARE the definitions; see
//    docs/PATTERN_DETECTION_QUALITY.md for how each was verified) ─────────────
/** H&S: the head must stand at least this many ATR beyond the higher shoulder. */
export const HS_HEAD_PROMINENCE_ATR = 0.5;
/** H&S: head-to-neckline height of at least this many ATR. */
export const HS_MIN_HEIGHT_ATR = 2;
/** Double top/bottom: peak-to-neckline depth of at least this many ATR. */
export const DOUBLE_MIN_HEIGHT_ATR = 1.5;
/** Double top/bottom: at least this many bars between the two extremes. */
export const DOUBLE_MIN_SEPARATION = 5;
/** Breakout & retest: the break must have happened within this many bars. */
export const BREAKOUT_LOOKBACK = 12;

// Smallest window any detector here can act on. Below this we emit nothing.
const GLOBAL_MIN_CANDLES = 20;
const SWING_SPAN = 2;

/**
 * Detect chart patterns on a window of CLOSED, normalized candles. Forming bars
 * must be filtered by the caller (we still defensively drop a trailing forming
 * candle). Returns an empty pattern set when the window is too short.
 */
export function detectChartPatterns(
  candles: ChartPatternCandle[],
): PatternEngineResult {
  const closed = candles.filter((c) => c.isComplete && !c.isForming);
  if (closed.length < GLOBAL_MIN_CANDLES) {
    return { patterns: [], candlesConsidered: closed.length, insufficient: true };
  }

  const swings = findSwings(closed, SWING_SPAN);
  const atrVal = atr(closed, Math.min(14, closed.length - 1));
  const last = closed[closed.length - 1]!;
  const decimals = quoteDecimals(closed);

  const ctx: DetectorContext = { closed, swings, atr: atrVal, last, decimals };

  const patterns: DetectedPattern[] = [];
  for (const detector of DETECTORS) {
    const found = detector(ctx);
    // Fail closed: a pattern whose levels (after rounding to the quote's own
    // precision) are not strictly ordered for its bias, or whose key points fall
    // outside the window, is not shown. Displaying "stop = entry" is worse than
    // displaying nothing.
    if (found && geometryIsCoherent(found, closed.length)) patterns.push(found);
  }

  return { patterns, candlesConsidered: closed.length, insufficient: false };
}

// ── Internal detector plumbing ───────────────────────────────────────────────

interface DetectorContext {
  closed: ChartPatternCandle[];
  swings: Swing[];
  atr: number | null;
  last: ChartPatternCandle;
  decimals: number;
}

type Detector = (ctx: DetectorContext) => DetectedPattern | null;

/**
 * The instrument's own quote precision, read from the candles: the most
 * fractional digits any recent price carries (capped at 6). Rounding a
 * 5-decimal FX quote to 4 decimals made stop and confirmation collapse onto one
 * price on real EURUSD bars. Only an all-integer window falls back to the
 * magnitude default; a floor ABOVE the quote's own precision drew half-tick
 * levels (AUDUSD x100 at 4 decimals for a 3-decimal quote) and let the status
 * flip on a line no price can sit on.
 */
export function quoteDecimals(closed: readonly ChartPatternCandle[]): number {
  let d = 0;
  for (const c of closed.slice(-60)) {
    for (const v of [c.open, c.high, c.low, c.close]) {
      const s = String(v);
      if (s.includes("e")) return Math.max(decimalsFor(closed[closed.length - 1]!.close), 6);
      const dot = s.indexOf(".");
      if (dot >= 0) d = Math.max(d, s.length - dot - 1);
    }
  }
  return Math.min(6, d > 0 ? d : decimalsFor(closed[closed.length - 1]!.close));
}

/** Levels strictly ordered for the bias, finite, and key points inside the window. */
export function geometryIsCoherent(p: DetectedPattern, windowLength: number): boolean {
  const { confirmation: cf, invalidation: inv, targets } = p.levels;
  const t = targets[0];
  if (![cf, inv, t].every((x) => typeof x === "number" && Number.isFinite(x))) return false;
  const ordered = p.bias === "bullish" ? inv! < cf! && cf! < t! : p.bias === "bearish" ? inv! > cf! && cf! > t! : true;
  return ordered && p.keyPoints.every((k) => Number.isInteger(k.index) && k.index >= 0 && k.index < windowLength);
}

function decimalsFor(price: number): number {
  const p = Math.abs(price);
  if (p >= 1000) return 1;
  if (p >= 100) return 2;
  if (p >= 1) return 4;
  return 5;
}

function highs(swings: Swing[]): Swing[] {
  return swings.filter((s) => s.kind === "high");
}
function lows(swings: Swing[]): Swing[] {
  return swings.filter((s) => s.kind === "low");
}

/**
 * Prices are multiples of a tick and ATR is a mean of tick multiples, so a
 * distance often EQUALS its ATR threshold exactly. Float noise then decides the
 * tie differently at different price scales (EURUSD vs the same chart x100
 * picked different breakout levels on 1 window in 4). Comparisons against a
 * threshold therefore allow a relative slack far below one tick.
 */
const TIE_SLACK = 1e-9;
/** x >= y, with a tie decided the same way at every price scale. */
const atLeast = (x: number, y: number) => x >= y - Math.abs(y) * TIE_SLACK;
/** x <= y, with a tie decided the same way at every price scale. */
const atMost = (x: number, y: number) => x <= y + Math.abs(y) * TIE_SLACK;

/** Relative closeness of two prices, normalized by ATR when available. */
function near(a: number, b: number, atrVal: number | null, tolAtr = 0.5): boolean {
  if (atrVal && atrVal > 0) return Math.abs(a - b) <= tolAtr * atrVal * (1 + TIE_SLACK);
  const base = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / base <= 0.0015;
}

/** Linear-regression slope of a numeric series (per index step). */
function slope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += values[i]!;
    sxy += i * values[i]!;
    sxx += i * i;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  const sl = (n * sxy - sx * sy) / denom;
  // A flat run of quoted prices has slope exactly 0; float noise makes it
  // +/-1e-17 and the sign (a trend test) then depends on the price scale.
  const scale = Math.max(...values.map((v) => Math.abs(v)));
  return Math.abs(sl) <= scale * 1e-12 ? 0 : sl;
}

function qualityFromScore(score: number): PatternQuality {
  if (score >= 75) return "high";
  if (score >= 55) return "medium";
  if (score >= 35) return "low";
  return "none";
}

/**
 * Round to the quote's precision, half up, the same way at every price scale:
 * the scaled value is normalised to 15 significant digits first, so a midpoint
 * like 1.084515 (stored as 1.0845149999…) and 108.4515 (108.4515000…1) both
 * round up. A plain Math.round sent the two in opposite directions.
 */
function r(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(Number((n * f).toPrecision(15))) / f;
}

// ── Head & Shoulders (and inverse) — reversal ────────────────────────────────

function detectHeadAndShoulders(ctx: DetectorContext): DetectedPattern | null {
  const { closed, swings, atr: atrVal, last, decimals } = ctx;
  const MIN = 30;
  if (closed.length < MIN) return null;

  // Standard (bearish) H&S: three highs L<H>R with two troughs forming a neckline.
  const hs = highs(swings);
  const ls = lows(swings);
  if (hs.length >= 3 && ls.length >= 2) {
    const [lShoulder, head, rShoulder] = lastThree(hs);
    if (lShoulder && head && rShoulder) {
      const headIsHighest = atLeast(head.price - Math.max(lShoulder.price, rShoulder.price), HS_HEAD_PROMINENCE_ATR * (atrVal ?? 0));
      const shouldersLevel = near(lShoulder.price, rShoulder.price, atrVal, 0.6);
      if (atrVal && headIsHighest && shouldersLevel) {
        // The neckline needs a trough on EACH side of the head.
        const leftTrough = lowestBetween(ls, lShoulder.index, head.index);
        const rightTrough = lowestBetween(ls, head.index, rShoulder.index);
        const troughs = leftTrough && rightTrough ? [leftTrough, rightTrough] : [];
        if (troughs.length === 2) {
          // Rounded to the quote's precision BEFORE status is judged, so the
          // status always agrees with the level the user is shown.
          const neckline = r(mean(troughs.map((t) => t.price)), decimals);
          const height = head.price - neckline;
          if (atLeast(height, HS_MIN_HEIGHT_ATR * atrVal)) {
            const broke = last.close < neckline;
            const status: PatternStatus = broke
              ? extensionExhausted(last.close, neckline, height, "down")
                ? "exhausted"
                : "confirmed"
              : last.close > head.price
                ? "invalidated"
                : "forming";
            const score = symmetryScore(lShoulder.price, rShoulder.price, atrVal) + 10;
            return {
              id: "head_and_shoulders",
              name: "Head & Shoulders",
              category: "reversal",
              bias: "bearish",
              status,
              confidence: clamp(score),
              quality: qualityFromScore(score),
              levels: {
                confirmation: r(neckline, decimals),
                invalidation: r(head.price, decimals),
                targets: [r(neckline - height, decimals)],
              },
              keyPoints: [
                { index: lShoulder.index, price: r(lShoulder.price, decimals), role: "left_shoulder" },
                { index: head.index, price: r(head.price, decimals), role: "head" },
                { index: rShoulder.index, price: r(rShoulder.price, decimals), role: "right_shoulder" },
                { index: troughs[0]!.index, price: r(troughs[0]!.price, decimals), role: "neckline_left" },
                { index: troughs[1]!.index, price: r(troughs[1]!.price, decimals), role: "neckline_right" },
              ],
              rationale: [
                "Higher central peak (head) between two lower, level shoulders.",
                "Neckline drawn across the intervening troughs.",
              ],
              failureModes: ["A close back above the head invalidates the reversal."],
              minCandles: MIN,
              entryTiming: timingForBreak(status),
              falseBreakoutRisk: breakoutRisk(status, troughs.length),
            };
          }
        }
      }
    }
  }

  // Inverse (bullish) H&S: three lows L>H<R with two peaks forming a neckline.
  if (ls.length >= 3 && hs.length >= 2) {
    const [lShoulder, head, rShoulder] = lastThree(ls);
    if (lShoulder && head && rShoulder) {
      const headIsLowest = atLeast(Math.min(lShoulder.price, rShoulder.price) - head.price, HS_HEAD_PROMINENCE_ATR * (atrVal ?? 0));
      const shouldersLevel = near(lShoulder.price, rShoulder.price, atrVal, 0.6);
      if (atrVal && headIsLowest && shouldersLevel) {
        const leftPeak = highestBetween(hs, lShoulder.index, head.index);
        const rightPeak = highestBetween(hs, head.index, rShoulder.index);
        const peaks = leftPeak && rightPeak ? [leftPeak, rightPeak] : [];
        if (peaks.length === 2) {
          const neckline = r(mean(peaks.map((t) => t.price)), decimals);
          const height = neckline - head.price;
          if (atLeast(height, HS_MIN_HEIGHT_ATR * atrVal)) {
            const broke = last.close > neckline;
            const status: PatternStatus = broke
              ? extensionExhausted(last.close, neckline, height, "up")
                ? "exhausted"
                : "confirmed"
              : last.close < head.price
                ? "invalidated"
                : "forming";
            const score = symmetryScore(lShoulder.price, rShoulder.price, atrVal) + 10;
            return {
              id: "inverse_head_and_shoulders",
              name: "Inverse Head & Shoulders",
              category: "reversal",
              bias: "bullish",
              status,
              confidence: clamp(score),
              quality: qualityFromScore(score),
              levels: {
                confirmation: r(neckline, decimals),
                invalidation: r(head.price, decimals),
                targets: [r(neckline + height, decimals)],
              },
              keyPoints: [
                { index: lShoulder.index, price: r(lShoulder.price, decimals), role: "left_shoulder" },
                { index: head.index, price: r(head.price, decimals), role: "head" },
                { index: rShoulder.index, price: r(rShoulder.price, decimals), role: "right_shoulder" },
                { index: peaks[0]!.index, price: r(peaks[0]!.price, decimals), role: "neckline_left" },
                { index: peaks[1]!.index, price: r(peaks[1]!.price, decimals), role: "neckline_right" },
              ],
              rationale: [
                "Lower central trough (head) between two higher, level shoulders.",
                "Neckline drawn across the intervening peaks.",
              ],
              failureModes: ["A close back below the head invalidates the reversal."],
              minCandles: MIN,
              entryTiming: timingForBreak(status),
              falseBreakoutRisk: breakoutRisk(status, peaks.length),
            };
          }
        }
      }
    }
  }

  return null;
}

// ── Double top / double bottom — reversal ────────────────────────────────────

function detectDoubleReversal(ctx: DetectorContext): DetectedPattern | null {
  const { closed, swings, atr: atrVal, last, decimals } = ctx;
  const MIN = 24;
  if (closed.length < MIN) return null;

  const hs = highs(swings);
  const ls = lows(swings);

  // Double top (bearish): two near-equal highs with a trough between.
  if (hs.length >= 2 && ls.length >= 1) {
    const [a, b] = lastTwo(hs);
    if (atrVal && a && b && b.index - a.index >= DOUBLE_MIN_SEPARATION && near(a.price, b.price, atrVal, 0.5)) {
      const trough = ls
        .filter((t) => t.index > a.index && t.index < b.index)
        .sort((x, y) => x.price - y.price)[0];
      if (trough) {
        const neckline = trough.price;
        const height = Math.max(a.price, b.price) - neckline;
        if (atLeast(height, DOUBLE_MIN_HEIGHT_ATR * atrVal)) {
          const broke = last.close < neckline;
          const status: PatternStatus = broke
            ? extensionExhausted(last.close, neckline, height, "down")
              ? "exhausted"
              : "confirmed"
            : last.close > Math.max(a.price, b.price)
              ? "invalidated"
              : "forming";
          const score = symmetryScore(a.price, b.price, atrVal);
          return {
            id: "double_top",
            name: "Double Top",
            category: "reversal",
            bias: "bearish",
            status,
            confidence: clamp(score),
            quality: qualityFromScore(score),
            levels: {
              confirmation: r(neckline, decimals),
              invalidation: r(Math.max(a.price, b.price), decimals),
              targets: [r(neckline - height, decimals)],
            },
            keyPoints: [
              { index: a.index, price: r(a.price, decimals), role: "first_top" },
              { index: b.index, price: r(b.price, decimals), role: "second_top" },
              { index: trough.index, price: r(neckline, decimals), role: "neckline" },
            ],
            rationale: ["Two highs at a similar level rejected the same resistance."],
            failureModes: ["A close above the higher top invalidates the top."],
            minCandles: MIN,
            entryTiming: timingForBreak(status),
            falseBreakoutRisk: breakoutRisk(status, 1),
          };
        }
      }
    }
  }

  // Double bottom (bullish): two near-equal lows with a peak between.
  if (ls.length >= 2 && hs.length >= 1) {
    const [a, b] = lastTwo(ls);
    if (atrVal && a && b && b.index - a.index >= DOUBLE_MIN_SEPARATION && near(a.price, b.price, atrVal, 0.5)) {
      const peak = hs
        .filter((t) => t.index > a.index && t.index < b.index)
        .sort((x, y) => y.price - x.price)[0];
      if (peak) {
        const neckline = peak.price;
        const height = neckline - Math.min(a.price, b.price);
        if (atLeast(height, DOUBLE_MIN_HEIGHT_ATR * atrVal)) {
          const broke = last.close > neckline;
          const status: PatternStatus = broke
            ? extensionExhausted(last.close, neckline, height, "up")
              ? "exhausted"
              : "confirmed"
            : last.close < Math.min(a.price, b.price)
              ? "invalidated"
              : "forming";
          const score = symmetryScore(a.price, b.price, atrVal);
          return {
            id: "double_bottom",
            name: "Double Bottom",
            category: "reversal",
            bias: "bullish",
            status,
            confidence: clamp(score),
            quality: qualityFromScore(score),
            levels: {
              confirmation: r(neckline, decimals),
              invalidation: r(Math.min(a.price, b.price), decimals),
              targets: [r(neckline + height, decimals)],
            },
            keyPoints: [
              { index: a.index, price: r(a.price, decimals), role: "first_bottom" },
              { index: b.index, price: r(b.price, decimals), role: "second_bottom" },
              { index: peak.index, price: r(neckline, decimals), role: "neckline" },
            ],
            rationale: ["Two lows at a similar level held the same support."],
            failureModes: ["A close below the lower bottom invalidates the bottom."],
            minCandles: MIN,
            entryTiming: timingForBreak(status),
            falseBreakoutRisk: breakoutRisk(status, 1),
          };
        }
      }
    }
  }

  return null;
}

// ── Bull / bear flag — continuation ──────────────────────────────────────────

function detectFlag(ctx: DetectorContext): DetectedPattern | null {
  const { closed, atr: atrVal, last, decimals } = ctx;
  const MIN = 20;
  if (closed.length < MIN) return null;

  // Flagpole = strong impulse; flag = shallow counter-trend drift; the LAST bar
  // is the break candidate, measured against the flag box that precedes it.
  // (The box used to include the last bar, so its close could never be above
  // the box high or below the box low: every flag on real data stayed
  // "forming" forever — 4,943 of 4,943.)
  const poleLen = Math.min(8, Math.floor(closed.length / 3));
  const flagLen = Math.min(5, Math.floor(closed.length / 4));
  if (poleLen < 3 || flagLen < 3) return null;

  const poleEnd = closed.length - 1 - flagLen;
  const poleStart = poleEnd - poleLen;
  if (poleStart < 0) return null;

  const pole = closed.slice(poleStart, poleEnd);
  const flag = closed.slice(poleEnd, closed.length - 1);
  const poleMove = pole[pole.length - 1]!.close - pole[0]!.close;
  const poleRange = Math.max(...pole.map((c) => c.high)) - Math.min(...pole.map((c) => c.low));
  if (poleRange <= 0) return null;

  const flagCloses = flag.map((c) => c.close);
  const flagSlope = slope(flagCloses);
  const flagRange = Math.max(...flag.map((c) => c.high)) - Math.min(...flag.map((c) => c.low));

  // Pole must be a clear impulse (≥ ~2 ATR move) and flag a shallow pullback.
  const impulseOk = atrVal ? atLeast(Math.abs(poleMove), 2 * atrVal) : atLeast(Math.abs(poleMove), poleRange * 0.6);
  const shallowOk = atMost(flagRange, poleRange * 0.6);
  if (!impulseOk || !shallowOk) return null;

  const bullish = poleMove > 0;
  // Counter-trend drift confirms a flag (bull flag drifts down, bear flag up).
  const drifts = bullish ? flagSlope <= 0 : flagSlope >= 0;
  if (!drifts) return null;

  const flagHigh = Math.max(...flag.map((c) => c.high));
  const flagLow = Math.min(...flag.map((c) => c.low));
  const confirmation = bullish ? flagHigh : flagLow;
  const invalidation = bullish ? flagLow : flagHigh;
  const target = bullish ? confirmation + Math.abs(poleMove) : confirmation - Math.abs(poleMove);

  const broke = bullish ? last.close > flagHigh : last.close < flagLow;
  const height = Math.abs(poleMove);
  const status: PatternStatus = broke
    ? extensionExhausted(last.close, confirmation, height, bullish ? "up" : "down")
      ? "exhausted"
      : "confirmed"
    : (bullish ? last.close < flagLow : last.close > flagHigh)
      ? "invalidated"
      : "forming";

  const score = 50 + (atrVal ? clamp((Math.abs(poleMove) / atrVal) * 6, 0, 25) : 10);
  const bias: PatternBias = bullish ? "bullish" : "bearish";

  return {
    id: bullish ? "bull_flag" : "bear_flag",
    name: bullish ? "Bull Flag" : "Bear Flag",
    category: "continuation",
    bias,
    status,
    confidence: clamp(score),
    quality: qualityFromScore(score),
    levels: {
      confirmation: r(confirmation, decimals),
      invalidation: r(invalidation, decimals),
      targets: [r(target, decimals)],
    },
    keyPoints: [
      { index: poleStart, price: r(pole[0]!.close, decimals), role: "flagpole_start" },
      { index: poleEnd - 1, price: r(pole[pole.length - 1]!.close, decimals), role: "flagpole_end" },
      { index: closed.length - 1, price: r(last.close, decimals), role: broke ? "flag_break" : "flag_last" },
    ],
    rationale: [
      `Strong ${bullish ? "up" : "down"} impulse (flagpole) followed by a shallow ${bullish ? "down" : "up"} drift.`,
      "Measured-move target projects the flagpole from the breakout.",
    ],
    failureModes: ["A deep pullback through the flag invalidates the continuation."],
    minCandles: MIN,
    entryTiming: timingForBreak(status),
    falseBreakoutRisk: breakoutRisk(status, 1),
  };
}

// ── Liquidity sweep — structure ──────────────────────────────────────────────

function detectLiquiditySweep(ctx: DetectorContext): DetectedPattern | null {
  const { closed, swings, atr: atrVal, last, decimals } = ctx;
  const MIN = 20;
  if (closed.length < MIN) return null;
  if (!atrVal || atrVal <= 0) return null;

  // A sweep = wick pierces a prior swing extreme, then the candle closes back
  // inside (stop-run / failed breakout reversal).
  const recent = closed.slice(-3);
  const target = recent[recent.length - 1]!;

  const priorHigh = highs(swings)
    .filter((s) => s.index < closed.length - 3)
    .sort((a, b) => b.price - a.price)[0];
  const priorLow = lows(swings)
    .filter((s) => s.index < closed.length - 3)
    .sort((a, b) => a.price - b.price)[0];

  // The target is the NEAREST prior swing on the reversal side of the close (the
  // library's spec), not the window's extreme: the extreme of 150 bars put the
  // drawn target several times further away than the pattern claims.
  const before = [...highs(swings), ...lows(swings)].filter((s) => s.index < closed.length - 3);
  const nearestBelow = before.filter((s) => s.kind === "low" && s.price < last.close).sort((a, b) => b.price - a.price)[0];
  const nearestAbove = before.filter((s) => s.kind === "high" && s.price > last.close).sort((a, b) => a.price - b.price)[0];

  // Bearish sweep: wick takes prior high, closes back below it.
  if (priorHigh && target.high > priorHigh.price && target.close < priorHigh.price) {
    const pierce = target.high - priorHigh.price;
    if (atLeast(pierce, 0.1 * atrVal)) {
      const score = 50 + clamp((pierce / atrVal) * 30, 0, 25);
      return sweepPattern({
        id: "liquidity_sweep_high",
        name: "Liquidity Sweep (high)",
        bias: "bearish",
        swept: priorHigh.price,
        close: last.close,
        invalidation: target.high,
        target: nearestBelow?.price ?? last.close - 2 * atrVal,
        index: closed.length - 1,
        score,
        decimals,
        atrVal,
      });
    }
  }

  // Bullish sweep: wick takes prior low, closes back above it.
  if (priorLow && target.low < priorLow.price && target.close > priorLow.price) {
    const pierce = priorLow.price - target.low;
    if (atLeast(pierce, 0.1 * atrVal)) {
      const score = 50 + clamp((pierce / atrVal) * 30, 0, 25);
      return sweepPattern({
        id: "liquidity_sweep_low",
        name: "Liquidity Sweep (low)",
        bias: "bullish",
        swept: priorLow.price,
        close: last.close,
        invalidation: target.low,
        target: nearestAbove?.price ?? last.close + 2 * atrVal,
        index: closed.length - 1,
        score,
        decimals,
        atrVal,
      });
    }
  }

  return null;
}

function sweepPattern(args: {
  id: string;
  name: string;
  bias: PatternBias;
  swept: number;
  close: number;
  invalidation: number;
  target: number;
  index: number;
  score: number;
  decimals: number;
  atrVal: number;
}): DetectedPattern {
  const { id, name, bias, swept, invalidation, target, index, score, decimals } = args;
  return {
    id,
    name,
    category: "structure",
    bias,
    // A sweep that already closed back inside is a confirmed reversal signal,
    // but it is short-lived — flag chase risk if price ran far from the sweep.
    status: "confirmed",
    confidence: clamp(score),
    quality: qualityFromScore(score),
    levels: {
      confirmation: r(swept, decimals),
      invalidation: r(invalidation, decimals),
      targets: [r(target, decimals)],
    },
    keyPoints: [
      { index, price: r(swept, decimals), role: "swept_level" },
      { index, price: r(invalidation, decimals), role: "sweep_extreme" },
    ],
    rationale: ["Price pierced a prior swing extreme then closed back inside (stop run)."],
    failureModes: ["A close beyond the sweep extreme negates the reversal."],
    minCandles: 20,
    entryTiming: "clean",
    falseBreakoutRisk: "medium",
  };
}

// ── Breakout + retest — horizontal level reclaimed/rejected ──────────────────

function detectBreakoutRetest(ctx: DetectorContext): DetectedPattern | null {
  const { closed, swings, atr: atrVal, last, decimals } = ctx;
  const MIN = 24;
  if (closed.length < MIN) return null;
  if (!atrVal || atrVal <= 0) return null;

  // Bullish: a decisive close ABOVE a tested resistance, then a pullback that
  // retested the level and is holding above it now. Bearish mirrors it.
  for (const breakAbove of [true, false]) {
    const found = findBreak({ closed, swings, atrVal, decimals, breakAbove });
    if (!found) continue;
    const out = breakoutRetestFor({ ...found, breakAbove, closed, atrVal, last, decimals });
    if (out) return out;
  }
  return null;
}

/**
 * The first bar in the last BREAKOUT_LOOKBACK bars that CROSSES a tested level:
 * the level is ≥2 clustered swings already CONFIRMED before that bar (a swing at
 * j is only known at j + SWING_SPAN), the bar closes beyond it by the buffer,
 * and the bar before closed on the near side. Without the crossing rule any old
 * level price had long since left behind "broke" again on every bar: the
 * pattern fired on 47% of real chart windows. Without the "confirmed before the
 * break" rule, swings printed AFTER the break could define the level.
 */
function findBreak(args: {
  closed: ChartPatternCandle[];
  swings: Swing[];
  atrVal: number;
  decimals: number;
  breakAbove: boolean;
}): { level: number; touches: number; breakIdx: number } | null {
  const { closed, swings, atrVal, decimals, breakAbove } = args;
  const buffer = 0.3 * atrVal;
  for (let i = Math.max(1, closed.length - BREAKOUT_LOOKBACK); i < closed.length; i++) {
    const known = swings.filter((s) => s.index + SWING_SPAN < i);
    const cluster = clusteredLevel(breakAbove ? highs(known) : lows(known), atrVal);
    if (!cluster) continue;
    // Rounded to the quote's precision BEFORE it is judged, so the break and the
    // status always agree with the level the user is shown.
    const level = r(cluster.price, decimals);
    const c = closed[i]!;
    const before = closed[i - 1]!;
    const crossed = breakAbove
      ? !atMost(c.close - level, buffer) && before.close <= level
      : !atMost(level - c.close, buffer) && before.close >= level;
    if (crossed) return { level, touches: cluster.touches, breakIdx: i };
  }
  return null;
}

/** A horizontal level with the count of swings that cluster near it (≥2). */
function clusteredLevel(
  pts: Swing[],
  atrVal: number,
): { price: number; touches: number } | null {
  if (pts.length < 2) return null;
  let best: { price: number; touches: number } | null = null;
  for (const anchor of pts) {
    const cluster = pts.filter((p) => near(p.price, anchor.price, atrVal, 0.4));
    if (cluster.length >= 2) {
      const price = mean(cluster.map((p) => p.price));
      // Prefer the most-tested level; tie-break on the more recent anchor.
      if (!best || cluster.length > best.touches) {
        best = { price, touches: cluster.length };
      }
    }
  }
  return best;
}

function breakoutRetestFor(args: {
  level: number;
  touches: number;
  breakIdx: number;
  breakAbove: boolean;
  closed: ChartPatternCandle[];
  atrVal: number;
  last: ChartPatternCandle;
  decimals: number;
}): DetectedPattern | null {
  const { level, touches, breakIdx, breakAbove, closed, atrVal, last, decimals } = args;
  const buffer = 0.3 * atrVal;

  // After the break, did price pull back to RETEST the level (within ~0.5 ATR)?
  let retested = false;
  for (let i = breakIdx + 1; i < closed.length; i++) {
    const c = closed[i]!;
    const touchedLevel = breakAbove
      ? atMost(c.low - level, 0.5 * atrVal)
      : atMost(level - c.high, 0.5 * atrVal);
    if (touchedLevel) retested = true;
  }

  const holding = breakAbove ? last.close > level : last.close < level;
  const failed = breakAbove ? !atMost(level - last.close, buffer) : !atMost(last.close - level, buffer);

  const height = atrVal * 2;
  const confirmation = r(level, decimals);
  const invalidation = breakAbove
    ? r(level - buffer, decimals)
    : r(level + buffer, decimals);
  const target = breakAbove
    ? r(level + height, decimals)
    : r(level - height, decimals);

  const status: PatternStatus = failed
    ? "failed"
    : holding && retested
      ? extensionExhausted(last.close, level, height, breakAbove ? "up" : "down")
        ? "exhausted"
        : "confirmed"
      : "forming";

  const score = 45 + (touches >= 3 ? 15 : 8) + (retested ? 12 : 0);

  return {
    id: breakAbove ? "breakout_retest_up" : "breakout_retest_down",
    name: breakAbove ? "Resistance Breakout & Retest" : "Support Breakdown & Retest",
    category: "breakout_retest",
    bias: breakAbove ? "bullish" : "bearish",
    status,
    confidence: clamp(score),
    quality: qualityFromScore(score),
    levels: { confirmation, invalidation, targets: [target] },
    keyPoints: [
      { index: breakIdx, price: confirmation, role: "broken_level" },
      { index: closed.length - 1, price: r(last.close, decimals), role: "retest" },
    ],
    rationale: [
      `Tested ${breakAbove ? "resistance" : "support"} (${touches} touches) broke and ${
        retested ? "retested" : "has not retested yet"
      }.`,
      "Measured-move target projects roughly two ATR from the broken level.",
    ],
    failureModes: [
      `A close back ${breakAbove ? "below" : "above"} the level marks a failed ${
        breakAbove ? "breakout (bull trap)" : "breakdown (bear trap)"
      }.`,
    ],
    minCandles: 24,
    entryTiming: timingForBreak(status),
    falseBreakoutRisk: breakoutRisk(status, retested ? 2 : 1),
  };
}

// ── Candlestick — engulfing ──────────────────────────────────────────────────

function detectEngulfing(ctx: DetectorContext): DetectedPattern | null {
  const { closed, atr: atrVal, last, decimals } = ctx;
  const MIN = 20;
  if (closed.length < MIN) return null;

  const prev = closed[closed.length - 2]!;
  const prevBull = prev.close > prev.open;
  const prevBear = prev.close < prev.open;
  const lastBull = last.close > last.open;
  const lastBear = last.close < last.open;
  const prevBody = Math.abs(prev.close - prev.open);
  const lastBody = Math.abs(last.close - last.open);
  if (prevBody <= 0 || lastBody <= 0) return null;
  if (!atLeast(lastBody, prevBody)) return null; // last body must dominate

  // Context: average direction of the ~5 candles before the engulfing pair.
  const ctxCloses = closed.slice(Math.max(0, closed.length - 7), closed.length - 1).map((c) => c.close);
  const trendSlope = slope(ctxCloses);

  // Bullish engulfing: prior down candle, current up candle engulfs its body,
  // printed after a down move.
  if (prevBear && lastBull && last.open <= prev.close && last.close >= prev.open && trendSlope < 0) {
    return engulfingPattern({
      bullish: true,
      body: lastBody,
      prevBody,
      last,
      lastIndex: closed.length - 1,
      decimals,
    });
  }
  // Bearish engulfing: prior up candle, current down candle engulfs its body,
  // printed after an up move.
  if (prevBull && lastBear && last.open >= prev.close && last.close <= prev.open && trendSlope > 0) {
    return engulfingPattern({
      bullish: false,
      body: lastBody,
      prevBody,
      last,
      lastIndex: closed.length - 1,
      decimals,
    });
  }
  return null;
}

function engulfingPattern(args: {
  bullish: boolean;
  body: number;
  prevBody: number;
  last: ChartPatternCandle;
  lastIndex: number;
  decimals: number;
}): DetectedPattern {
  const { bullish, body, prevBody, last, lastIndex, decimals } = args;
  const range = last.high - last.low;
  const confirmation = bullish ? last.high : last.low;
  const invalidation = bullish ? last.low : last.high;
  const target = bullish ? confirmation + range * 2 : confirmation - range * 2;
  // Bigger engulf body relative to the prior body → more conviction.
  const score = 40 + clamp((body / Math.max(prevBody, 1e-9) - 1) * 25, 0, 25);
  return {
    id: bullish ? "bullish_engulfing" : "bearish_engulfing",
    name: bullish ? "Bullish Engulfing" : "Bearish Engulfing",
    category: "candlestick",
    bias: bullish ? "bullish" : "bearish",
    // The candle has printed but the reversal needs follow-through past its
    // extreme — treat as forming until that break.
    status: "forming",
    confidence: clamp(score),
    quality: qualityFromScore(score),
    levels: {
      confirmation: r(confirmation, decimals),
      invalidation: r(invalidation, decimals),
      targets: [r(target, decimals)],
    },
    keyPoints: [
      { index: lastIndex, price: r(confirmation, decimals), role: "engulfing_extreme" },
    ],
    rationale: [
      `An ${bullish ? "up" : "down"} candle engulfed the prior body after a ${
        bullish ? "down" : "up"
      } move.`,
    ],
    failureModes: [
      `A close ${bullish ? "below" : "above"} the engulfing candle negates the reversal.`,
    ],
    minCandles: 20,
    entryTiming: timingForBreak("forming"),
    falseBreakoutRisk: breakoutRisk("forming", 1),
  };
}

// ── Candlestick — pin bar (hammer / shooting star) ───────────────────────────

function detectPinBar(ctx: DetectorContext): DetectedPattern | null {
  const { closed, last, decimals } = ctx;
  const MIN = 20;
  if (closed.length < MIN) return null;

  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;
  if (range <= 0) return null;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const bodyRef = Math.max(body, range * 0.05); // floor so a doji body still scales

  const ctxCloses = closed.slice(Math.max(0, closed.length - 6), closed.length - 1).map((c) => c.close);
  const trendSlope = slope(ctxCloses);

  // Bullish hammer: long lower wick, small upper wick, after a down move.
  if (atLeast(lowerWick, 2 * bodyRef) && atMost(upperWick, bodyRef) && trendSlope < 0) {
    return pinBarPattern({
      bullish: true,
      wick: lowerWick,
      range,
      last,
      lastIndex: closed.length - 1,
      decimals,
    });
  }
  // Bearish shooting star: long upper wick, small lower wick, after an up move.
  if (atLeast(upperWick, 2 * bodyRef) && atMost(lowerWick, bodyRef) && trendSlope > 0) {
    return pinBarPattern({
      bullish: false,
      wick: upperWick,
      range,
      last,
      lastIndex: closed.length - 1,
      decimals,
    });
  }
  return null;
}

function pinBarPattern(args: {
  bullish: boolean;
  wick: number;
  range: number;
  last: ChartPatternCandle;
  lastIndex: number;
  decimals: number;
}): DetectedPattern {
  const { bullish, wick, range, last, lastIndex, decimals } = args;
  const confirmation = bullish ? last.high : last.low;
  const invalidation = bullish ? last.low : last.high;
  const target = bullish ? confirmation + range * 2 : confirmation - range * 2;
  // Longer wick relative to range → cleaner rejection.
  const score = 40 + clamp((wick / range) * 30, 0, 25);
  return {
    id: bullish ? "bullish_pin_bar" : "bearish_pin_bar",
    name: bullish ? "Bullish Pin Bar (Hammer)" : "Bearish Pin Bar (Shooting Star)",
    category: "candlestick",
    bias: bullish ? "bullish" : "bearish",
    status: "forming",
    confidence: clamp(score),
    quality: qualityFromScore(score),
    levels: {
      confirmation: r(confirmation, decimals),
      invalidation: r(invalidation, decimals),
      targets: [r(target, decimals)],
    },
    keyPoints: [
      { index: lastIndex, price: r(confirmation, decimals), role: "pin_extreme" },
    ],
    rationale: [
      `A long ${bullish ? "lower" : "upper"} wick rejected ${
        bullish ? "lower" : "higher"
      } prices after a ${bullish ? "down" : "up"} move.`,
    ],
    failureModes: [
      `A close ${bullish ? "below" : "above"} the wick negates the rejection.`,
    ],
    minCandles: 20,
    entryTiming: timingForBreak("forming"),
    falseBreakoutRisk: breakoutRisk("forming", 1),
  };
}

// ── Scalp flare — compression then a momentum expansion burst ─────────────────

function detectScalpFlare(ctx: DetectorContext): DetectedPattern | null {
  const { closed, atr: atrVal, last, decimals } = ctx;
  const MIN = 20;
  if (closed.length < MIN) return null;
  if (!atrVal || atrVal <= 0) return null;

  // Base = the ~6 candles before the last; flare = the last (expansion) candle.
  const base = closed.slice(closed.length - 7, closed.length - 1);
  if (base.length < 4) return null;
  const baseHigh = Math.max(...base.map((c) => c.high));
  const baseLow = Math.min(...base.map((c) => c.low));
  const baseRangeMax = Math.max(...base.map((c) => c.high - c.low));

  // Compression: every base candle's range is well under ATR.
  const compressed = atMost(baseRangeMax, 0.8 * atrVal);
  if (!compressed) return null;

  const flareRange = last.high - last.low;
  const flareBody = Math.abs(last.close - last.open);
  // Expansion: a wide-range candle with a dominant directional body.
  const expanded = atLeast(flareRange, 1.5 * atrVal) && atLeast(flareBody, 0.6 * flareRange);
  if (!expanded) return null;

  const bullish = last.close > last.open;
  // The flare must actually break the base in its own direction.
  if (bullish ? last.close <= baseHigh : last.close >= baseLow) return null;

  const baseEdge = bullish ? baseHigh : baseLow;
  const height = Math.max(flareRange, 2 * atrVal);
  const confirmation = baseEdge;
  const invalidation = bullish ? baseLow : baseHigh;
  const target = bullish ? baseEdge + height : baseEdge - height;

  // Overextended flare (ran far past the base) → chase, mark exhausted.
  const extension = bullish ? last.close - baseHigh : baseLow - last.close;
  const status: PatternStatus = atLeast(extension, 3 * atrVal) ? "exhausted" : "confirmed";

  const score = 45 + clamp((flareRange / atrVal) * 12, 0, 30);

  return {
    id: bullish ? "scalp_flare_up" : "scalp_flare_down",
    name: bullish ? "Scalp Flare (up)" : "Scalp Flare (down)",
    category: "scalp_flare",
    bias: bullish ? "bullish" : "bearish",
    status,
    confidence: clamp(score),
    quality: qualityFromScore(score),
    levels: {
      confirmation: r(confirmation, decimals),
      invalidation: r(invalidation, decimals),
      targets: [r(target, decimals)],
    },
    keyPoints: [
      { index: closed.length - 2, price: r(baseEdge, decimals), role: "base_edge" },
      { index: closed.length - 1, price: r(last.close, decimals), role: "flare_close" },
    ],
    rationale: [
      "A tight low-volatility base released into a wide directional expansion candle.",
      "Measured-move target projects the flare height from the base edge.",
    ],
    failureModes: [
      "An immediate close back into the base is a failed flare.",
      "A flare that overextends is a chase, not an entry.",
    ],
    minCandles: 20,
    entryTiming: timingForBreak(status),
    falseBreakoutRisk: breakoutRisk(status, 1),
  };
}

// ── shared status helpers ────────────────────────────────────────────────────

function extensionExhausted(
  close: number,
  confirmation: number,
  height: number,
  dir: "up" | "down",
): boolean {
  if (height <= 0) return false;
  const moved = dir === "up" ? close - confirmation : confirmation - close;
  // Past the measured move → late/exhausted (chasing).
  return atLeast(moved, height);
}

function timingForBreak(status: PatternStatus): PatternEntryTiming {
  switch (status) {
    case "confirmed":
      return "clean";
    case "forming":
      return "early";
    case "exhausted":
      return "dangerous";
    default:
      return "none";
  }
}

function breakoutRisk(status: PatternStatus, confirmations: number): PatternRiskBand {
  if (status === "forming") return confirmations >= 2 ? "medium" : "high";
  if (status === "confirmed") return confirmations >= 2 ? "low" : "medium";
  return "high";
}

function symmetryScore(a: number, b: number, atrVal: number | null): number {
  const diff = Math.abs(a - b);
  if (atrVal && atrVal > 0) {
    const ratio = diff / atrVal; // 0 = perfect symmetry
    return clamp(75 - ratio * 40, 30, 90);
  }
  const base = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return clamp(75 - (diff / base) * 10000, 30, 90);
}

function lowestBetween(pts: Swing[], from: number, to: number): Swing | undefined {
  return pts.filter((p) => p.index > from && p.index < to).sort((a, b) => a.price - b.price)[0];
}
function highestBetween(pts: Swing[], from: number, to: number): Swing | undefined {
  return pts.filter((p) => p.index > from && p.index < to).sort((a, b) => b.price - a.price)[0];
}

function lastTwo<T>(xs: T[]): [T | undefined, T | undefined] {
  return [xs[xs.length - 2], xs[xs.length - 1]];
}
function lastThree<T>(xs: T[]): [T | undefined, T | undefined, T | undefined] {
  return [xs[xs.length - 3], xs[xs.length - 2], xs[xs.length - 1]];
}
function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

const DETECTORS: Detector[] = [
  detectHeadAndShoulders,
  detectDoubleReversal,
  detectFlag,
  detectLiquiditySweep,
  detectBreakoutRetest,
  detectEngulfing,
  detectPinBar,
  detectScalpFlare,
];
