import type { Strategy, StrategyResult } from "./strategy.types";
import { noSignal } from "./strategy.types";

const NAME = "trend-continuation";

// Trend Continuation — buy the dip in uptrends, sell the rip in downtrends.
//   1. Regime must be TRENDING_*
//   2. Price must have pulled back to / through SMA20 then closed back in the
//      trend direction within the last 2 candles
//   3. SL = 1.5× ATR opposite trend; TP = 2× SL distance
export const trendContinuationStrategy: Strategy = {
  name: NAME,
  label: "Trend Continuation",
  version: "1.0.0",
  evaluate(input): StrategyResult {
    if (input.regime.regime !== "TRENDING_UP" && input.regime.regime !== "TRENDING_DOWN") {
      return noSignal(NAME, "Regime not trending");
    }
    if (input.candles.length < 25) return noSignal(NAME, "Need ≥25 candles for SMA20");
    const atr = input.volatility.atr;
    if (atr <= 0) return noSignal(NAME, "ATR unavailable");

    const last = input.candles[input.candles.length - 1];
    const prev = input.candles[input.candles.length - 2];
    const sma20 = mean(input.candles.slice(-20).map((c) => c.close));
    const direction = input.regime.regime === "TRENDING_UP" ? "BUY" : "SELL";

    // Pullback condition: previous candle touched/crossed SMA20 in the
    // counter-trend direction; current candle closed back in trend direction.
    const pulled = direction === "BUY"
      ? prev.low  <= sma20 && last.close > sma20
      : prev.high >= sma20 && last.close < sma20;
    if (!pulled) return noSignal(NAME, `No pullback through SMA20 (${sma20.toFixed(5)}) yet`);

    // Confirmation: current candle closed in trend direction
    const inDirection = direction === "BUY" ? last.close > last.open : last.close < last.open;
    if (!inDirection) return noSignal(NAME, "Confirmation candle not in trend direction");

    const entry = last.close;
    const slDistance = atr * 1.5;
    const stopLoss = direction === "BUY" ? entry - slDistance : entry + slDistance;
    const takeProfit = direction === "BUY" ? entry + slDistance * 2 : entry - slDistance * 2;

    const regimeBoost = Math.min(15, (input.regime.confidence - 50) / 3);
    const volPenalty = input.volatility.state === "EXTREME" ? 15
                     : input.volatility.state === "CALM"    ? 10  // chop risk in dead markets
                     : 0;
    const confidence = Math.max(45, Math.min(90, Math.round(65 + regimeBoost - volPenalty)));

    return {
      strategyName: NAME,
      emitted: true,
      signal: {
        action: direction, direction,
        entry, stopLoss, takeProfit,
        confidence,
        reasons: [
          `${input.regime.regime} regime @ ${input.regime.confidence}% confidence`,
          `Pullback through SMA20 (${sma20.toFixed(5)}) confirmed by trend-side close`,
          `ATR ${atr.toFixed(5)} → SL ${slDistance.toFixed(5)} away, TP 2:1`,
          `Volatility ${input.volatility.state}`,
        ],
      },
      rejectedReasons: [],
    };
  },
};

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
