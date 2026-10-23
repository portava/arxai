// Chart Brain v2 — Task 6: honest flame signal for AI-aware chart alerts.
//
// Derives a running-momentum (flame) read for a symbol/timeframe from the SAME
// real candle feed the chart uses, by reusing the existing scalp `readFlame`
// engine. This is read-only, deterministic, and NEVER fabricates:
//  - the flame STAGE is computed purely from the real candle window (momentum
//    geometry), so it is honest truth, not a guess;
//  - trade geometry the alert scan cannot know (a concrete entry/SL/TP plan) is
//    supplied as ATR-scaled NEUTRAL values so `entryTiming` is driven by the
//    real run extension, never by an invented position;
//  - on an insufficient / dirty feed `readFlame` returns a BLIND honest NONE,
//    which the alert engine treats as "no flame alert" rather than firing noise.
//
// It never trades, never writes per-user data, and fails open (returns null) on
// any error so the alert scan degrades gracefully.

import { getChartCandles } from "../data/chart/chartDataService.js";
import { readFlame } from "../scalp/flameRead.js";
import type { ChartTimeframe } from "../data/chart/timeframes.js";
import type { FlameStage, EntryTiming, ScalpDirection } from "../scalp/scalpTypes.js";
import { logger } from "../logger.js";

export interface ChartFlameSignal {
  stage: FlameStage;
  entryTiming: EntryTiming;
  blind: boolean;
  direction: ScalpDirection | null;
}

const MIN_CANDLES = 12;

export async function deriveChartFlameSignal(
  symbol: string,
  timeframe: ChartTimeframe,
  limit = 300,
): Promise<ChartFlameSignal | null> {
  try {
    const feed = await getChartCandles(symbol, timeframe, limit);
    const closed = feed.candles.filter((c) => c.isComplete);
    if (closed.length < MIN_CANDLES) {
      // Honest blind read — not enough geometry to claim a flame.
      return { stage: "NONE", entryTiming: "NO_ENTRY", blind: true, direction: null };
    }

    const last = closed[closed.length - 1]!;
    const first = closed[0]!;
    const price = last.close;
    // Directional bias from the real net drift over the window. Used only to
    // orient the momentum read — it is not a trade decision.
    const drift = last.close - first.close;
    const direction: ScalpDirection = drift >= 0 ? "BUY" : "SELL";

    // ATR-ish scale from the real recent ranges, with a tiny positive floor.
    const ranges = closed.slice(-14).map((c) => Math.max(c.high - c.low, 0));
    const atr = Math.max(
      ranges.reduce((a, b) => a + b, 0) / Math.max(ranges.length, 1),
      Math.abs(price) * 1e-6,
      1e-9,
    );
    const point = Math.max(Math.abs(price) * 1e-5, 1e-9);

    const scalpCandles = closed.map((c) => ({
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    const invalidationPrice = direction === "BUY" ? price - atr : price + atr;
    const quickTpPrice = direction === "BUY" ? price + atr : price - atr;
    const mainTpPrice = direction === "BUY" ? price + atr * 2 : price - atr * 2;

    const core = readFlame({
      direction,
      candles: scalpCandles,
      price,
      point,
      spreadPrice: 0,
      stopDist: atr,
      mainTpDist: atr * 2,
      quickTpDist: atr,
      // Neutral: we do not know how far an entry would be into a plan, so the
      // run extension (real, from the candles) is what drives lateness.
      lateFraction: 0,
      inZone: true,
      execution: null,
      htfBias: direction === "BUY" ? "bullish" : "bearish",
      personality: "BALANCED",
      scannerReason: null,
      scannerSetupType: null,
      invalidationPrice,
      quickTpPrice,
      mainTpPrice,
      digits: 5,
    });

    return {
      stage: core.read.flameStage,
      entryTiming: core.read.entryTiming,
      blind: core.blind,
      direction,
    };
  } catch (err) {
    logger.warn({ err, symbol }, "deriveChartFlameSignal failed (fail-open)");
    return null;
  }
}
