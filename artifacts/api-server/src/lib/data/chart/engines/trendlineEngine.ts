// ── TRENDLINE DETECTION ENGINE (Task #649, Phase 2) ──────────────────────────
//
// Pure, deterministic geometric detector for TRENDLINES (diagonal support /
// resistance, parallel channels, horizontal range edges) plus the discrete
// trendline change-event and the higher-order trend/pattern-change that the
// window implies. It consumes the normalized closed-candle window from the truth
// layer and the shared chart-math primitives, and emits the raw, pre-display-fold
// shapes defined by the domain display contract (`@workspace/domain/market`):
// `ActiveTrendline[]` + a `TrendlineChange` + a `PatternChange`.
//
// It NEVER fabricates: below the global minimum candle count it returns an honest
// empty result (`insufficient: true`). Same candles ⇒ same output.
//
// SAFETY: this module only MEASURES geometry. It carries no feed/execution
// knowledge and no display caps — `resolveTrendlineTruth` (domain) folds the
// feed/sufficiency facts and applies every display cap downstream. The detector
// therefore imports ONLY the display-side TYPES from the domain barrel, never any
// execution/safety surface. A "break" requires a decisive CLOSE beyond the line
// by an ATR-normalized distance — never a wick-only pierce.

import type {
  ActiveTrendline,
  PatternChange,
  PatternChangeKind,
  TrendlineBias,
  TrendlineCategory,
  TrendlineChange,
  TrendlineChangeKind,
  TrendlineKeyPoint,
  TrendlineQuality,
  TrendlineRiskBand,
  TrendlineStatus,
  TrendPosture,
} from "@workspace/domain/market";
import type { NormalizedChartCandle } from "../candleNormalization.js";
import { atr, clamp, decimalsFor, findSwings, round, type Swing } from "./chartMath.js";

export interface TrendlineEngineResult {
  trendlines: ActiveTrendline[];
  trendlineChange: TrendlineChange;
  patternChange: PatternChange;
  /** Closed candles considered (post-filter). */
  candlesConsidered: number;
  /** True when the window was too short for ANY trendline (fail closed). */
  insufficient: boolean;
}

// Smallest window the detector can act on. Below this we emit nothing.
const GLOBAL_MIN_CANDLES = 20;
const SWING_SPAN = 2;
// A break is a CLOSE beyond the line by ≥ this many ATR (never wick-only).
const BREAK_ATR_MULT = 0.25;
// A swing counts as a touch when within this many ATR of the fitted line.
const TOUCH_TOL_ATR = 0.5;
// |slope-per-bar| below this many ATR is treated as flat (horizontal).
const FLAT_SLOPE_ATR = 0.04;
// Distance (in ATR) beyond which a respected line's run is "exhausted".
const EXHAUST_ATR_MULT = 3;
// How many recent bars a break/retest/reclaim is considered "fresh".
const RECENT_WINDOW = 4;

const NONE_CHANGE: TrendlineChange = {
  kind: "none",
  bias: "neutral",
  reason: null,
  confirmationLevel: null,
  invalidationLevel: null,
  confirmed: false,
};

const NONE_PATTERN_CHANGE: PatternChange = {
  kind: "none",
  from: "unknown",
  to: "unknown",
  reason: null,
  confirmationLevel: null,
  invalidationLevel: null,
};

/**
 * Detect trendlines on a window of CLOSED, normalized candles. A trailing forming
 * bar is defensively dropped. Returns an honest empty result when the window is
 * too short for any trendline.
 */
export function detectTrendlines(
  candles: NormalizedChartCandle[],
): TrendlineEngineResult {
  const closed = candles.filter((c) => c.isComplete && !c.isForming);
  if (closed.length < GLOBAL_MIN_CANDLES) {
    return {
      trendlines: [],
      trendlineChange: NONE_CHANGE,
      patternChange: NONE_PATTERN_CHANGE,
      candlesConsidered: closed.length,
      insufficient: true,
    };
  }

  const swings = findSwings(closed, SWING_SPAN);
  const atrVal = atr(closed, Math.min(14, closed.length - 1));
  const last = closed[closed.length - 1]!;
  const lastIndex = closed.length - 1;
  const decimals = decimalsFor(last.close);

  if (!atrVal || atrVal <= 0) {
    // Without a usable ATR we cannot normalize geometry honestly.
    return {
      trendlines: [],
      trendlineChange: NONE_CHANGE,
      patternChange: NONE_PATTERN_CHANGE,
      candlesConsidered: closed.length,
      insufficient: false,
    };
  }

  const ctx: EngineContext = { closed, swings, atr: atrVal, last, lastIndex, decimals };

  const lowSwings = swings.filter((s) => s.kind === "low");
  const highSwings = swings.filter((s) => s.kind === "high");

  // Fit candidate rails across the most recent swing lows / highs.
  const lowLine = fitTrendline(takeLast(lowSwings, 4));
  const highLine = fitTrendline(takeLast(highSwings, 4));

  const trendlines: ActiveTrendline[] = [];

  // ── Channel (both rails sloped the same way and roughly parallel) ───────────
  const channel = detectChannel(ctx, lowLine, highLine);
  if (channel) {
    trendlines.push(channel);
  } else {
    // ── Support rail from the swing lows ──────────────────────────────────────
    if (lowLine && lowLine.touchCount >= 2) {
      const support = buildLine(ctx, lowLine, "support");
      if (support) trendlines.push(support);
    }
    // ── Resistance rail from the swing highs ─────────────────────────────────
    if (highLine && highLine.touchCount >= 2) {
      const resistance = buildLine(ctx, highLine, "resistance");
      if (resistance) trendlines.push(resistance);
    }
  }

  const dominant = trendlines[0] ?? null;
  const trendlineChange = dominant ? buildTrendlineChange(dominant) : NONE_CHANGE;
  const patternChange = buildPatternChange(ctx, trendlines, lowSwings, highSwings);

  return {
    trendlines,
    trendlineChange,
    patternChange,
    candlesConsidered: closed.length,
    insufficient: false,
  };
}

// ── Internal plumbing ────────────────────────────────────────────────────────

interface EngineContext {
  closed: NormalizedChartCandle[];
  swings: Swing[];
  atr: number;
  last: NormalizedChartCandle;
  lastIndex: number;
  decimals: number;
}

interface FittedLine {
  slope: number;
  intercept: number;
  points: Swing[];
  /** Swings within tolerance of the fitted line. */
  touchCount: number;
}

type Side = "support" | "resistance";

function takeLast<T>(xs: T[], n: number): T[] {
  return xs.length <= n ? xs : xs.slice(xs.length - n);
}

/** Ordinary-least-squares fit of price against candle index for the swing set. */
function fitTrendline(points: Swing[]): FittedLine | null {
  if (points.length < 2) return null;
  const n = points.length;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sx += p.index;
    sy += p.price;
    sxy += p.index * p.price;
    sxx += p.index * p.index;
  }
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept, points, touchCount: points.length };
}

function lineAt(line: FittedLine, index: number): number {
  return line.slope * index + line.intercept;
}

/** Count swings (of either kind) within tolerance of the fitted line. */
function countTouches(line: FittedLine, swings: Swing[], atrVal: number): number {
  const tol = TOUCH_TOL_ATR * atrVal;
  let count = 0;
  for (const s of swings) {
    if (Math.abs(s.price - lineAt(line, s.index)) <= tol) count += 1;
  }
  return count;
}

function flat(line: FittedLine, atrVal: number): boolean {
  return Math.abs(line.slope) <= FLAT_SLOPE_ATR * atrVal;
}

function rising(line: FittedLine, atrVal: number): boolean {
  return line.slope > FLAT_SLOPE_ATR * atrVal;
}

function falling(line: FittedLine, atrVal: number): boolean {
  return line.slope < -FLAT_SLOPE_ATR * atrVal;
}

/**
 * Detect a parallel channel: both rails sloped the same direction with similar
 * magnitude and enough combined touches. Returns null otherwise.
 */
function detectChannel(
  ctx: EngineContext,
  lowLine: FittedLine | null,
  highLine: FittedLine | null,
): ActiveTrendline | null {
  if (!lowLine || !highLine) return null;
  const { atr: atrVal } = ctx;
  const bothUp = rising(lowLine, atrVal) && rising(highLine, atrVal);
  const bothDown = falling(lowLine, atrVal) && falling(highLine, atrVal);
  if (!bothUp && !bothDown) return null;
  // Slopes must be roughly parallel.
  const a = Math.abs(lowLine.slope);
  const b = Math.abs(highLine.slope);
  const ratio = a === 0 || b === 0 ? Infinity : Math.max(a, b) / Math.min(a, b);
  if (ratio > 2.2) return null;
  if (lowLine.touchCount + highLine.touchCount < 4) return null;

  const bullish = bothUp;
  const id = bullish ? "ascending_channel" : "descending_channel";
  const name = bullish ? "Ascending Channel" : "Descending Channel";
  const bias: TrendlineBias = bullish ? "bullish" : "bearish";
  // The actionable rail is the support (bottom) for an up-channel, the
  // resistance (top) for a down-channel; status keys off it.
  const rail = bullish ? lowLine : highLine;
  const oppRail = bullish ? highLine : lowLine;
  const side: Side = bullish ? "support" : "resistance";
  const status = lineStatus(ctx, rail, side);
  const level = lineAt(rail, ctx.lastIndex);
  const oppLevel = lineAt(oppRail, ctx.lastIndex);
  const touchCount = rail.touchCount + oppRail.touchCount;
  const { confirmation, invalidation, targets } = railLevels(ctx, rail, oppRail, side, status);
  const score = scoreLine(touchCount, status, true);

  return {
    id,
    name,
    category: "channel" as TrendlineCategory,
    bias,
    status,
    confidence: clamp(score),
    quality: qualityFromScore(score),
    touchCount,
    slope: round(rail.slope, ctx.decimals + 2),
    currentLevel: round(level, ctx.decimals),
    levels: { confirmation, invalidation, targets },
    keyPoints: railKeyPoints(ctx, rail, oppRail),
    rationale: [
      `Two roughly parallel ${bullish ? "rising" : "falling"} rails bound the move.`,
      `Price oscillates between ${round(oppLevel, ctx.decimals)} and ${round(level, ctx.decimals)}.`,
    ],
    failureModes: [
      "A decisive close beyond either rail breaks the channel (possible trend shift).",
      "A widening channel is less reliable than a tight, parallel one.",
    ],
    minCandles: 24,
    falseBreakoutRisk: riskFor(status, touchCount),
  };
}

/** Build a single diagonal/horizontal support or resistance line. */
function buildLine(ctx: EngineContext, line: FittedLine, side: Side): ActiveTrendline | null {
  const { atr: atrVal, swings, decimals } = ctx;
  const isFlat = flat(line, atrVal);
  const touchCount = countTouches(line, swings, atrVal);
  if (touchCount < 2) return null;

  let id: string;
  let name: string;
  let bias: TrendlineBias;
  let category: TrendlineCategory;

  if (side === "support") {
    if (isFlat) {
      id = "horizontal_support";
      name = "Horizontal Support";
      bias = "bullish";
      category = "horizontal";
    } else if (rising(line, atrVal)) {
      id = "ascending_support";
      name = "Ascending Support";
      bias = "bullish";
      category = "trend_support";
    } else {
      return null; // falling lows are not a clean bullish support
    }
  } else {
    if (isFlat) {
      id = "horizontal_resistance";
      name = "Horizontal Resistance";
      bias = "bearish";
      category = "horizontal";
    } else if (falling(line, atrVal)) {
      id = "descending_resistance";
      name = "Descending Resistance";
      bias = "bearish";
      category = "trend_resistance";
    } else {
      return null; // rising highs are not a clean bearish resistance
    }
  }

  const status = lineStatus(ctx, line, side);
  const level = lineAt(line, ctx.lastIndex);
  const { confirmation, invalidation, targets } = railLevels(ctx, line, null, side, status);
  const score = scoreLine(touchCount, status, false);

  return {
    id,
    name,
    category,
    bias,
    status,
    confidence: clamp(score),
    quality: qualityFromScore(score),
    touchCount,
    slope: round(line.slope, decimals + 2),
    currentLevel: round(level, decimals),
    levels: { confirmation, invalidation, targets },
    keyPoints: railKeyPoints(ctx, line, null),
    rationale: [
      side === "support"
        ? `${isFlat ? "Flat" : "Rising"} line across ${touchCount} swing low${touchCount === 1 ? "" : "s"}.`
        : `${isFlat ? "Flat" : "Falling"} line across ${touchCount} swing high${touchCount === 1 ? "" : "s"}.`,
      touchCount >= 3 ? "Validated by a third touch." : "Two touches — forming, not yet validated.",
    ],
    failureModes: [
      side === "support"
        ? "A decisive close below the line breaks support (possible trend shift)."
        : "A decisive close above the line breaks resistance (possible trend shift).",
    ],
    minCandles: 20,
    falseBreakoutRisk: riskFor(status, touchCount),
  };
}

/**
 * Determine the line's lifecycle status from recent closes. A break requires a
 * CLOSE beyond the line by an ATR-normalized distance (never wick-only). After a
 * break we classify retest / reclaim / failure / broken from where price sits
 * now relative to the line.
 */
function lineStatus(ctx: EngineContext, line: FittedLine, side: Side): TrendlineStatus {
  const { closed, atr: atrVal, last, lastIndex } = ctx;
  const breakDist = BREAK_ATR_MULT * atrVal;
  const touchTol = TOUCH_TOL_ATR * atrVal;

  // For support, "beyond" = close below; for resistance, "beyond" = close above.
  const beyond = (c: NormalizedChartCandle, i: number): boolean => {
    const lvl = lineAt(line, i);
    return side === "support" ? c.close < lvl - breakDist : c.close > lvl + breakDist;
  };
  const onOriginalSide = (c: NormalizedChartCandle, i: number): boolean => {
    const lvl = lineAt(line, i);
    return side === "support" ? c.close >= lvl : c.close <= lvl;
  };

  const lastLevel = lineAt(line, lastIndex);
  const lastBeyond = beyond(last, lastIndex);

  // Find the most recent decisive break within the recent window.
  let breakIndex = -1;
  for (let i = lastIndex; i >= Math.max(0, lastIndex - RECENT_WINDOW); i--) {
    if (beyond(closed[i]!, i)) {
      breakIndex = i;
      break;
    }
  }

  if (breakIndex >= 0) {
    if (lastBeyond) return "broken";
    // Price has come back to the original side after a recent break.
    const dist = Math.abs(last.close - lastLevel);
    if (breakIndex >= lastIndex - 1 && onOriginalSide(last, lastIndex) && dist >= breakDist) {
      return "failed"; // broke then snapped back across — trap / false break
    }
    if (dist <= touchTol) return "retesting"; // sitting on the line again
    return "reclaimed"; // closed back on the original side, away from the line
  }

  // No recent break — respected line. Check for over-extension (exhaustion).
  const dist = Math.abs(last.close - lastLevel);
  const respects = onOriginalSide(last, lastIndex);
  if (respects && dist >= EXHAUST_ATR_MULT * atrVal) return "exhausted";

  const touchCount = countTouches(line, ctx.swings, atrVal);
  if (touchCount >= 3 && respects) return "confirmed";
  return "forming";
}

function buildTrendlineChange(dominant: ActiveTrendline): TrendlineChange {
  const breakBias: TrendlineBias =
    dominant.bias === "bullish" ? "bearish" : dominant.bias === "bearish" ? "bullish" : "neutral";
  const conf = dominant.levels.confirmation;
  const inval = dominant.levels.invalidation;
  switch (dominant.status) {
    case "broken":
      return {
        kind: "break" as TrendlineChangeKind,
        bias: breakBias,
        reason: `${dominant.name} broke on a decisive close beyond the line.`,
        confirmationLevel: conf,
        invalidationLevel: inval,
        confirmed: true,
      };
    case "retesting":
      return {
        kind: "retest",
        bias: breakBias,
        reason: `${dominant.name} broke and price is retesting the line.`,
        confirmationLevel: conf,
        invalidationLevel: inval,
        confirmed: true,
      };
    case "reclaimed":
      return {
        kind: "reclaim",
        bias: dominant.bias,
        reason: `${dominant.name} was reclaimed — the prior break did not hold.`,
        confirmationLevel: conf,
        invalidationLevel: inval,
        confirmed: true,
      };
    case "failed":
      return {
        kind: "failure",
        bias: dominant.bias,
        reason: `${dominant.name} break failed — price reversed back across the line (trap).`,
        confirmationLevel: conf,
        invalidationLevel: inval,
        confirmed: true,
      };
    default:
      return NONE_CHANGE;
  }
}

/**
 * Derive the higher-order trend/pattern change the window implies from the
 * dominant line's status combined with the swing structure (higher lows / lower
 * highs). Conservative: emits `none` unless there is measurable evidence.
 */
function buildPatternChange(
  ctx: EngineContext,
  trendlines: ActiveTrendline[],
  lowSwings: Swing[],
  highSwings: Swing[],
): PatternChange {
  const dominant = trendlines[0];
  if (!dominant) return NONE_PATTERN_CHANGE;

  const lowerHighs = isDescending(takeLast(highSwings, 2));
  const higherLows = isAscending(takeLast(lowSwings, 2));
  const conf = dominant.levels.confirmation;
  const inval = dominant.levels.invalidation;

  // Trend shift: a confirmed break of the dominant line WITH agreeing structure.
  if (dominant.status === "broken" || dominant.status === "retesting") {
    if (dominant.bias === "bullish" && lowerHighs) {
      return mkPatternChange("trend_shift_bearish", "uptrend", "downtrend",
        "Support broke and highs are rolling over (lower highs).", conf, inval);
    }
    if (dominant.bias === "bearish" && higherLows) {
      return mkPatternChange("trend_shift_bullish", "downtrend", "uptrend",
        "Resistance broke and lows are stepping up (higher lows).", conf, inval);
    }
    // Break without confirming structure yet — early warning only.
    return mkPatternChange("reversal_warning",
      dominant.bias === "bullish" ? "uptrend" : "downtrend", "unknown",
      `${dominant.name} broke, but the new structure is not confirmed yet.`, conf, inval);
  }

  if (dominant.status === "failed") {
    return mkPatternChange("failure",
      dominant.bias === "bullish" ? "uptrend" : "downtrend",
      dominant.bias === "bullish" ? "uptrend" : "downtrend",
      `${dominant.name} break failed (trap).`, conf, inval);
  }
  if (dominant.status === "exhausted") {
    return mkPatternChange("exhaustion",
      dominant.bias === "bullish" ? "uptrend" : "downtrend",
      dominant.bias === "bullish" ? "uptrend" : "downtrend",
      `${dominant.name} move is over-extended.`, conf, inval);
  }

  // Trend → range / range → trend from the dominant line's geometry.
  if (dominant.category === "horizontal" && hadPriorTrend(ctx)) {
    return mkPatternChange("trend_to_range", "unknown", "range",
      "A prior trend has flattened into a range.", conf, inval);
  }
  if (dominant.category !== "horizontal" && wasPriorRange(ctx)) {
    return mkPatternChange("range_to_trend", "range",
      dominant.bias === "bullish" ? "uptrend" : "downtrend",
      "A prior range is breaking into a trend.", conf, inval);
  }

  return NONE_PATTERN_CHANGE;
}

function mkPatternChange(
  kind: PatternChangeKind,
  from: TrendPosture,
  to: TrendPosture,
  reason: string,
  confirmationLevel: number | null,
  invalidationLevel: number | null,
): PatternChange {
  return { kind, from, to, reason, confirmationLevel, invalidationLevel };
}

function isAscending(points: Swing[]): boolean {
  if (points.length < 2) return false;
  for (let i = 1; i < points.length; i++) {
    if (points[i]!.price <= points[i - 1]!.price) return false;
  }
  return true;
}

function isDescending(points: Swing[]): boolean {
  if (points.length < 2) return false;
  for (let i = 1; i < points.length; i++) {
    if (points[i]!.price >= points[i - 1]!.price) return false;
  }
  return true;
}

/** Earlier-half closes were clearly sloped (a prior trend existed). */
function hadPriorTrend(ctx: EngineContext): boolean {
  const { closed, atr: atrVal } = ctx;
  const half = Math.floor(closed.length / 2);
  if (half < 4) return false;
  const early = closed.slice(0, half).map((c) => c.close);
  const earlySlope = seriesSlope(early);
  return Math.abs(earlySlope) > FLAT_SLOPE_ATR * atrVal;
}

/** Earlier-half closes were flat (a prior range existed). */
function wasPriorRange(ctx: EngineContext): boolean {
  const { closed, atr: atrVal } = ctx;
  const half = Math.floor(closed.length / 2);
  if (half < 4) return false;
  const early = closed.slice(0, half).map((c) => c.close);
  const earlySlope = seriesSlope(early);
  return Math.abs(earlySlope) <= FLAT_SLOPE_ATR * atrVal;
}

function seriesSlope(values: number[]): number {
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
  return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
}

/** Confirmation / invalidation / target levels for a rail given its status. */
function railLevels(
  ctx: EngineContext,
  rail: FittedLine,
  oppRail: FittedLine | null,
  side: Side,
  status: TrendlineStatus,
): { confirmation: number | null; invalidation: number | null; targets: number[] } {
  const { atr: atrVal, lastIndex, decimals, swings } = ctx;
  const level = lineAt(rail, lastIndex);
  const breakDist = BREAK_ATR_MULT * atrVal;

  // The line itself is the decision pivot (confirmation). Invalidation is a
  // decisive close on the far side of the line.
  const confirmation = round(level, decimals);
  const invalidation =
    side === "support" ? round(level - breakDist, decimals) : round(level + breakDist, decimals);

  // Target: opposite rail if a channel, else the nearest opposing swing extreme.
  let target: number | null = null;
  if (oppRail) {
    target = round(lineAt(oppRail, lastIndex), decimals);
  } else if (side === "support") {
    const hh = swings.filter((s) => s.kind === "high").sort((a, b) => b.price - a.price)[0];
    target = hh ? round(hh.price, decimals) : round(level + 2 * atrVal, decimals);
  } else {
    const ll = swings.filter((s) => s.kind === "low").sort((a, b) => a.price - b.price)[0];
    target = ll ? round(ll.price, decimals) : round(level - 2 * atrVal, decimals);
  }
  // On a confirmed break, the target flips to the broken-through direction.
  if (status === "broken" || status === "retesting") {
    target = side === "support" ? round(level - 2 * atrVal, decimals) : round(level + 2 * atrVal, decimals);
  }
  return { confirmation, invalidation, targets: target == null ? [] : [target] };
}

function railKeyPoints(
  ctx: EngineContext,
  rail: FittedLine,
  oppRail: FittedLine | null,
): TrendlineKeyPoint[] {
  const pts: TrendlineKeyPoint[] = rail.points.map((p, i) => ({
    index: p.index,
    price: round(p.price, ctx.decimals),
    role: i === 0 ? "anchor" : "touch",
  }));
  if (oppRail) {
    const op = oppRail.points[oppRail.points.length - 1];
    if (op) {
      pts.push({ index: op.index, price: round(op.price, ctx.decimals), role: "channel_rail" });
    }
  }
  return pts;
}

function scoreLine(touchCount: number, status: TrendlineStatus, isChannel: boolean): number {
  let score = 40 + (touchCount - 2) * 12;
  if (status === "confirmed") score += 15;
  if (status === "forming") score -= 5;
  if (status === "failed") score -= 25;
  if (status === "exhausted") score -= 10;
  if (isChannel) score += 5;
  return clamp(score);
}

function qualityFromScore(score: number): TrendlineQuality {
  if (score >= 75) return "high";
  if (score >= 55) return "medium";
  if (score >= 35) return "low";
  return "none";
}

function riskFor(status: TrendlineStatus, touchCount: number): TrendlineRiskBand {
  if (status === "failed") return "high";
  if (touchCount >= 3 && (status === "confirmed" || status === "forming")) return "low";
  return "medium";
}
