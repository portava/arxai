import type { Strategy, StrategyResult } from "./strategy.types";
import { noSignal } from "./strategy.types";

const NAME = "london-breakout";

// London Breakout — classic.
//   1. Compute Asia range (00:00–07:00 UTC) high & low
//   2. After London open (≥07:00 UTC), wait for first close beyond the range
//   3. Trade in the breakout direction; SL = opposite end of Asia range
//      TP = 1.5× range size
export const londonBreakoutStrategy: Strategy = {
  name: NAME,
  label: "London Breakout",
  version: "1.0.0",
  evaluate(input): StrategyResult {
    if (input.session.session !== "LONDON" && input.session.session !== "OVERLAP_LONDON_NY") {
      return noSignal(NAME, `Session ${input.session.session} — wait for London open`);
    }
    if (input.candles.length < 30) return noSignal(NAME, "Need at least 30 candles for Asia range");

    // Slice today's Asia session candles (UTC 00:00 → 07:00).
    const today = new Date(input.now);
    const asiaStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 0);
    const asiaEnd   = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 7);
    const asiaCandles = input.candles.filter((c) => c.time >= asiaStart && c.time < asiaEnd);
    if (asiaCandles.length < 4) return noSignal(NAME, `Only ${asiaCandles.length} Asia candles — insufficient range`);

    const asiaHigh = Math.max(...asiaCandles.map((c) => c.high));
    const asiaLow  = Math.min(...asiaCandles.map((c) => c.low));
    const range = asiaHigh - asiaLow;
    if (range <= 0) return noSignal(NAME, "Degenerate Asia range");

    // Restrict to candles after Asia close
    const postAsia = input.candles.filter((c) => c.time >= asiaEnd);
    if (postAsia.length === 0) return noSignal(NAME, "No post-Asia candles yet");
    const last = postAsia[postAsia.length - 1];

    // Breakout = close beyond the range. Take the first such candle.
    let breakDirection: "BUY" | "SELL" | null = null;
    for (const c of postAsia) {
      if (c.close > asiaHigh) { breakDirection = "BUY"; break; }
      if (c.close < asiaLow)  { breakDirection = "SELL"; break; }
    }
    if (!breakDirection) return noSignal(NAME, `Price still within Asia range [${asiaLow.toFixed(5)}, ${asiaHigh.toFixed(5)}]`);

    // Entry on current price (immediate market order); SL on opposite end + small buffer.
    const buffer = range * 0.1;
    const entry = last.close;
    const stopLoss = breakDirection === "BUY" ? asiaLow - buffer : asiaHigh + buffer;
    const tpDistance = range * 1.5;
    const takeProfit = breakDirection === "BUY" ? entry + tpDistance : entry - tpDistance;

    // Confidence: 70 base; boost when range is meaningful vs ATR, dock on extreme volatility
    const atr = input.volatility.atr;
    const rangeVsAtr = atr > 0 ? range / atr : 1;
    const rangeBoost = rangeVsAtr > 1.5 && rangeVsAtr < 5 ? 10 : 0;
    const volPenalty = input.volatility.state === "EXTREME" ? 20 : 0;
    const confidence = Math.max(40, Math.min(95, 70 + rangeBoost - volPenalty));

    return {
      strategyName: NAME,
      emitted: true,
      signal: {
        action: breakDirection,
        direction: breakDirection,
        entry, stopLoss, takeProfit,
        confidence,
        reasons: [
          `Asia range ${asiaLow.toFixed(5)} – ${asiaHigh.toFixed(5)} (${range.toFixed(5)})`,
          `Range / ATR = ${rangeVsAtr.toFixed(2)}`,
          `${breakDirection} breakout — first post-Asia close beyond range`,
          `Volatility ${input.volatility.state}`,
        ],
      },
      rejectedReasons: [],
    };
  },
};
