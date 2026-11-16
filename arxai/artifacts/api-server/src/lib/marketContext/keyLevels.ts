// Phase UX6 — Key level engine.
//
// Combines trade-derived levels (entry, SL, TP) with provider-derived
// market structure (swings, S/R, breakout) into a single ranked level set.
// All market-structure inputs are real or null. Nothing is invented.

import type { MarketContext } from "./contextBuilder.js";
import type { ClassificationResult } from "./classifier.js";

export interface KeyLevels {
  current: number | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  nearestSupport: number | null;
  nearestResistance: number | null;
  swingHigh: number | null;
  swingLow: number | null;
  breakoutLevel: number | null;
  invalidationLevel: number | null;
  continuationLevel: number | null;
  protectProfitLevel: number | null;
  keyLevelToWatch: number | null;
  available: boolean;
  reason?: string;
}

export interface KeyLevelInput {
  side: "BUY" | "SELL";
  entryPrice: number | null;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  ctx: MarketContext;
  classification: ClassificationResult;
}

const round = (n: number, p = 5) => Math.round(n * Math.pow(10, p)) / Math.pow(10, p);

function nearest(levels: number[] | undefined, price: number, side: "above" | "below"): number | null {
  if (!levels || !levels.length || !Number.isFinite(price)) return null;
  const filtered = levels.filter((x) => Number.isFinite(x) && (side === "above" ? x > price : x < price));
  if (!filtered.length) return null;
  return round(filtered.reduce((best, x) => Math.abs(x - price) < Math.abs(best - price) ? x : best, filtered[0]!));
}

export function computeKeyLevels(input: KeyLevelInput): KeyLevels {
  const { side, entryPrice, currentPrice, stopLoss, takeProfit, ctx, classification } = input;
  const price = currentPrice ?? entryPrice;
  const primaryTf = classification.primaryTimeframe;
  const tf = primaryTf ? ctx.timeframes[primaryTf] : null;

  // No candles → only trade-derived levels survive.
  if (!tf || !tf.available || price == null) {
    return {
      current: currentPrice, entry: entryPrice, stopLoss, takeProfit,
      nearestSupport: null, nearestResistance: null,
      swingHigh: null, swingLow: null, breakoutLevel: null,
      invalidationLevel: stopLoss, continuationLevel: null, protectProfitLevel: null,
      keyLevelToWatch: stopLoss ?? entryPrice,
      available: false,
      reason: "Key levels unavailable because candle data is missing.",
    };
  }

  const allSupports = [...(tf.supportLevels ?? []), ...(tf.swingLow != null ? [tf.swingLow] : []), ...(tf.rangeLow != null ? [tf.rangeLow] : [])];
  const allResistances = [...(tf.resistanceLevels ?? []), ...(tf.swingHigh != null ? [tf.swingHigh] : []), ...(tf.rangeHigh != null ? [tf.rangeHigh] : [])];

  const nearestSupport = nearest(allSupports, price, "below");
  const nearestResistance = nearest(allResistances, price, "above");

  // Breakout level: prior range extreme in trend direction.
  const breakoutLevel = side === "BUY" ? (tf.rangeHigh ?? null) : (tf.rangeLow ?? null);

  // Invalidation: for BUY = opposing swing low (or stopLoss, whichever is nearer & valid).
  // For SELL = opposing swing high. Falls back to SL if structure is silent.
  let invalidationLevel: number | null = null;
  if (side === "BUY") {
    invalidationLevel = tf.swingLow ?? nearestSupport ?? stopLoss;
  } else {
    invalidationLevel = tf.swingHigh ?? nearestResistance ?? stopLoss;
  }
  if (invalidationLevel != null) invalidationLevel = round(invalidationLevel);

  // Continuation: for BUY = next resistance / rangeHigh; for SELL = next support / rangeLow.
  let continuationLevel: number | null = null;
  if (side === "BUY") continuationLevel = nearestResistance ?? tf.rangeHigh ?? takeProfit;
  else continuationLevel = nearestSupport ?? tf.rangeLow ?? takeProfit;
  if (continuationLevel != null) continuationLevel = round(continuationLevel);

  // Protect-profit: midpoint between entry and TP (1R-ish proxy) when both exist.
  let protectProfitLevel: number | null = null;
  if (entryPrice != null && stopLoss != null) {
    const R = Math.abs(entryPrice - stopLoss);
    protectProfitLevel = round(entryPrice + (side === "BUY" ? 1 : -1) * R);
  }

  // Key level to watch = the closest of {invalidation, continuation} by distance.
  let keyLevelToWatch: number | null = null;
  const candidates: number[] = [];
  if (invalidationLevel != null) candidates.push(invalidationLevel);
  if (continuationLevel != null) candidates.push(continuationLevel);
  if (candidates.length) {
    keyLevelToWatch = candidates.reduce((best, x) => Math.abs(x - price) < Math.abs(best - price) ? x : best, candidates[0]!);
  }

  return {
    current: currentPrice, entry: entryPrice, stopLoss, takeProfit,
    nearestSupport, nearestResistance,
    swingHigh: tf.swingHigh, swingLow: tf.swingLow,
    breakoutLevel: breakoutLevel != null ? round(breakoutLevel) : null,
    invalidationLevel, continuationLevel, protectProfitLevel,
    keyLevelToWatch,
    available: true,
  };
}
