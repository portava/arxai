import type { StrategyContract } from "./strategyContract.types";

// Declarative contract for the hand-written trend-continuation strategy
// (strategies/trend-continuation.strategy.ts, v1.0.0). Rules restate the
// engine's decision logic as data over the independent feature library; the
// compiler proves engine and contract agree over frozen replays.
export const trendContinuationContract: StrategyContract = {
  contractId: "trend-continuation@1.0.0",
  strategyName: "trend-continuation",
  strategyVersion: "1.0.0",
  eligibility: [
    {
      id: "trending-regime",
      describe: "only trades in TRENDING_UP or TRENDING_DOWN regimes",
      rule: { op: "IN", feature: "regime", values: ["TRENDING_UP", "TRENDING_DOWN"] },
    },
    {
      id: "min-candles",
      describe: "needs ≥25 candles for the SMA20 pullback structure",
      rule: { op: "GTE", feature: "candleCount", value: 25 },
    },
    {
      id: "atr-available",
      describe: "ATR must be available and positive to size the stop",
      rule: { op: "GT", feature: "atr", value: 0 },
    },
    {
      id: "pullback-through-sma20",
      describe: "previous candle must touch/cross SMA20 counter-trend; last close back on trend side",
      rule: { op: "EQ", feature: "pullbackThroughSma20", value: true },
    },
    {
      id: "confirmation-candle",
      describe: "confirmation candle body must close in the trend direction",
      rule: { op: "EQ", feature: "confirmationCandleTrendSide", value: true },
    },
  ],
  invalidation: [
    {
      id: "unknown-regime",
      describe: "an UNKNOWN regime forbids trading (breaker)",
      rule: { op: "EQ", feature: "regime", value: "UNKNOWN" },
    },
  ],
  directionFeature: "trendDirection",
  exit: {
    stopRequired: true,
    takeProfitRequired: true,
    rules: [
      {
        id: "stop-1p5x-atr",
        describe: "stop distance must be 1.5× ATR",
        rule: { op: "APPROX", feature: "stopDistanceVsAtr", value: 1.5, tolerance: 1e-6 },
      },
      {
        id: "rr-2to1",
        describe: "reward:risk must be 2:1",
        rule: { op: "APPROX", feature: "rewardRiskRatio", value: 2.0, tolerance: 1e-6 },
      },
    ],
  },
  confidence: { min: 45, max: 90 },
};
