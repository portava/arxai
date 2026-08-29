import type { StrategyContract } from "./strategyContract.types";

// Declarative contract for the hand-written london-breakout strategy
// (strategies/london-breakout.strategy.ts, v1.0.0). Every rule below is an
// independent restatement of that engine's decision logic as data; the
// compiler proves the two agree over frozen replays. If either side changes
// without the other, test:strategy-contract-compiler fails loudly.
export const londonBreakoutContract: StrategyContract = {
  contractId: "london-breakout@1.0.0",
  strategyName: "london-breakout",
  strategyVersion: "1.0.0",
  eligibility: [
    {
      id: "session-london",
      describe: "only trades during LONDON or the London/NY overlap",
      rule: { op: "IN", feature: "session", values: ["LONDON", "OVERLAP_LONDON_NY"] },
    },
    {
      id: "min-candles",
      describe: "needs ≥30 candles to establish the Asia range context",
      rule: { op: "GTE", feature: "candleCount", value: 30 },
    },
    {
      id: "asia-candles",
      describe: "needs ≥4 candles inside today's 00:00–07:00 UTC Asia window",
      rule: { op: "GTE", feature: "asiaCandleCount", value: 4 },
    },
    {
      id: "post-asia-candles",
      describe: "needs at least one candle after the Asia window closes",
      rule: { op: "GTE", feature: "postAsiaCandleCount", value: 1 },
    },
    {
      id: "breakout-happened",
      describe: "a post-Asia close beyond the Asia range must exist",
      rule: { op: "NOT_NULL", feature: "postAsiaBreakDirection" },
    },
  ],
  invalidation: [
    {
      id: "degenerate-asia-range",
      describe: "a zero/negative Asia range forbids trading (breaker)",
      rule: { op: "LTE", feature: "asiaRangeSize", value: 0 },
    },
  ],
  directionFeature: "postAsiaBreakDirection",
  exit: {
    stopRequired: true,
    takeProfitRequired: true,
    rules: [
      {
        id: "stop-beyond-asia-range",
        describe: "stop must sit beyond the opposite end of the Asia range",
        rule: { op: "EQ", feature: "stopBeyondAsiaRange", value: true },
      },
      {
        id: "tp-1p5x-asia-range",
        describe: "take-profit distance must be 1.5× the Asia range size",
        rule: { op: "APPROX", feature: "tpDistanceVsAsiaRange", value: 1.5, tolerance: 1e-6 },
      },
    ],
  },
  confidence: { min: 40, max: 95 },
};
