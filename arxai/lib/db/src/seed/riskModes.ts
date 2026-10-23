// Canonical risk-mode presets per Phase 8 spec.
export interface RiskModePreset {
  riskMode: "Conservative" | "Balanced" | "Aggressive";
  riskPerTradePct: number;
  maxDailyLossPct: number;
  maxWeeklyLossPct: number;
  maxTradesPerDay: number;
  stopAfterLosingStreak: number;
  minConfidenceScore: number;
  maxOpenTrades: number;
}

export const RISK_MODE_PRESETS: Record<RiskModePreset["riskMode"], RiskModePreset> = {
  Conservative: { riskMode: "Conservative", riskPerTradePct: 0.25, maxDailyLossPct: 1, maxWeeklyLossPct: 3, maxTradesPerDay: 3, stopAfterLosingStreak: 2, minConfidenceScore: 80, maxOpenTrades: 1 },
  Balanced:     { riskMode: "Balanced",     riskPerTradePct: 0.5,  maxDailyLossPct: 2, maxWeeklyLossPct: 5, maxTradesPerDay: 5, stopAfterLosingStreak: 3, minConfidenceScore: 75, maxOpenTrades: 2 },
  Aggressive:   { riskMode: "Aggressive",   riskPerTradePct: 1,    maxDailyLossPct: 3, maxWeeklyLossPct: 7, maxTradesPerDay: 8, stopAfterLosingStreak: 3, minConfidenceScore: 70, maxOpenTrades: 3 },
};
