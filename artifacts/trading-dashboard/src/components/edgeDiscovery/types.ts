export interface EdgeReport {
  id: number;
  edgeName: string;
  symbol: string | null;
  strategyId: number | null;
  timeframe: string | null;
  sessionName: string | null;
  marketCondition: string | null;
  sampleSize: number;
  winRate: number;
  averageRr: number;
  expectancy: number;
  profitFactor: number;
  disciplineScoreAvg: number;
  executionScoreAvg: number;
  emotionalScoreAvg: number;
  confidenceScore: number;
  status: "STRONG_EDGE"|"DEVELOPING_EDGE"|"WEAK_EDGE"|"NO_EDGE"|"INSUFFICIENT_DATA";
  aiSummary: string;
  createdAt: string;
}
export interface EdgeWarning {
  id: number;
  edgeReportId: number;
  warningType: string;
  message: string;
  severity: "INFO"|"WARN"|"DANGER";
  createdAt: string;
}

export const STATUS_TONE: Record<EdgeReport["status"], string> = {
  STRONG_EDGE:       "border-success/40 bg-success/30 text-success",
  DEVELOPING_EDGE:   "border-ruby/40 bg-ruby/30 text-ruby",
  WEAK_EDGE:         "border-warning/40 bg-warning/30 text-warning",
  NO_EDGE:           "border-danger/40 bg-danger/30 text-danger",
  INSUFFICIENT_DATA: "border-border bg-muted/40 text-txt-secondary",
};
