// Regime classification + fakeout/trap detection. Pure & deterministic.
//
// Regime answers "what kind of market is this" (trending / ranging / volatile /
// quiet / breakout) so downstream weighting can prefer the right playbook.
// Fakeout flags bull/bear traps, liquidity sweeps, and failed breakouts so a
// signal is not taken at face value.
//
// HONEST: insufficient candles → UNKNOWN regime + NONE fakeout, never guessed.

import type {
  EarlyTrendReading,
  FakeoutReading,
  MarketRegime,
  SignalCandle,
} from "./signalIntelligence.types.js";
import { MIN_STRUCTURE_CANDLES } from "./signalIntelligence.types.js";
import { atr, clamp, mean, normalizedSlope, round } from "./_math.js";

export function classifyRegime(candles: SignalCandle[] | null): MarketRegime {
  if (!candles || candles.length < MIN_STRUCTURE_CANDLES) return "UNKNOWN";

  const closes = candles.map((c) => c.close);
  const slope = Math.abs(normalizedSlope(closes.slice(-20)));

  const a14 = atr(candles, 14);
  const recentRanges = candles.slice(-5).map((c) => c.high - c.low);
  const olderRanges = candles.slice(-20, -5).map((c) => c.high - c.low);
  const recentR = mean(recentRanges);
  const olderR = mean(olderRanges);
  const expansion = olderR > 0 ? recentR / olderR : 1;

  const windowHigh = Math.max(...candles.map((c) => c.high));
  const windowLow = Math.min(...candles.map((c) => c.low));
  const band = windowHigh - windowLow;
  const tightBand = a14 != null && a14 > 0 && band > 0 && band < a14 * 4;

  // Breakout: sharp expansion AND price pushing the window extreme.
  const last = candles[candles.length - 1]!;
  const nearHigh = band > 0 && (windowHigh - last.close) / band < 0.1;
  const nearLow = band > 0 && (last.close - windowLow) / band < 0.1;
  if (expansion > 1.6 && (nearHigh || nearLow)) return "BREAKOUT";

  // Volatile: large expansion without clean directional slope.
  if (expansion > 1.5 && slope < 0.0008) return "VOLATILE";

  // Trending: meaningful directional slope.
  if (slope > 0.0015) return "TRENDING";

  // Quiet: compressed and low slope.
  if (tightBand && expansion < 0.8) return "QUIET";

  // Ranging default when bounded.
  if (tightBand || slope < 0.0008) return "RANGING";

  return "TRENDING";
}

/**
 * Fold the candle-level trap signals from the Early Trend Radar (sweep / failed
 * breakout / rejection) into a single fakeout verdict with a bounded confidence.
 */
export function detectFakeout(
  candles: SignalCandle[] | null,
  early: EarlyTrendReading,
): FakeoutReading {
  if (!candles || candles.length < MIN_STRUCTURE_CANDLES || early.blind) {
    return { detected: false, kind: "NONE", confidence: 0, reason: null };
  }

  const last = candles[candles.length - 1]!;
  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;

  // Failed breakout takes precedence (a closed-beyond-then-reversed event).
  if (early.failedBreakout) {
    const bearish = last.close < last.open;
    return {
      detected: true,
      kind: "FAILED_BREAKOUT",
      confidence: round(clamp(60 + (early.score >= 50 ? 15 : 0), 0, 100)),
      reason: bearish
        ? "Price broke above then closed back below the level."
        : "Price broke below then closed back above the level.",
    };
  }

  // Liquidity sweep with directional wick → bull/bear trap.
  if (early.sweepDetected) {
    if (upperWick > lowerWick) {
      return {
        detected: true,
        kind: "BULL_TRAP",
        confidence: round(clamp(55 + (upperWick > body * 2 ? 20 : 0), 0, 100)),
        reason: "Swept liquidity above then rejected — likely bull trap.",
      };
    }
    return {
      detected: true,
      kind: "BEAR_TRAP",
      confidence: round(clamp(55 + (lowerWick > body * 2 ? 20 : 0), 0, 100)),
      reason: "Swept liquidity below then rejected — likely bear trap.",
    };
  }

  // Standalone liquidity sweep with no clear trap direction.
  if (early.rejectionDetected && early.structure === "RANGE") {
    return {
      detected: true,
      kind: "LIQUIDITY_SWEEP",
      confidence: round(clamp(45, 0, 100)),
      reason: "Rejection at range edge — possible liquidity grab.",
    };
  }

  return { detected: false, kind: "NONE", confidence: 0, reason: null };
}
