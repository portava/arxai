export interface AnalyticsSnapshot {
  id: number; createdAt: string;
  totalTrades: number; netProfitLoss: number; winRate: number;
  averageRr: number; expectancy: number; profitFactor: number; maxDrawdown: number;
  disciplineScoreAvg: number; executionScoreAvg: number;
  emotionalScoreAvg: number; consistencyScoreAvg: number;
  strongestStrategy: string | null; weakestStrategy: string | null;
  strongestMarketCondition: string | null; weakestMarketCondition: string | null;
}
export interface StrategyRow {
  symbol: string; trades: number; winRate: number;
  totalPnl: number; expectancy: number; averageRr: number;
}
export interface EquityPoint {
  tradeId: number; openedAt: string; equity: number; peak: number; drawdown: number;
}
