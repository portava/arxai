// Shared strategy catalogue for the Testing Lab (backtesting + forward testing).
// Kept in one place so the page-level shared strategy selector and the
// per-tab forms stay in lockstep. These are the strategy ids the backtest
// engine (POST /api/backtest-runs) accepts.

export const TESTING_STRATEGIES = [
  "trendContinuation",
  "breakOfStructure",
  "liquiditySweep",
  "volatilityExpansion",
  "pullbackContinuation",
  "meanReversion",
  "sessionBreakout",
] as const;

export type TestingStrategyId = (typeof TESTING_STRATEGIES)[number];
