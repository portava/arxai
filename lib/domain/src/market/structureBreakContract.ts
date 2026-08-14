// ── STRUCTURE BREAK TRUTH (Task #654) ───────────────────────────────────────
//
// PURE detector for two structure-shift reads:
//   1. Trendline break — a sloped support/resistance line broken on a CLOSE
//      (never a wick). A wick poke through a trendline is explicitly NOT a break.
//   2. Support/Resistance flip (retest) — a horizontal level that was broken and
//      is now being retested from the other side (old resistance → new support
//      and vice versa).
//
// DISPLAY / DECISION-SUPPORT only. No IO, no clock. Honest empty: too few
// candles ⇒ type "none". Nothing here grants entry or overrides a feed.

import type { PatternLocationQuality } from "./patternDetectionContract";

export interface OHLCCandle {
  open: number;
  high: number;
  low: number;
  close: number;
}

export type StructureBreakType =
  | "trendline_break"
  | "support_resistance_flip"
  | "none";

export type StructureBreakStatus = "none" | "forming" | "confirmed" | "failed";

export interface StructureBreakInput {
  candles: OHLCCandle[];
  feedConfirmed: boolean;
  feedStale: boolean;
}

export interface StructureBreakRead {
  type: StructureBreakType;
  status: StructureBreakStatus;
  direction: "buy" | "sell" | "neutral";
  /** The level that broke / is being retested. */
  level: number | null;
  /** A close beyond this confirms continuation of the break. */
  confirmationLevel: number | null;
  /** A close back beyond this invalidates the break. */
  invalidationLevel: number | null;
  location: PatternLocationQuality;
  confidence: number;
  candlesUsed: number;
  minCandles: number;
  contextOnly: boolean;
  /** True only when a CLOSE (not a wick) carried the break. */
  brokeOnClose: boolean;
  reasons: string[];
  warnings: string[];
  explanation: string;
}

const MIN_CANDLES = 10;

function emptyRead(
  used: number,
  contextOnly: boolean,
  reason: string,
): StructureBreakRead {
  return {
    type: "none",
    status: "none",
    direction: "neutral",
    level: null,
    confirmationLevel: null,
    invalidationLevel: null,
    location: "unknown",
    confidence: 0,
    candlesUsed: used,
    minCandles: MIN_CANDLES,
    contextOnly,
    brokeOnClose: false,
    reasons: [reason],
    warnings: [],
    explanation: reason,
  };
}

function slope(values: number[]): { m: number; b: number } {
  const n = values.length;
  if (n < 2) return { m: 0, b: values[0] ?? 0 };
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, c) => a + c, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const m = den === 0 ? 0 : num / den;
  return { m, b: yMean - m * xMean };
}

/**
 * Resolve a structure break. Prefers a clean trendline break on the LAST close;
 * if none, looks for a horizontal S/R flip retest. Wick-only pokes are reported
 * as forming/failed, never confirmed.
 */
export function resolveStructureBreakTruth(
  input: StructureBreakInput,
): StructureBreakRead {
  const candles = input.candles ?? [];
  const contextOnly = !input.feedConfirmed || input.feedStale;
  if (candles.length < MIN_CANDLES) {
    return emptyRead(
      candles.length,
      contextOnly,
      `Not enough candles to read a structure break (need ${MIN_CANDLES}).`,
    );
  }

  const last = candles[candles.length - 1];
  const prior = candles.slice(0, candles.length - 1);
  const n = prior.length;

  // ── Trendline fit over the prior window ──────────────────────────────────
  // Resistance line from highs, support line from lows. Projected to the last
  // index to compare against the last candle's close.
  const highFit = slope(prior.map((c) => c.high));
  const lowFit = slope(prior.map((c) => c.low));
  const projHigh = highFit.m * n + highFit.b;
  const projLow = lowFit.m * n + lowFit.b;

  // Broke ABOVE a (falling/flat) resistance trendline on a close?
  const closedAboveRes = last.close > projHigh && last.open <= projHigh;
  const wickOnlyAboveRes = last.high > projHigh && last.close <= projHigh;
  // Broke BELOW a (rising/flat) support trendline on a close?
  const closedBelowSup = last.close < projLow && last.open >= projLow;
  const wickOnlyBelowSup = last.low < projLow && last.close >= projLow;

  if (closedAboveRes || closedBelowSup) {
    const direction = closedAboveRes ? "buy" : "sell";
    const level = closedAboveRes ? projHigh : projLow;
    let confidence = 60;
    if (contextOnly) confidence = Math.min(confidence, 35);
    confidence = Math.max(0, Math.min(100, Math.round(confidence)));
    return {
      type: "trendline_break",
      status: "confirmed",
      direction,
      level,
      confirmationLevel: closedAboveRes ? last.high : last.low,
      invalidationLevel: level,
      location: closedAboveRes ? "at_resistance" : "at_support",
      confidence,
      candlesUsed: candles.length,
      minCandles: MIN_CANDLES,
      contextOnly,
      brokeOnClose: true,
      reasons: [
        `Price CLOSED ${closedAboveRes ? "above a resistance" : "below a support"} trendline — a break on a closing basis.`,
        "A close carried the break, not just a wick.",
      ],
      warnings: contextOnly
        ? ["Feed is not live-confirmed — treat the break as context, not a live trigger."]
        : [],
      explanation: `A trendline ${closedAboveRes ? "breakout" : "breakdown"} confirmed by a close beyond the line.`,
    };
  }

  if (wickOnlyAboveRes || wickOnlyBelowSup) {
    return {
      ...emptyRead(candles.length, contextOnly, "wick"),
      type: "trendline_break",
      status: "failed",
      direction: "neutral",
      level: wickOnlyAboveRes ? projHigh : projLow,
      brokeOnClose: false,
      location: wickOnlyAboveRes ? "at_resistance" : "at_support",
      reasons: [
        "Price pierced the trendline with a WICK but closed back inside — not a valid break.",
      ],
      warnings: [],
      explanation:
        "A wick poked through the trendline but the candle did not close beyond it — no break.",
    };
  }

  // ── Horizontal S/R flip retest ───────────────────────────────────────────
  // Find a horizontal level that was broken earlier and is being retested now.
  const highs = prior.map((c) => c.high);
  const lows = prior.map((c) => c.low);
  const resistance = Math.max(...highs);
  const support = Math.min(...lows);
  const span = resistance - support;
  if (span > 0) {
    const tol = span * 0.08;
    // Old resistance acting as new support: price earlier closed above
    // resistance and is now retesting it from above.
    const brokeAbove = prior.some((c) => c.close > resistance - tol);
    const retestingFromAbove =
      Math.abs(last.low - resistance) <= tol && last.close >= resistance - tol;
    if (brokeAbove && retestingFromAbove) {
      let confidence = 55;
      if (contextOnly) confidence = Math.min(confidence, 35);
      confidence = Math.max(0, Math.min(100, Math.round(confidence)));
      return {
        type: "support_resistance_flip",
        status: "forming",
        direction: "buy",
        level: resistance,
        confirmationLevel: resistance + tol,
        invalidationLevel: resistance - tol,
        location: "at_support",
        confidence,
        candlesUsed: candles.length,
        minCandles: MIN_CANDLES,
        contextOnly,
        brokeOnClose: true,
        reasons: [
          "Old resistance is being retested as new support (a flip).",
          "Holding above the flipped level keeps the bullish read alive.",
        ],
        warnings: contextOnly
          ? ["Feed is not live-confirmed — treat the flip as context."]
          : [],
        explanation:
          "A broken resistance level is being retested from above as support — a classic flip.",
      };
    }
    const brokeBelow = prior.some((c) => c.close < support + tol);
    const retestingFromBelow =
      Math.abs(last.high - support) <= tol && last.close <= support + tol;
    if (brokeBelow && retestingFromBelow) {
      let confidence = 55;
      if (contextOnly) confidence = Math.min(confidence, 35);
      confidence = Math.max(0, Math.min(100, Math.round(confidence)));
      return {
        type: "support_resistance_flip",
        status: "forming",
        direction: "sell",
        level: support,
        confirmationLevel: support - tol,
        invalidationLevel: support + tol,
        location: "at_resistance",
        confidence,
        candlesUsed: candles.length,
        minCandles: MIN_CANDLES,
        contextOnly,
        brokeOnClose: true,
        reasons: [
          "Old support is being retested as new resistance (a flip).",
          "Rejection at the flipped level keeps the bearish read alive.",
        ],
        warnings: contextOnly
          ? ["Feed is not live-confirmed — treat the flip as context."]
          : [],
        explanation:
          "A broken support level is being retested from below as resistance — a classic flip.",
      };
    }
  }

  return emptyRead(
    candles.length,
    contextOnly,
    "No structure break: no close beyond a trendline and no S/R flip retest.",
  );
}
