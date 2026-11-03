/** The analytics figures: computed now (GET .current) or as saved in a snapshot. */
export interface AnalyticsFigures {
  totalTrades: number; netProfitLoss: number; winRate: number;
  averageRr: number; expectancy: number; profitFactor: number; maxDrawdown: number;
  disciplineScoreAvg: number; executionScoreAvg: number;
  emotionalScoreAvg: number; consistencyScoreAvg: number;
  strongestStrategy: string | null; weakestStrategy: string | null;
  strongestMarketCondition: string | null; weakestMarketCondition: string | null;
  // Live figures only (not snapshot columns): what the highlights really are.
  /** Net-profitable symbol with the highest net P&L (the stored "strategy" column holds a symbol). */
  strongestSymbol?: string | null;
  /** Net-losing symbol with the lowest net P&L. */
  weakestSymbol?: string | null;
  strongestEdgeSlice?: EdgeSliceHighlight | null;
  weakestEdgeSlice?: EdgeSliceHighlight | null;
  highlightBasis?: { symbols: string; edgeSlices: string };
}
/** A slice from Edge Discovery's current reports, as the edge board rates it. */
export interface EdgeSliceHighlight {
  edgeName: string; label: string; status: string; statusWords: string;
  confidenceScore: number; sampleSize: number; reportedAt: string | null;
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
