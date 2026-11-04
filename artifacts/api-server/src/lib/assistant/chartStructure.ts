// Ruby chart-read — deterministic market-structure analysis.
//
// SAFETY / DESIGN:
//  - NO LLM. Pure, deterministic, free, predictable. Ruby can never
//    "hallucinate a guaranteed trade". Output is hedged and conditional.
//  - NEVER fabricates prices. All levels are derived from the REAL candles
//    passed in. If there is not enough candle history, we say so honestly
//    (dataQuality = "insufficient") rather than inventing structure.
//  - Read-only: this module computes an explanation only. It cannot place,
//    modify, or close a trade.
//
// It reads visible structure (trend / impulse / pullback / consolidation /
// support / resistance / momentum / range position), folds in a
// higher-timeframe bias, and emits a structured, plain-English read with
// conditional buy/sell triggers. It does NOT force a trade when confidence
// is low.

import type { Candle } from "../data/types.js";
import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";

export type StructureBias =
  | "Bullish"
  | "Bearish"
  | "Mixed"
  | "Range-bound"
  | "No clear edge";

export type StructureConfidence = "Low" | "Medium" | "High";

export type ChartReadResult = {
  bias: StructureBias;
  confidence: StructureConfidence;
  why: string;
  supportZone: string;
  resistanceZone: string;
  buyCondition: string;
  sellCondition: string;
  invalidation: string;
  riskNote: string;
  htfBias: StructureBias;
  dataQuality: "ok" | "insufficient";
  cautions: string[];
};

export type DraftPlan = {
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp: number;
} | null;

// ── small numeric helpers ────────────────────────────────────────────────
function sortAscending(candles: Candle[]): Candle[] {
  return [...candles].sort((a, b) => {
    const ta = Date.parse(a.time);
    const tb = Date.parse(b.time);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    return 0;
  });
}

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i]!;
  return sum / period;
}

function smaAt(values: number[], period: number, endIndex: number): number | null {
  if (endIndex + 1 < period) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) sum += values[i]!;
  return sum / period;
}

// Average true range over the last `period` candles (Wilder-lite, simple mean).
function atr(candles: Candle[], period: number): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    );
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

// Decimal precision suitable for the instrument's price magnitude.
function decimalsFor(price: number): number {
  const p = Math.abs(price);
  if (p >= 1000) return 1;
  if (p >= 100) return 2;
  if (p >= 1) return 4;
  return 5;
}

function fmt(price: number, decimals: number): string {
  return price.toFixed(decimals);
}

function zone(low: number, high: number, decimals: number): string {
  if (Math.abs(high - low) < Math.pow(10, -decimals)) {
    return fmt(low, decimals);
  }
  return `${fmt(Math.min(low, high), decimals)} – ${fmt(Math.max(low, high), decimals)}`;
}

// Coarse trend read for an arbitrary candle series (used for HTF bias).
export function quickTrend(candles: Candle[]): StructureBias {
  if (candles.length < 10) return "No clear edge";
  const c = sortAscending(candles);
  const closes = c.map((x) => x.close);
  const last = closes[closes.length - 1]!;
  const fast = sma(closes, Math.min(20, closes.length)) ?? last;
  const slow = sma(closes, Math.min(50, closes.length)) ?? fast;
  const span = Math.max(...c.map((x) => x.high)) - Math.min(...c.map((x) => x.low));
  const sep = span > 0 ? Math.abs(fast - slow) / span : 0;
  if (sep < 0.05) return "Range-bound";
  if (last > fast && fast >= slow) return "Bullish";
  if (last < fast && fast <= slow) return "Bearish";
  return "Mixed";
}

// Minimum count of fully-CLOSED bars required to read structure at all. Below
// this the analyzer refuses to invent structure; at or above it a directional
// STRUCTURAL read is allowed even when the live feed is unconfirmed (the exact
// trade setup is gated separately by the shared sufficiency verdict, not here).
export const STRUCTURE_MIN_CLOSED_BARS = 20;

// ── main analyzer ─────────────────────────────────────────────────────────
export function analyzeChartStructure(
  rawCandles: Candle[],
  opts: { htfBias?: StructureBias; draft?: DraftPlan; assistantName?: string } = {},
): ChartReadResult {
  const htfBias: StructureBias = opts.htfBias ?? "No clear edge";
  const draft = opts.draft ?? null;
  const assistantName = opts.assistantName ?? DEFAULT_ASSISTANT_NAME;

  // Honest insufficient-data path — never invent structure.
  if (!rawCandles || rawCandles.length < STRUCTURE_MIN_CLOSED_BARS) {
    return {
      bias: "No clear edge",
      confidence: "Low",
      why:
        "Not enough candle history is available to read structure on this timeframe yet. " +
        `${assistantName} will not guess direction without visible structure.`,
      supportZone: "Not enough data",
      resistanceZone: "Not enough data",
      buyCondition: "Wait until enough candles load to define a support level to buy from.",
      sellCondition: "Wait until enough candles load to define a resistance level to sell from.",
      invalidation: "No structure to invalidate yet — treat any move as noise until the chart fills in.",
      riskNote: "Avoid acting on an unread chart. Let the data load, then re-read.",
      htfBias,
      dataQuality: "insufficient",
      cautions: ["Insufficient candle history for a structural read."],
    };
  }

  const candles = sortAscending(rawCandles);
  const closes = candles.map((c) => c.close);
  const n = closes.length;
  const last = closes[n - 1]!;
  const decimals = decimalsFor(last);

  // Trend via SMA stack + slope.
  const sma20 = sma(closes, Math.min(20, n));
  const sma50 = sma(closes, Math.min(50, n));
  const slopeRef = smaAt(closes, Math.min(20, n), Math.max(0, n - 11));
  const slopeUp = sma20 != null && slopeRef != null ? sma20 - slopeRef : 0;

  // Support / resistance from recent swing extremes.
  const lookback = Math.min(n, 60);
  const window = candles.slice(n - lookback);
  const swingHigh = Math.max(...window.map((c) => c.high));
  const swingLow = Math.min(...window.map((c) => c.low));
  const span = swingHigh - swingLow;

  // Zone width from volatility (ATR) so zones are bands, not hairlines.
  const atr14 = atr(candles, Math.min(14, n - 1)) ?? span * 0.05;
  const band = Math.max(atr14 * 0.5, span * 0.02);
  const resistanceZone = zone(swingHigh - band, swingHigh, decimals);
  const supportZone = zone(swingLow, swingLow + band, decimals);

  // Range position 0 (at support) .. 1 (at resistance).
  const rangePos = span > 0 ? Math.min(1, Math.max(0, (last - swingLow) / span)) : 0.5;

  // Momentum: recent N-bar change scaled by ATR.
  const momLen = Math.min(5, n - 1);
  const momChange = last - closes[n - 1 - momLen]!;
  const momStrength = atr14 > 0 ? momChange / atr14 : 0;
  const strongMomentum = Math.abs(momStrength) >= 1.2;

  // Trend classification.
  const sep = span > 0 && sma20 != null && sma50 != null ? Math.abs(sma20 - sma50) / span : 0;
  const stackUp = sma20 != null && sma50 != null && last > sma20 && sma20 >= sma50 && slopeUp > 0;
  const stackDown = sma20 != null && sma50 != null && last < sma20 && sma20 <= sma50 && slopeUp < 0;
  const flat = sep < 0.06;

  const nearResistance = rangePos >= 0.78;
  const nearSupport = rangePos <= 0.22;
  const midRange = rangePos > 0.35 && rangePos < 0.65;

  // Bias resolution (folds in HTF). A committed trend stays directional even
  // when extended near its range edge AS LONG AS momentum confirms; it only
  // softens to Mixed when the trend stalls into the opposing boundary.
  let bias: StructureBias;
  if (stackUp) {
    bias = nearResistance && !strongMomentum ? "Mixed" : "Bullish";
  } else if (stackDown) {
    bias = nearSupport && !strongMomentum ? "Mixed" : "Bearish";
  } else if (flat && midRange && !strongMomentum) {
    bias = "Range-bound";
  } else if (midRange && !strongMomentum) {
    bias = "Range-bound";
  } else {
    bias = "Mixed";
  }
  const extended =
    (bias === "Bullish" && nearResistance) || (bias === "Bearish" && nearSupport);

  // HTF disagreement softens an LTF directional call to Mixed.
  const htfDirectional = htfBias === "Bullish" || htfBias === "Bearish";
  if (htfDirectional && (bias === "Bullish" || bias === "Bearish") && htfBias !== bias) {
    bias = "Mixed";
  }

  // Confidence.
  const aligned = htfDirectional && htfBias === bias;
  let confidence: StructureConfidence;
  if ((bias === "Bullish" || bias === "Bearish") && aligned && strongMomentum && !midRange) {
    confidence = "High";
  } else if (bias === "Bullish" || bias === "Bearish") {
    confidence = strongMomentum || aligned ? "Medium" : "Low";
  } else {
    confidence = "Low";
  }

  // Plain-English narrative.
  const stateWord = nearResistance
    ? "trading up near resistance"
    : nearSupport
    ? "trading down near support"
    : midRange
    ? "consolidating in the middle of its range"
    : rangePos >= 0.5
    ? "holding the upper half of its range"
    : "holding the lower half of its range";
  const trendWord = stackUp
    ? "the trend structure leans up"
    : stackDown
    ? "the trend structure leans down"
    : flat
    ? "moving averages are flat (no committed trend)"
    : "trend signals are mixed";
  const momWord = strongMomentum
    ? momStrength > 0
      ? "with recent upside momentum"
      : "with recent downside momentum"
    : "with momentum cooling";
  const htfWord =
    htfBias === "No clear edge"
      ? "Higher-timeframe bias is unclear"
      : `Higher-timeframe bias leans ${htfBias.toLowerCase()}`;

  const why = `${htfWord}. On this timeframe ${trendWord}, ${momWord}; price is ${stateWord}.`;

  // Conditional triggers — never an unconditional "buy now".
  const buyCondition =
    bias === "Bearish"
      ? `A buy is counter-trend here. It only becomes credible if price reclaims ${resistanceZone} on a strong close with momentum.`
      : `A buy becomes stronger only if price holds ${supportZone} and pushes back through ${resistanceZone} with momentum — not while stuck mid-range.`;
  const sellCondition =
    bias === "Bullish"
      ? `A sell is counter-trend here. It only becomes credible if price loses ${supportZone} on a strong close with momentum.`
      : `A sell becomes stronger only if price rejects ${resistanceZone} or breaks ${supportZone} with momentum — not while stuck mid-range.`;

  const invalidation =
    bias === "Bullish"
      ? `A decisive close below ${supportZone} breaks the bullish read.`
      : bias === "Bearish"
      ? `A decisive close above ${resistanceZone} breaks the bearish read.`
      : `A decisive close beyond ${supportZone} or ${resistanceZone} resolves the range and invalidates a mid-range read.`;

  const cautions: string[] = [];
  if (extended) cautions.push("Price is extended near the range edge — chasing here has poor reward-to-risk.");
  if (midRange) cautions.push("Price is mid-range — entries here have poor reward-to-risk; wait for an edge.");
  if (confidence === "Low") cautions.push("Confidence is low — no forced trade; waiting is a valid decision.");
  if (htfDirectional && (bias === "Bullish" || bias === "Bearish") && htfBias !== bias) {
    cautions.push("Lower- and higher-timeframe bias disagree — treat signals as conflicting.");
  }
  const atrPct = last !== 0 ? (atr14 / Math.abs(last)) * 100 : 0;
  if (atrPct >= 1.5) cautions.push("Volatility is elevated — size smaller than usual.");

  // Draft alignment note (read-only; never an instruction to execute).
  if (draft) {
    const aligns =
      (draft.side === "BUY" && bias === "Bullish") ||
      (draft.side === "SELL" && bias === "Bearish");
    const conflicts =
      (draft.side === "BUY" && bias === "Bearish") ||
      (draft.side === "SELL" && bias === "Bullish");
    if (conflicts) {
      cautions.push(`Your ${draft.side} plan runs against the current ${bias.toLowerCase()} structure — that is a counter-trend bet.`);
    } else if (aligns) {
      cautions.push(`Your ${draft.side} plan aligns with the current structure — still wait for the condition above to trigger.`);
    }
  }

  const riskNote =
    confidence === "High"
      ? "Even on a clean read, only risk what your plan allows and keep a defined stop. Structure can fail."
      : confidence === "Medium"
      ? "Edge is moderate — keep size conservative and require the trigger condition before acting."
      : "Edge is weak. Protect capital: the highest-probability action is often to wait for a clearer structure.";

  return {
    bias,
    confidence,
    why,
    supportZone,
    resistanceZone,
    buyCondition,
    sellCondition,
    invalidation,
    riskNote,
    htfBias,
    dataQuality: "ok",
    cautions,
  };
}

// Map a chart timeframe to a sensible higher timeframe for bias context.
export function higherTimeframeOf(timeframe: string): string | null {
  const tf = timeframe.trim().toLowerCase();
  const map: Record<string, string> = {
    "1m": "15m",
    "5m": "1h",
    "15m": "1h",
    "30m": "4h",
    "1h": "4h",
    "4h": "1d",
    "1d": "1w",
    "1w": "1w",
  };
  return map[tf] ?? null;
}
