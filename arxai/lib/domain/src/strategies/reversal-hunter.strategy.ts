import type { Strategy, StrategyResult } from "./strategy.types";
import { noSignal } from "./strategy.types";

const NAME = "reversal-hunter";

// Reversal Hunter — counter-trend at exhaustion zones.
//   1. Recent price action ran a known liquidity zone (sweep)
//   2. Last candle closed back through the swept level (rejection)
//   3. Volatility ELEVATED or EXTREME (genuine flush, not chop)
//   4. Direction = opposite of the sweep
export const reversalHunterStrategy: Strategy = {
  name: NAME,
  label: "Reversal Hunter",
  version: "1.0.0",
  evaluate(input): StrategyResult {
    if (input.candles.length < 10) return noSignal(NAME, "Insufficient candles");
    if (input.volatility.state !== "ELEVATED" && input.volatility.state !== "EXTREME") {
      return noSignal(NAME, `Volatility ${input.volatility.state} — reversals need a real flush`);
    }
    const atr = input.volatility.atr;
    if (atr <= 0) return noSignal(NAME, "ATR unavailable");

    const last = input.candles[input.candles.length - 1];
    const prev = input.candles[input.candles.length - 2];

    // Sweep-and-reject above a supply zone → SELL setup
    const supply = input.liquidity.nearestSupply;
    const demand = input.liquidity.nearestDemand;

    let direction: "BUY" | "SELL" | null = null;
    let sweptLevel: number | null = null;
    let zoneStrength = 50;

    if (supply && prev.high > supply.price && last.close < supply.price) {
      direction = "SELL"; sweptLevel = supply.price; zoneStrength = supply.strength;
    } else if (demand && prev.low < demand.price && last.close > demand.price) {
      direction = "BUY"; sweptLevel = demand.price; zoneStrength = demand.strength;
    }
    if (!direction || sweptLevel == null) {
      return noSignal(NAME, "No liquidity sweep + rejection in the latest 2 candles");
    }

    // Avoid trading directly into a strong, aligned trend
    if (direction === "SELL" && input.regime.regime === "TRENDING_UP" && input.regime.confidence > 75) {
      return noSignal(NAME, "Strong uptrend — not fighting it");
    }
    if (direction === "BUY" && input.regime.regime === "TRENDING_DOWN" && input.regime.confidence > 75) {
      return noSignal(NAME, "Strong downtrend — not fighting it");
    }

    const entry = last.close;
    const slBuffer = atr * 0.5;
    const stopLoss = direction === "SELL"
      ? Math.max(prev.high, sweptLevel) + slBuffer
      : Math.min(prev.low,  sweptLevel) - slBuffer;
    const slDistance = Math.abs(entry - stopLoss);
    const takeProfit = direction === "SELL" ? entry - slDistance * 1.5 : entry + slDistance * 1.5;

    // Counter-trend trades carry a lower base confidence
    const zoneBoost = Math.min(15, zoneStrength / 8);
    const volBoost  = input.volatility.state === "EXTREME" ? 5 : 0;
    const confidence = Math.max(40, Math.min(85, Math.round(55 + zoneBoost + volBoost)));

    return {
      strategyName: NAME,
      emitted: true,
      signal: {
        action: direction, direction,
        entry, stopLoss, takeProfit,
        confidence,
        reasons: [
          `${direction === "SELL" ? "Supply" : "Demand"} sweep & reject @ ${sweptLevel.toFixed(5)}`,
          `Zone strength ${zoneStrength}`,
          `Volatility ${input.volatility.state} — genuine flush`,
          `R:R 1.5 — counter-trend, conservative target`,
        ],
      },
      rejectedReasons: [],
    };
  },
};
