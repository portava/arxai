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
import { atr, clamp, findSwings, round, type Swing } from "./chartMath.js";

export interface PatternEngineResult {
  patterns: DetectedPattern[];
  /** Closed candles considered (post-filter). */
  candlesConsidered: number;
  /** True when the window was too short for ANY pattern (fail closed). */
  insufficient: boolean;
}

// Smallest window any detector here can act on. Below this we emit nothing.
const GLOBAL_MIN_CANDLES = 20;
const SWING_SPAN = 2;

/**
 * Detect chart patterns on a window of CLOSED, normalized candles. Forming bars
 * must be filtered by the caller (we still defensively drop a trailing forming
 * candle). Returns an empty pattern set when the window is too short.
 * The narrow scope shares the same detector/context and is for causal H&S
 * prefix discovery. Default callers still receive the complete catalogue.
 */
export function detectChartPatterns(
  candles: ChartPatternCandle[],
  scope: "all" | "head-and-shoulders" = "all",
): PatternEngineResult {
  const closed = candles.filter((c) => c.isComplete && !c.isForming);
  if (closed.length < GLOBAL_MIN_CANDLES) {
    return { patterns: [], candlesConsidered: closed.length, insufficient: true };
  }

  const swings = findSwings(closed, SWING_SPAN);
  const atrVal = atr(closed, Math.min(14, closed.length - 1));
  const last = closed[closed.length - 1]!;
  const decimals = decimalsFor(last.close);

  const ctx: DetectorContext = { closed, swings, atr: atrVal, last, decimals };

  const patterns: DetectedPattern[] = [];
  for (const detector of scope === "head-and-shoulders" ? HEAD_AND_SHOULDERS_DETECTORS : DETECTORS) {
    const found = detector(ctx);
    if (found) patterns.push(found);
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

/** Relative closeness of two prices, normalized by ATR when available. */
function near(a: number, b: number, atrVal: number | null, tolAtr = 0.5): boolean {
  if (atrVal && atrVal > 0) return Math.abs(a - b) <= tolAtr * atrVal;
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
  return (n * sxy - sx * sy) / denom;
}

function qualityFromScore(score: number): PatternQuality {
  if (score >= 75) return "high";
  if (score >= 55) return "medium";
  if (score >= 35) return "low";
  return "none";
}

function r(n: number, decimals: number): number {
  return round(n, decimals);
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
      const headIsHighest = head.price > lShoulder.price && head.price > rShoulder.price;
      const shouldersLevel = near(lShoulder.price, rShoulder.price, atrVal, 0.6);
      if (headIsHighest && shouldersLevel) {
        const troughs = ls
          .filter((t) => t.index > lShoulder.index && t.index < rShoulder.index)
          .sort((a, b) => a.index - b.index);
        if (troughs.length >= 1) {
          const neckline = mean(troughs.map((t) => t.price));
          const height = head.price - neckline;
          if (height > 0) {
            const broke = last.close < neckline;
            const status: PatternStatus = broke
              ? extensionExhausted(last.close, neckline, height, "down")
                ? "exhausted"
                : "confirmed"
              : last.close > head.price
                ? "invalidated"
                : "forming";
            const score = symmetryScore(lShoulder.price, rShoulder.price, atrVal) +
              (troughs.length >= 2 ? 10 : 0);
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
                { index: troughs[0]!.index, price: r(neckline, decimals), role: "neckline" },
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
      const headIsLowest = head.price < lShoulder.price && head.price < rShoulder.price;
      const shouldersLevel = near(lShoulder.price, rShoulder.price, atrVal, 0.6);
      if (headIsLowest && shouldersLevel) {
        const peaks = hs
          .filter((t) => t.index > lShoulder.index && t.index < rShoulder.index)
          .sort((a, b) => a.index - b.index);
        if (peaks.length >= 1) {
          const neckline = mean(peaks.map((t) => t.price));
          const height = neckline - head.price;
          if (height > 0) {
            const broke = last.close > neckline;
            const status: PatternStatus = broke
              ? extensionExhausted(last.close, neckline, height, "up")
                ? "exhausted"
                : "confirmed"
              : last.close < head.price
                ? "invalidated"
                : "forming";
            const score = symmetryScore(lShoulder.price, rShoulder.price, atrVal) +
              (peaks.length >= 2 ? 10 : 0);
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
                { index: peaks[0]!.index, price: r(neckline, decimals), role: "neckline" },
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

/** ARX convention (not another platform's algorithm): strict 2/2 pivots,
 * adjacent same-kind pairs, deepest intermediate opposite pivot, 0.5 frozen ATR
 * equality, and the higher top/lower bottom as invalidation. Search the latest
 * 600 observed bars and newest 12 pairs per direction. Newest eligible formation
 * wins; equal formation times prefer the top. No recursive prefix detection.
 * The five-close preceding-trend geometry matches the candle catalogue, but
 * this input has no timestamps: continuity/clock qualification belongs upstream.
 */
function detectDoubleReversal(ctx: DetectorContext): DetectedPattern | null {
  const { closed, swings, last } = ctx;
  const MIN = 24;
  if (closed.length < MIN) return null;
  const windowStart = Math.max(0, closed.length - 600);
  const hs = highs(swings).filter(p => p.index >= windowStart + SWING_SPAN);
  const ls = lows(swings).filter(p => p.index >= windowStart + SWING_SPAN);
  let chosen: DetectedPattern | null = null;
  let chosenKnown = -1, chosenSecond = -1;
  for (const top of [true, false]) {
    const same = top ? hs : ls, opposite = top ? ls : hs;
    for (let pair = Math.max(1, same.length - 12); pair < same.length; pair++) {
      const a = same[pair - 1]!, b = same[pair]!;
      const known = Math.max(b.index + SWING_SPAN, MIN - 1);
      if (known >= closed.length || known - 14 < windowStart || a.index - 5 < windowStart) continue;
      const from = a.index - 5, to = a.index - 1;
      const change = closed[to]!.close - closed[from]!.close;
      let aligned = 0, averageRange = 0;
      for (let i = from; i <= to; i++) {
        averageRange += (closed[i]!.high - closed[i]!.low) / 5;
        if (i > from && (top ? closed[i]!.close > closed[i - 1]!.close : closed[i]!.close < closed[i - 1]!.close)) aligned++;
      }
      if (averageRange <= 0 || aligned < 3 || Math.abs(change) < averageRange * .5 || (top ? change <= 0 : change >= 0)) continue;
      // At most 15 bars: this ATR cannot be rewritten by an appended candle.
      const frozenAtr = atr(closed.slice(known - 14, known + 1), 14);
      if (!(frozenAtr != null && frozenAtr > 0) || !near(a.price, b.price, frozenAtr, .5)) continue;
      let middle: Swing | undefined;
      for (const p of opposite) {
        if (p.index <= a.index || p.index >= b.index) continue;
        if (!middle || (top ? p.price < middle.price : p.price > middle.price)) middle = p;
      }
      if (!middle) continue;
      const neckline = middle.price;
      const invalidation = top ? Math.max(a.price, b.price) : Math.min(a.price, b.price);
      const height = top ? invalidation - neckline : neckline - invalidation;
      if (!(height > 0)) continue;
      const invalid = (price: number) => top ? price > invalidation : price < invalidation;
      // A shape already invalidated before minimum history was available is
      // not newly created at bar 24. No backdated lifecycle event is emitted.
      let alreadyInvalid = false;
      for (let i = b.index + 1; i <= known; i++) if (invalid(closed[i]!.close)) { alreadyInvalid = true; break; }
      if (alreadyInvalid) continue;
      let confirmedIndex: number | null = null, failedIndex: number | null = null;
      for (let i = known + 1; i < closed.length; i++) {
        const price = closed[i]!.close, previous = closed[i - 1]!.close;
        if (invalid(price)) { failedIndex = i; break; }
        if (confirmedIndex === null && (top ? previous >= neckline && price < neckline : previous <= neckline && price > neckline)) confirmedIndex = i;
      }
      const status: PatternStatus = failedIndex !== null ? "invalidated"
        : confirmedIndex === null ? "forming"
        : extensionExhausted(last.close, neckline, height, top ? "down" : "up") ? "exhausted" : "confirmed";
      const decimals = decimalsFor(closed[known]!.close);
      const score = symmetryScore(a.price, b.price, frozenAtr);
      // Stable geometry and quality belong to the formation, not latest ATR.
      const result: DetectedPattern = {
        id: top ? "double_top" : "double_bottom", name: top ? "Double Top" : "Double Bottom",
        category: "reversal", bias: top ? "bearish" : "bullish", status,
        confidence: clamp(score), quality: qualityFromScore(score),
        levels: { confirmation: r(neckline, decimals), invalidation: r(invalidation, decimals), targets: [r(neckline + (top ? -height : height), decimals)] },
        keyPoints: [
          { index: a.index, price: r(a.price, decimals), role: top ? "first_top" : "first_bottom" },
          { index: middle.index, price: r(neckline, decimals), role: "neckline" },
          { index: b.index, price: r(b.price, decimals), role: top ? "second_top" : "second_bottom" },
        ],
        doubleReversalLifecycle: {
          version: "causal-double-reversal-v1", formationIndexes: [a.index, middle.index, b.index],
          formationKnownAtIndex: known, confirmedIndex, failedIndex, frozenAtr,
          referenceLevel: neckline, invalidationLevel: invalidation,
          priorTrend: { fromIndex: from, toIndex: to, closeChange: change, alignedSteps: aligned },
        },
        rationale: [top ? "Two highs at a similar level followed a preceding rise." : "Two lows at a similar level followed a preceding decline."],
        failureModes: [top ? "A close above the higher top invalidates the top." : "A close below the lower bottom invalidates the bottom."],
        minCandles: MIN, entryTiming: timingForBreak(status), falseBreakoutRisk: breakoutRisk(status, 1),
      };
      if (known > chosenKnown || (known === chosenKnown && b.index > chosenSecond)) {
        chosen = result; chosenKnown = known; chosenSecond = b.index;
      }
    }
  }
  return chosen;
}

// ── Bull / bear flag — continuation ──────────────────────────────────────────

/** ARX fixed-window convention, not platform parity: 8 pole bars, then 6
 * flag bars in a parallel counter-trend channel, with minimum 20 observations.
 * Inspect at most the latest 600 closed bars. The first qualifying formation
 * owns its bars; overlapping rolling windows cannot replace/rewrite it. A new
 * qualifying formation may replace it only when its pole starts after the old
 * formation ends. The fit, ATR, precision and geometric score freeze at known.
 */
function detectFlag(ctx: DetectorContext): DetectedPattern | null {
  const { closed } = ctx;
  const MIN = 20, POLE = 8, FLAG = 6;
  if (closed.length < MIN) return null;
  const windowStart = Math.max(0, closed.length - 600);
  type Formation = { poleStart: number; poleEnd: number; flagStart: number; known: number; bullish: boolean; poleMove: number; frozenAtr: number; channelSlope: number; upper: number; lower: number };
  // Subtract the local price origin before covariance. Raw-price sums lose
  // slope precision on high-priced instruments or small FX movements.
  const centeredFlagSlope = (values: number[]) => slope(values.map(value => value - values[0]!));
  let formation: Formation | null = null;
  for (let known = Math.max(MIN - 1, windowStart + 14); known < closed.length; known++) {
    const poleStart = known - POLE - FLAG + 1, poleEnd = poleStart + POLE - 1, flagStart = poleEnd + 1;
    if (formation && poleStart <= formation.known) continue;
    const pole = closed.slice(poleStart, poleEnd + 1), flag = closed.slice(flagStart, known + 1);
    const poleMove = pole[POLE - 1]!.close - pole[0]!.close;
    const bullish = poleMove > 0;
    const poleRange = Math.max(...pole.map(c => c.high)) - Math.min(...pole.map(c => c.low));
    const frozenAtr = atr(closed.slice(known - 14, known + 1), 14);
    if (!(frozenAtr != null && frozenAtr > 0) || Math.abs(poleMove) < 2 * frozenAtr || poleRange <= 0) continue;
    // A single gap is not a sustained pole: at least five of seven close steps
    // must align with the measured impulse. No calibrated probability implied.
    let aligned = 0;
    for (let i = 1; i < POLE; i++) if (bullish ? pole[i]!.close > pole[i - 1]!.close : pole[i]!.close < pole[i - 1]!.close) aligned++;
    if (aligned < 5) continue;
    const flagHigh = Math.max(...flag.map(c => c.high)), flagLow = Math.min(...flag.map(c => c.low));
    const depth = bullish ? pole[POLE - 1]!.close - flagLow : flagHigh - pole[POLE - 1]!.close;
    if (flagHigh - flagLow > poleRange * .6 || depth > Math.abs(poleMove) * .6) continue;
    // Price gaps between the pole and flag, or inside it, are not a continuous
    // consolidation channel. Clock/session continuity remains caller-owned.
    let gap = false;
    for (let i = flagStart; i <= known; i++) if (closed[i]!.low > closed[i - 1]!.high || closed[i]!.high < closed[i - 1]!.low) { gap = true; break; }
    if (gap) continue;
    const channelSlope = centeredFlagSlope(flag.map(c => c.close));
    if (bullish ? channelSlope > 0 : channelSlope < 0) continue;
    const upper = Math.max(...flag.map((c, i) => c.high - channelSlope * i));
    const lower = Math.min(...flag.map((c, i) => c.low - channelSlope * i));
    const width = upper - lower;
    // Independently fitted high/low trends must remain approximately parallel:
    // divergence over the 5 intervals <= 1/4 channel width and <= 1/2 ATR.
    const divergence = Math.abs(centeredFlagSlope(flag.map(c => c.high)) - centeredFlagSlope(flag.map(c => c.low))) * (FLAG - 1);
    if (!(width > 0) || divergence > Math.min(width * .25, frozenAtr * .5)) continue;
    formation = { poleStart, poleEnd, flagStart, known, bullish, poleMove, frozenAtr, channelSlope, upper, lower };
  }
  if (!formation) return null;
  const f = formation;
  const upperAt = (index: number) => f.upper + f.channelSlope * (index - f.flagStart);
  const lowerAt = (index: number) => f.lower + f.channelSlope * (index - f.flagStart);
  const triggerAt = (index: number) => f.bullish ? upperAt(index) : lowerAt(index);
  const oppositeAt = (index: number) => f.bullish ? lowerAt(index) : upperAt(index);
  const targetAt = (index: number): number | null => {
    const projected = triggerAt(index) + f.poleMove;
    return Number.isFinite(projected) && projected > 0 ? projected : null;
  };
  let confirmedIndex: number | null = null, failedIndex: number | null = null, targetReachedIndex: number | null = null;
  for (let i = f.known + 1; i < closed.length; i++) {
    const price = closed[i]!.close;
    const invalidation = oppositeAt(confirmedIndex ?? i);
    if (f.bullish ? price < invalidation : price > invalidation) { failedIndex = i; break; }
    if (confirmedIndex === null) {
      const previous = closed[i - 1]!.close;
      if (f.bullish ? previous <= triggerAt(i - 1) && price > triggerAt(i) : previous >= triggerAt(i - 1) && price < triggerAt(i)) confirmedIndex = i;
    }
    if (confirmedIndex !== null && targetReachedIndex === null) {
      const target = targetAt(confirmedIndex);
      if (target !== null && (f.bullish ? price >= target : price <= target)) targetReachedIndex = i;
    }
  }
  const levelAtIndex = confirmedIndex ?? failedIndex ?? closed.length - 1;
  const confirmation = triggerAt(levelAtIndex), invalidation = oppositeAt(levelAtIndex), target = targetAt(levelAtIndex);
  const status: PatternStatus = failedIndex !== null ? "invalidated" : targetReachedIndex !== null ? "exhausted" : confirmedIndex !== null ? "confirmed" : "forming";
  const decimals = decimalsFor(closed[f.known]!.close);
  // A valid observed shape may have no positive measured target. The channel
  // itself still needs usable reference prices, including display precision.
  if (![confirmation, invalidation, r(confirmation, decimals), r(invalidation, decimals)].every(price => Number.isFinite(price) && price > 0)) return null;
  if (target !== null && (!Number.isFinite(r(target, decimals)) || r(target, decimals) <= 0)) return null;
  const score = 50 + clamp(Math.abs(f.poleMove) / f.frozenAtr * 6, 0, 25);
  const keyPoints = [
    { index: f.poleStart, price: r(closed[f.poleStart]!.close, decimals), role: "flagpole_start" },
    { index: f.poleEnd, price: r(closed[f.poleEnd]!.close, decimals), role: "flagpole_end" },
    { index: f.flagStart, price: r(closed[f.flagStart]!.close, decimals), role: "flag_start" },
    { index: f.known, price: r(closed[f.known]!.close, decimals), role: "flag_end" },
  ];
  if (confirmedIndex !== null) keyPoints.push({ index: confirmedIndex, price: r(closed[confirmedIndex]!.close, decimals), role: "flag_break" });
  if (failedIndex !== null) keyPoints.push({ index: failedIndex, price: r(closed[failedIndex]!.close, decimals), role: "flag_failure" });
  return {
    id: f.bullish ? "bull_flag" : "bear_flag", name: f.bullish ? "Bull Flag" : "Bear Flag", category: "continuation", bias: f.bullish ? "bullish" : "bearish", status,
    confidence: clamp(score), quality: qualityFromScore(score),
    levels: { confirmation: r(confirmation, decimals), invalidation: r(invalidation, decimals), targets: target === null ? [] : [r(target, decimals)] },
    keyPoints,
    flagLifecycle: { version: "causal-flag-v1", poleStartIndex: f.poleStart, poleEndIndex: f.poleEnd, flagStartIndex: f.flagStart, formationKnownAtIndex: f.known, channelSlope: f.channelSlope, upperAtStart: f.upper, lowerAtStart: f.lower, frozenAtr: f.frozenAtr, confirmedIndex, failedIndex, targetReachedIndex, levelAtIndex, targetLevel: target, confirmationLevel: confirmation, invalidationLevel: invalidation },
    rationale: [
      `A measured ${f.bullish ? "rise" : "decline"} was followed by a shallow parallel counter-trend channel.`,
      ...(target === null ? ["No positive-price measured target is available for this formation."] : []),
      failedIndex !== null ? "A later closed price invalidated this formation; a price recovery does not restore it."
        : targetReachedIndex !== null ? "A closed price reached the measured-move projection after the channel break. This does not establish a profitable trade."
        : confirmedIndex !== null ? "A later closed price crossed the frozen channel. This observation does not establish what price will do next."
        : "The channel is developing; no later closed-price breakout is confirmed. Its projected boundaries move with the frozen slope.",
    ],
    failureModes: ["A close through the opposite channel boundary invalidates the formation; after a break, that boundary is fixed at the breakout bar."],
    minCandles: MIN, entryTiming: timingForBreak(status), falseBreakoutRisk: breakoutRisk(status, 1),
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

  // Bearish sweep: wick takes prior high, closes back below it.
  if (priorHigh && target.high > priorHigh.price && target.close < priorHigh.price) {
    const pierce = target.high - priorHigh.price;
    if (pierce >= 0.1 * atrVal) {
      const score = 50 + clamp((pierce / atrVal) * 30, 0, 25);
      return sweepPattern({
        id: "liquidity_sweep_high",
        name: "Liquidity Sweep (high)",
        bias: "bearish",
        swept: priorHigh.price,
        close: last.close,
        invalidation: target.high,
        target: priorLow?.price ?? last.close - 2 * atrVal,
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
    if (pierce >= 0.1 * atrVal) {
      const score = 50 + clamp((pierce / atrVal) * 30, 0, 25);
      return sweepPattern({
        id: "liquidity_sweep_low",
        name: "Liquidity Sweep (low)",
        bias: "bullish",
        swept: priorLow.price,
        close: last.close,
        invalidation: target.low,
        target: priorHigh?.price ?? last.close + 2 * atrVal,
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
  const { closed, swings } = ctx;
  if (closed.length < 24) return null;
  // Sort once. Filtering by knowledge time preserves price ordering, allowing
  // linear sliding cluster windows for each of at most 12 candidate closes.
  const byPrice = (a: Swing, b: Swing) => a.price - b.price || a.index - b.index;
  const resistance = highs(swings).sort(byPrice), support = lows(swings).sort(byPrice);
  let selected: DetectedPattern | null = null;
  for (let index = Math.max(23, closed.length - 12); index < closed.length; index++) {
    const failure = selected?.breakoutLifecycle?.failedIndex;
    // An active event owns its frozen level. A later event requires a fresh
    // crossing after failure, never a rewrite/resurrection of the old event.
    // We do not assume intrabar ordering on the failure candle itself.
    if (selected && (failure == null || index <= failure)) continue;
    const prior = closed.slice(Math.max(0, index - 15), index);
    const frozenAtr = atr(prior, Math.min(14, prior.length - 1));
    if (!frozenAtr || !Number.isFinite(frozenAtr) || frozenAtr <= 0) continue;
    for (const breakAbove of [true, false]) {
      // A span-two pivot requires two later CLOSED observations, both strictly
      // before the candidate crossing. Future pivots cannot invent its level.
      const eligible = (breakAbove ? resistance : support).filter(p => p.index + SWING_SPAN < index);
      const cluster = clusteredLevel(eligible, frozenAtr);
      if (!cluster) continue;
      const threshold = cluster.price + (breakAbove ? 1 : -1) * 0.3 * frozenAtr;
      const previous = closed[index - 1]!.close, now = closed[index]!.close;
      const crossed = breakAbove ? previous <= threshold && now > threshold : previous >= threshold && now < threshold;
      if (!crossed) continue;
      selected = breakoutRetestFor({ ...cluster, breakAbove, closed, atrVal: frozenAtr, breakIdx: index });
      break; // deterministic direction tie: bullish first, never emit both.
    }
  }
  return selected;
}

/** Input is price-sorted. Most touches wins, then most recently confirmed
 * formation, then most recent cluster anchor. Equal-price ties are index-sorted.
 * Every eligible swing is prior-only; no swing-count truncation changes levels. */
function clusteredLevel(pts: Swing[], atrVal: number): { price: number; touches: number; formationIndexes: number[] } | null {
  if (pts.length < 2) return null;
  const tolerance = 0.4 * atrVal;
  let left = 0, right = 0, sum = 0, head = 0;
  const latest: number[] = [];
  let best: { from: number; to: number; price: number; known: number; anchor: number } | null = null;
  for (const anchor of pts) {
    while (right < pts.length && pts[right]!.price <= anchor.price + tolerance) {
      sum += pts[right]!.price;
      while (latest.length > head && pts[latest[latest.length - 1]!]!.index <= pts[right]!.index) latest.pop();
      latest.push(right++);
    }
    while (left < right && pts[left]!.price < anchor.price - tolerance) {
      sum -= pts[left]!.price;
      if (latest[head] === left) head++;
      left++;
    }
    const count = right - left;
    if (count < 2) continue;
    const known = pts[latest[head]!]!.index;
    const bestCount: number = best ? best.to - best.from : 0;
    if (!best || count > bestCount || count === bestCount && (known > best.known || known === best.known && anchor.index > best.anchor)) {
      best = { from: left, to: right, price: sum / count, known, anchor: anchor.index };
    }
  }
  return best ? { price: best.price, touches: best.to - best.from, formationIndexes: pts.slice(best.from, best.to).map(p => p.index).sort((a, b) => a - b) } : null;
}

function breakoutRetestFor(args: {
  price: number; touches: number; formationIndexes: number[]; breakAbove: boolean;
  closed: ChartPatternCandle[]; atrVal: number; breakIdx: number;
}): DetectedPattern {
  const { price: level, touches, formationIndexes, breakAbove, closed, atrVal, breakIdx } = args;
  const last = closed[closed.length - 1]!, decimals = decimalsFor(closed[breakIdx]!.close);
  const buffer = 0.3 * atrVal, tolerance = 0.5 * atrVal;
  let retestIdx: number | null = null, confirmedIdx: number | null = null, failedIdx: number | null = null;
  for (let index = breakIdx + 1; index < closed.length; index++) {
    const candle = closed[index]!;
    const touched = candle.low <= level + tolerance && candle.high >= level - tolerance;
    if (retestIdx === null && touched) retestIdx = index;
    // Failure precedes confirmation on the same OHLC observation. We cannot
    // infer a successful hold earlier within a bar that closed beyond failure.
    if (breakAbove ? candle.close < level - buffer : candle.close > level + buffer) { failedIdx = index; break; }
    if (confirmedIdx === null && retestIdx !== null && (breakAbove ? candle.close > level : candle.close < level)) confirmedIdx = index;
  }
  const retestCandle = retestIdx === null ? null : closed[retestIdx]!;
  const height = atrVal * 2;
  const confirmation = r(level, decimals);
  const invalidation = r(level + (breakAbove ? -buffer : buffer), decimals);
  const target = r(level + (breakAbove ? height : -height), decimals);
  const status: PatternStatus = failedIdx !== null ? "failed" : confirmedIdx !== null
    ? extensionExhausted(last.close, level, height, breakAbove ? "up" : "down") ? "exhausted" : "confirmed" : "forming";
  const score = 45 + (touches >= 3 ? 15 : 8) + (retestIdx !== null ? 12 : 0);
  return {
    id: breakAbove ? "breakout_retest_up" : "breakout_retest_down",
    name: breakAbove ? "Resistance Breakout & Retest" : "Support Breakdown & Retest",
    category: "breakout_retest", bias: breakAbove ? "bullish" : "bearish", status,
    confidence: clamp(score), quality: qualityFromScore(score),
    levels: { confirmation, invalidation, targets: [target] },
    keyPoints: [{ index: breakIdx, price: confirmation, role: "broken_level" },
      ...(retestCandle && retestIdx !== null ? [{ index: retestIdx, price: Math.max(retestCandle.low, Math.min(retestCandle.high, level)), role: "retest" }] : [])],
    breakoutLifecycle: {
      version: "causal-breakout-v1", formationIndexes,
      levelKnownAtIndex: Math.max(...formationIndexes) + SWING_SPAN,
      breakIndex: breakIdx, retestIndex: retestIdx, confirmedIndex: confirmedIdx, failedIndex: failedIdx,
      frozenAtr: atrVal, referenceLevel: level, breakBuffer: buffer, retestTolerance: tolerance,
    },
    rationale: [
      `Tested ${breakAbove ? "resistance" : "support"} (${touches} prior confirmed touches) broke and ${retestIdx !== null ? "retested" : failedIdx !== null ? "failed before a retest" : "has not retested yet"}.`,
      "Level, touches and ATR are frozen before the crossing; the target projects two of that frozen ATR from the level.",
      "Discovery uses the latest 12 closes, with at least 24 observations at crossing. The earliest active event is retained; only a new crossing after failure replaces it. Cluster ties prefer the most-tested then most-recent formation; a direction tie prefers bullish.",
    ],
    failureModes: [`A close ${breakAbove ? "below" : "above"} the level by more than 0.3 of the frozen ATR marks failure; later recovery does not revive the same event.`],
    minCandles: 24, entryTiming: timingForBreak(status), falseBreakoutRisk: breakoutRisk(status, retestIdx !== null ? 2 : 1),
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
  if (lastBody < prevBody) return null; // last body must dominate

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
  if (lowerWick >= 2 * bodyRef && upperWick <= bodyRef && trendSlope < 0) {
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
  if (upperWick >= 2 * bodyRef && lowerWick <= bodyRef && trendSlope > 0) {
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
  const compressed = baseRangeMax <= 0.8 * atrVal;
  if (!compressed) return null;

  const flareRange = last.high - last.low;
  const flareBody = Math.abs(last.close - last.open);
  // Expansion: a wide-range candle with a dominant directional body.
  const expanded = flareRange >= 1.5 * atrVal && flareBody >= 0.6 * flareRange;
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
  const status: PatternStatus = extension >= 3 * atrVal ? "exhausted" : "confirmed";

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
  return moved >= height;
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

const HEAD_AND_SHOULDERS_DETECTORS: readonly Detector[] = [detectHeadAndShoulders];
