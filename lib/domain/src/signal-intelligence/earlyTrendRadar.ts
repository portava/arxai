// Early Trend Radar — reads building directional pressure BEFORE it becomes an
// obvious move. Pure & deterministic. Detects swing structure (HH/HL, LH/LL),
// break-of-structure / change-of-character, liquidity sweeps, failed breakouts,
// rejection wicks, and momentum expansion/compression from the candle window.
//
// HONEST: with fewer than MIN_STRUCTURE_CANDLES, every field collapses to an
// UNKNOWN/NONE blind read (score 0) — never a fabricated structure.

import type {
  EarlyTrendReading,
  SignalCandle,
} from "./signalIntelligence.types.js";
import { MIN_STRUCTURE_CANDLES } from "./signalIntelligence.types.js";
import { atr, clamp, mean, round, swingPoints } from "./_math.js";

function blindReading(): EarlyTrendReading {
  return {
    pressure: "NEUTRAL",
    structure: "UNKNOWN",
    bosChoch: "NONE",
    sweepDetected: false,
    failedBreakout: false,
    rejectionDetected: false,
    momentum: "UNKNOWN",
    compression: false,
    score: 0,
    notes: ["Not enough candles to read structure — honest blind read."],
    blind: true,
  };
}

export function readEarlyTrend(
  candles: SignalCandle[] | null,
): EarlyTrendReading {
  if (!candles || candles.length < MIN_STRUCTURE_CANDLES) {
    return blindReading();
  }

  const notes: string[] = [];
  const closes = candles.map((c) => c.close);
  const { highs, lows } = swingPoints(candles, 2);

  // ── Swing structure ──────────────────────────────────────────────────────
  const lastHighs = highs.slice(-3).map((i) => candles[i]!.high);
  const lastLows = lows.slice(-3).map((i) => candles[i]!.low);
  const higherHighs =
    lastHighs.length >= 2 && lastHighs[lastHighs.length - 1]! > lastHighs[0]!;
  const higherLows =
    lastLows.length >= 2 && lastLows[lastLows.length - 1]! > lastLows[0]!;
  const lowerHighs =
    lastHighs.length >= 2 && lastHighs[lastHighs.length - 1]! < lastHighs[0]!;
  const lowerLows =
    lastLows.length >= 2 && lastLows[lastLows.length - 1]! < lastLows[0]!;

  let structure: EarlyTrendReading["structure"] = "CHOPPY";
  if (higherHighs && higherLows) {
    structure = "HH_HL";
    notes.push("Higher highs and higher lows.");
  } else if (lowerHighs && lowerLows) {
    structure = "LH_LL";
    notes.push("Lower highs and lower lows.");
  } else {
    // Range vs choppy: tight band over the window = range.
    const windowHigh = Math.max(...candles.map((c) => c.high));
    const windowLow = Math.min(...candles.map((c) => c.low));
    const a = atr(candles, 14) ?? 0;
    const band = windowHigh - windowLow;
    if (a > 0 && band > 0 && band < a * 4) {
      structure = "RANGE";
      notes.push("Price compressed into a range.");
    } else {
      structure = "CHOPPY";
      notes.push("No clean swing structure.");
    }
  }

  // ── Break of structure / change of character ──────────────────────────────
  // Compare the latest close against the most recent prior swing level.
  const lastClose = closes[closes.length - 1]!;
  const priorSwingHigh =
    highs.length >= 1 ? candles[highs[highs.length - 1]!]!.high : null;
  const priorSwingLow =
    lows.length >= 1 ? candles[lows[lows.length - 1]!]!.low : null;

  let bosChoch: EarlyTrendReading["bosChoch"] = "NONE";
  if (priorSwingHigh != null && lastClose > priorSwingHigh) {
    bosChoch = structure === "LH_LL" ? "CHOCH_UP" : "BOS_UP";
    notes.push(bosChoch === "CHOCH_UP" ? "Change of character up." : "Break of structure up.");
  } else if (priorSwingLow != null && lastClose < priorSwingLow) {
    bosChoch = structure === "HH_HL" ? "CHOCH_DOWN" : "BOS_DOWN";
    notes.push(bosChoch === "CHOCH_DOWN" ? "Change of character down." : "Break of structure down.");
  }

  // ── Liquidity sweep + failed breakout + rejection wick (last candle) ──────
  const last = candles[candles.length - 1]!;
  const a14 = atr(candles, 14) ?? 0;
  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const rejectionDetected =
    (upperWick > body * 1.8 && upperWick > 0) ||
    (lowerWick > body * 1.8 && lowerWick > 0);
  if (rejectionDetected) notes.push("Rejection wick on the last candle.");

  // Sweep: last candle pokes beyond a prior swing then closes back inside.
  let sweepDetected = false;
  if (priorSwingHigh != null && last.high > priorSwingHigh && last.close < priorSwingHigh) {
    sweepDetected = true;
    notes.push("Liquidity sweep above prior high, closed back inside.");
  } else if (priorSwingLow != null && last.low < priorSwingLow && last.close > priorSwingLow) {
    sweepDetected = true;
    notes.push("Liquidity sweep below prior low, closed back inside.");
  }

  // Failed breakout: closed beyond a level last candle but reversed this candle.
  let failedBreakout = false;
  if (candles.length >= 2) {
    const prev = candles[candles.length - 2]!;
    if (priorSwingHigh != null && prev.close > priorSwingHigh && last.close < priorSwingHigh) {
      failedBreakout = true;
      notes.push("Failed breakout above resistance.");
    } else if (priorSwingLow != null && prev.close < priorSwingLow && last.close > priorSwingLow) {
      failedBreakout = true;
      notes.push("Failed breakout below support.");
    }
  }

  // ── Momentum expansion / compression ──────────────────────────────────────
  const recentRanges = candles.slice(-5).map((c) => c.high - c.low);
  const olderRanges = candles.slice(-15, -5).map((c) => c.high - c.low);
  const recentR = mean(recentRanges);
  const olderR = mean(olderRanges);
  let momentum: EarlyTrendReading["momentum"] = "STEADY";
  let compression = false;
  if (olderR > 0) {
    const ratio = recentR / olderR;
    if (ratio > 1.3) {
      momentum = "EXPANDING";
      notes.push("Volatility is expanding.");
    } else if (ratio < 0.7) {
      momentum = "COMPRESSING";
      compression = true;
      notes.push("Volatility is compressing.");
    }
  }

  // ── Directional pressure ──────────────────────────────────────────────────
  let bullPoints = 0;
  let bearPoints = 0;
  if (structure === "HH_HL") bullPoints += 2;
  if (structure === "LH_LL") bearPoints += 2;
  if (bosChoch === "BOS_UP" || bosChoch === "CHOCH_UP") bullPoints += 2;
  if (bosChoch === "BOS_DOWN" || bosChoch === "CHOCH_DOWN") bearPoints += 2;
  if (sweepDetected && lowerWick > upperWick) bullPoints += 1;
  if (sweepDetected && upperWick > lowerWick) bearPoints += 1;
  if (failedBreakout && last.close < (priorSwingHigh ?? last.close)) bearPoints += 1;
  if (failedBreakout && last.close > (priorSwingLow ?? last.close)) bullPoints += 1;

  let pressure: EarlyTrendReading["pressure"];
  if (bullPoints > bearPoints && bullPoints >= 2) pressure = "BUILDING_BULLISH";
  else if (bearPoints > bullPoints && bearPoints >= 2) pressure = "BUILDING_BEARISH";
  else if (momentum === "COMPRESSING") pressure = "FADING";
  else pressure = "NEUTRAL";

  // ── Strength score 0–100 ─────────────────────────────────────────────────
  const dominant = Math.max(bullPoints, bearPoints);
  let score = clamp(dominant * 16, 0, 100);
  if (momentum === "EXPANDING" && pressure !== "NEUTRAL") score = clamp(score + 12, 0, 100);
  if (momentum === "COMPRESSING") score = clamp(score - 10, 0, 100);
  if (a14 === 0) score = clamp(score - 20, 0, 100);

  return {
    pressure,
    structure,
    bosChoch,
    sweepDetected,
    failedBreakout,
    rejectionDetected,
    momentum,
    compression,
    score: round(score),
    notes,
    blind: false,
  };
}
