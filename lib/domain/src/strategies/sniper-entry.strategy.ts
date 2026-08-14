import type { Strategy, StrategyResult } from "./strategy.types";
import { noSignal } from "./strategy.types";

const NAME = "sniper-entry";

// Sniper Entry — only fires when multiple confluences align.
//   • Trending regime with confidence ≥ 70
//   • High-liquidity session (LONDON / NY / OVERLAP)
//   • Volatility ≤ ELEVATED (avoids EXTREME slippage)
//   • Price within 1× ATR of nearest opposing liquidity zone (sweep target)
//
// Returns base confidence 80+ — designed for low frequency, high precision.
export const sniperEntryStrategy: Strategy = {
  name: NAME,
  label: "Sniper Entry",
  version: "1.0.0",
  evaluate(input): StrategyResult {
    const reasons: string[] = [];
    if (input.regime.regime !== "TRENDING_UP" && input.regime.regime !== "TRENDING_DOWN") {
      return noSignal(NAME, "Regime not trending");
    }
    if (input.regime.confidence < 70) {
      return noSignal(NAME, `Regime confidence ${input.regime.confidence} < 70`);
    }
    if (!input.session.isHighLiquidity) {
      return noSignal(NAME, `Session ${input.session.session} not high-liquidity`);
    }
    if (input.volatility.state === "EXTREME") {
      return noSignal(NAME, "Volatility EXTREME — sniper requires ELEVATED or below");
    }

    const last = input.candles[input.candles.length - 1];
    if (!last) return noSignal(NAME, "No candles");

    const atr = input.volatility.atr;
    if (atr <= 0) return noSignal(NAME, "ATR unavailable");

    const direction = input.regime.regime === "TRENDING_UP" ? "BUY" : "SELL";

    // For a long: nearest demand zone within 1× ATR below current price = pullback entry
    // For a short: nearest supply zone within 1× ATR above current price
    const zone = direction === "BUY" ? input.liquidity.nearestDemand : input.liquidity.nearestSupply;
    if (!zone) return noSignal(NAME, `No ${direction === "BUY" ? "demand" : "supply"} zone within reach`);

    const distance = Math.abs(last.close - zone.price);
    if (distance > atr) {
      return noSignal(NAME, `Zone ${distance.toFixed(5)} away — beyond 1× ATR (${atr.toFixed(5)})`);
    }

    const entry = zone.price;
    const slBuffer = atr * 0.5;
    const stopLoss = direction === "BUY" ? entry - slBuffer - atr : entry + slBuffer + atr;
    const tpDistance = Math.abs(entry - stopLoss) * 2.5;
    const takeProfit = direction === "BUY" ? entry + tpDistance : entry - tpDistance;

    // Confidence: base 80 + boosts for stronger zone, higher regime confidence
    const zoneBoost = Math.min(15, zone.strength / 10);
    const regimeBoost = Math.min(5, (input.regime.confidence - 70) / 6);
    const confidence = Math.min(99, Math.round(80 + zoneBoost + regimeBoost));

    reasons.push(
      `${input.regime.regime} regime @ ${input.regime.confidence}% confidence`,
      `${input.session.session} session — high liquidity`,
      `${zone.kind} zone @ ${zone.price.toFixed(5)} (strength ${zone.strength}, ${zone.touches} touch${zone.touches === 1 ? "" : "es"})`,
      `Entry within ${distance.toFixed(5)} of zone (1× ATR = ${atr.toFixed(5)})`,
    );

    return {
      strategyName: NAME,
      emitted: true,
      signal: {
        action: direction,
        direction,
        entry, stopLoss, takeProfit,
        confidence,
        reasons,
      },
      rejectedReasons: [],
    };
  },
};
