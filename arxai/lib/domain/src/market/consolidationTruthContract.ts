// ── CONSOLIDATION TRUTH (Task #654) ─────────────────────────────────────────
//
// PURE detector for consolidation / continuation structures: ascending,
// descending and symmetrical triangles, rectangles/ranges, and bull/bear flags.
// The TRUTH rule that matters most: a consolidation is a NO-EDGE zone. It can
// only describe a range or a forming continuation — it can NEVER be classified
// as an aggressive buy/sell on its own. A breakout matters ONLY once price
// CLOSES decisively beyond a boundary; an intrabar poke does not resolve it.
//
// DISPLAY / DECISION-SUPPORT only. No IO, no clock. Honest empty: too few
// candles ⇒ type "none". Nothing here grants entry or overrides a feed.

import type { PatternLocationQuality } from "./patternDetectionContract";

export interface OHLCBar {
  open: number;
  high: number;
  low: number;
  close: number;
}

export type ConsolidationType =
  | "ascending_triangle"
  | "descending_triangle"
  | "symmetrical_triangle"
  | "rectangle_range"
  | "bull_flag"
  | "bear_flag"
  | "none";

export type ConsolidationStatus = "none" | "forming" | "confirmed" | "failed";

export interface ConsolidationInput {
  candles: OHLCBar[];
  feedConfirmed: boolean;
  feedStale: boolean;
}

export interface ConsolidationRead {
  type: ConsolidationType;
  status: ConsolidationStatus;
  /** Continuation direction once/if it resolves; neutral while ranging. */
  direction: "buy" | "sell" | "neutral";
  support: number | null;
  resistance: number | null;
  /** Where price sits inside the structure right now. */
  location: PatternLocationQuality;
  /** Upper boundary break level (close beyond ⇒ bullish resolution). */
  upperBreakLevel: number | null;
  /** Lower boundary break level (close beyond ⇒ bearish resolution). */
  lowerBreakLevel: number | null;
  confidence: number;
  candlesUsed: number;
  minCandles: number;
  contextOnly: boolean;
  reasons: string[];
  warnings: string[];
  explanation: string;
}

const MIN_CANDLES = 12;

function emptyRead(
  used: number,
  contextOnly: boolean,
  reason: string,
): ConsolidationRead {
  return {
    type: "none",
    status: "none",
    direction: "neutral",
    support: null,
    resistance: null,
    location: "unknown",
    upperBreakLevel: null,
    lowerBreakLevel: null,
    confidence: 0,
    candlesUsed: used,
    minCandles: MIN_CANDLES,
    contextOnly,
    reasons: [reason],
    warnings: [],
    explanation: reason,
  };
}

/** Least-squares slope of a numeric series (per index step). */
function slope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * Resolve the consolidation read. Splits the window: the first ~70% defines the
 * structure (its boundaries + the slopes of highs/lows), the LAST closed candle
 * decides forming vs a confirmed breakout (close beyond a boundary).
 */
export function resolveConsolidationTruth(
  input: ConsolidationInput,
): ConsolidationRead {
  const candles = input.candles ?? [];
  const contextOnly = !input.feedConfirmed || input.feedStale;
  if (candles.length < MIN_CANDLES) {
    return emptyRead(
      candles.length,
      contextOnly,
      `Not enough candles to read consolidation (need ${MIN_CANDLES}).`,
    );
  }

  const last = candles[candles.length - 1];
  const window = candles.slice(0, candles.length - 1);
  const highs = window.map((c) => c.high);
  const lows = window.map((c) => c.low);
  const resistance = Math.max(...highs);
  const support = Math.min(...lows);
  const span = resistance - support;
  if (span <= 0) {
    return emptyRead(candles.length, contextOnly, "Degenerate range — no structure.");
  }

  const highSlope = slope(highs);
  const lowSlope = slope(lows);
  // Normalise slope to "fraction of the span per candle" so the flat threshold
  // is scale-independent across instruments.
  const flat = (span / window.length) * 0.15;
  const highsRising = highSlope > flat;
  const highsFalling = highSlope < -flat;
  const highsFlat = !highsRising && !highsFalling;
  const lowsRising = lowSlope > flat;
  const lowsFalling = lowSlope < -flat;
  const lowsFlat = !lowsRising && !lowsFalling;

  // ── Flag detection (impulse + counter-drift) takes precedence ─────────────
  // A flag is a STRONG impulse (the "pole") followed by a TIGHT counter/sideways
  // drift (the "flag"). The impulse is measured against the FLAG's OWN range, not
  // the whole-window span — the pole otherwise dominates the span so no flag
  // could ever qualify. Breakout is likewise judged against the flag's OWN
  // boundaries (computed below), since a flag failure breaks the flag trendline,
  // not the pole.
  const impulseLen = Math.max(3, Math.floor(candles.length / 3));
  const impulse = candles.slice(0, impulseLen);
  const impulseMove = impulse[impulse.length - 1].close - impulse[0].close;
  const flagPart = window.slice(impulseLen);
  const flagHigh =
    flagPart.length >= 2 ? Math.max(...flagPart.map((c) => c.high)) : resistance;
  const flagLow =
    flagPart.length >= 2 ? Math.min(...flagPart.map((c) => c.low)) : support;
  const flagSpan = flagHigh - flagLow;
  const flagMove =
    flagPart.length >= 2
      ? flagPart[flagPart.length - 1].close - flagPart[0].close
      : 0;
  const impulseStrong = flagSpan > 0 && Math.abs(impulseMove) > flagSpan * 1.5;

  let type: ConsolidationType;
  let direction: "buy" | "sell" | "neutral" = "neutral";
  const reasons: string[] = [];

  if (impulseStrong && impulseMove > 0 && flagMove <= flagSpan * 0.5) {
    type = "bull_flag";
    direction = "buy";
    reasons.push("A tight pullback after a strong up-move — a bull flag (continuation).");
  } else if (impulseStrong && impulseMove < 0 && flagMove >= -flagSpan * 0.5) {
    type = "bear_flag";
    direction = "sell";
    reasons.push("A tight bounce after a strong down-move — a bear flag (continuation).");
  } else if (highsFlat && lowsRising) {
    type = "ascending_triangle";
    direction = "buy";
    reasons.push("Flat highs with rising lows — an ascending triangle (often resolves up).");
  } else if (lowsFlat && highsFalling) {
    type = "descending_triangle";
    direction = "sell";
    reasons.push("Flat lows with falling highs — a descending triangle (often resolves down).");
  } else if (highsFalling && lowsRising) {
    type = "symmetrical_triangle";
    direction = "neutral";
    reasons.push("Converging highs and lows — a symmetrical triangle (direction undecided).");
  } else if (highsFlat && lowsFlat) {
    type = "rectangle_range";
    direction = "neutral";
    reasons.push("Flat highs and lows — a rectangle/range (no edge inside it).");
  } else {
    type = "rectangle_range";
    direction = "neutral";
    reasons.push("Price is range-bound without a clean triangle slope — treat as a range.");
  }

  // For flags the breakout is judged against the FLAG's OWN boundaries — a flag
  // failure breaks the flag trendline, not the whole-window pole range. Other
  // structures (triangles/rectangles) are judged against the window boundaries.
  const isFlag = type === "bull_flag" || type === "bear_flag";
  const upperBound = isFlag ? flagHigh : resistance;
  const lowerBound = isFlag ? flagLow : support;
  const boundSpan = upperBound - lowerBound;

  // Location of the LAST close inside the structure.
  const pos = boundSpan > 0 ? (last.close - lowerBound) / boundSpan : 0.5;
  let location: PatternLocationQuality;
  if (pos >= 0.75) location = "at_resistance";
  else if (pos <= 0.25) location = "at_support";
  else location = "mid_range";

  // Status: a CLOSE beyond a boundary confirms a breakout; else forming. For a
  // flag, a close WITH the pole confirms the continuation; AGAINST the pole
  // invalidates it (direction flips to the resolved side).
  let status: ConsolidationStatus = "forming";
  if (last.close > upperBound) {
    status = "confirmed";
    direction = "buy";
    if (isFlag) {
      reasons.push(
        type === "bull_flag"
          ? "Bull flag resolved WITH the pole — upside continuation confirmed (close, not wick)."
          : "Bear flag resolved AGAINST the pole — the continuation thesis is invalidated (closed up).",
      );
    } else {
      reasons.push("Last candle CLOSED above resistance — breakout confirmed (close, not wick).");
    }
  } else if (last.close < lowerBound) {
    status = "confirmed";
    direction = "sell";
    if (isFlag) {
      reasons.push(
        type === "bear_flag"
          ? "Bear flag resolved WITH the pole — downside continuation confirmed (close, not wick)."
          : "Bull flag resolved AGAINST the pole — the continuation thesis is invalidated (closed down).",
      );
    } else {
      reasons.push("Last candle CLOSED below support — breakdown confirmed (close, not wick).");
    }
  } else if (last.high > upperBound || last.low < lowerBound) {
    reasons.push("Price pierced a boundary intrabar but did NOT close beyond it — not a break.");
  }

  let confidence = type === "symmetrical_triangle" ? 45 : 55;
  if (status === "confirmed") confidence += 15;
  if (contextOnly) confidence = Math.min(confidence, 35);
  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  const warnings: string[] = [];
  if (contextOnly) {
    warnings.push("Feed is not live-confirmed — treat the range as context, not a live trigger.");
  }
  if (location === "mid_range" && status === "forming") {
    warnings.push("Mid-range — the lowest-edge spot to act; wait for a boundary.");
  }

  const explanation =
    status === "confirmed"
      ? `Consolidation resolved: a confirmed ${direction === "buy" ? "upside" : "downside"} breakout on a closing basis.`
      : "Price is consolidating — a range, not a directional edge. Wait for a decisive close beyond a boundary.";

  return {
    type,
    status,
    direction,
    support,
    resistance,
    location,
    upperBreakLevel: upperBound,
    lowerBreakLevel: lowerBound,
    confidence,
    candlesUsed: candles.length,
    minCandles: MIN_CANDLES,
    contextOnly,
    reasons,
    warnings,
    explanation,
  };
}
