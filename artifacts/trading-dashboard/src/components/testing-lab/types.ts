// Shared types for the Testing Lab tabs. The shapes mirror the real
// /api/backtest-runs and /api/forward-testing/results responses — no fabricated
// fields.

export interface BacktestRunRow {
  id: number;
  strategyId: string;
  symbol: string;
  timeframe: string;
  totalTrades: number;
  winRate: number; // 0..1
  profitFactor: number;
  netProfitLoss: number;
  status: string;
  // "broker" (real broker_candles history) | "synthetic" (labeled generator).
  dataSource?: string;
  isVerified: string;
  createdAt: string;
}

export interface ForwardResults {
  totalShadowDecisions: number;
  shadowTradesTracked: number;
  wins: number;
  losses: number;
  breakevens: number;
  expired: number;
  rejected: number;
  winRate: number; // already a percentage (0..100)
  avgR: number;
  maxDrawdownR: number;
  bestSymbol: string | null;
  worstSymbol: string | null;
  bestStrategy: string | null;
  weakestStrategy: string | null;
  confidenceCalibration: string;
}
