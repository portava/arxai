/** The analytics figures: computed now (GET .current) or as saved in a snapshot. */
export interface AnalyticsFigures {
  totalTrades: number; netProfitLoss: number; winRate: number;
  averageRr: number; expectancy: number; profitFactor: number; maxDrawdown: number;
  disciplineScoreAvg: number; executionScoreAvg: number;
  emotionalScoreAvg: number; consistencyScoreAvg: number;
  strongestStrategy: string | null; weakestStrategy: string | null;
  strongestMarketCondition: string | null; weakestMarketCondition: string | null;
}
/** A saved snapshot row; createdAt is when it was computed. */
export interface AnalyticsSnapshot extends AnalyticsFigures {
  id: number; createdAt: string;
}
/** GET /analytics/snapshot .current — the figures computed at asOf from every paper order. */
export interface AnalyticsCurrent extends AnalyticsFigures {
  asOf: string;
}
export interface StrategyRow {
  symbol: string; trades: number; winRate: number;
  totalPnl: number; expectancy: number; averageRr: number;
}
export interface EquityPoint {
  tradeId: number; openedAt: string; equity: number; peak: number; drawdown: number;
}
