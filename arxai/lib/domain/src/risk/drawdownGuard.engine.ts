import type { RiskLimits } from "./riskProfile.types";

export type DrawdownState = "OK" | "CAUTION" | "DAILY_LIMIT" | "WEEKLY_LIMIT" | "STREAK_LIMIT";

export interface DrawdownInput {
  startingDailyBalance: number;
  startingWeeklyBalance: number;
  currentBalance: number;
  losingStreak: number;        // consecutive losing trades, current
  limits: RiskLimits;
}

export interface DrawdownReport {
  state: DrawdownState;
  dailyLossPct: number;
  weeklyLossPct: number;
  losingStreak: number;
  blocked: boolean;
  reasons: string[];
}

// Returns whether trading should be blocked based on drawdown rules.
// Pure — caller pulls inputs from the DB.
export function evaluateDrawdown(input: DrawdownInput): DrawdownReport {
  const { startingDailyBalance, startingWeeklyBalance, currentBalance, losingStreak, limits } = input;
  const reasons: string[] = [];

  const dailyLossPct  = startingDailyBalance > 0
    ? Math.max(0, (startingDailyBalance - currentBalance) / startingDailyBalance) * 100
    : 0;
  const weeklyLossPct = startingWeeklyBalance > 0
    ? Math.max(0, (startingWeeklyBalance - currentBalance) / startingWeeklyBalance) * 100
    : 0;

  if (losingStreak >= limits.stopAfterLosingStreak) {
    reasons.push(`Losing streak ${losingStreak} reached limit ${limits.stopAfterLosingStreak}`);
    return { state: "STREAK_LIMIT", dailyLossPct, weeklyLossPct, losingStreak, blocked: true, reasons };
  }
  if (dailyLossPct >= limits.maxDailyLossPct) {
    reasons.push(`Daily loss ${dailyLossPct.toFixed(2)}% reached limit ${limits.maxDailyLossPct}%`);
    return { state: "DAILY_LIMIT", dailyLossPct, weeklyLossPct, losingStreak, blocked: true, reasons };
  }
  if (weeklyLossPct >= limits.maxWeeklyLossPct) {
    reasons.push(`Weekly loss ${weeklyLossPct.toFixed(2)}% reached limit ${limits.maxWeeklyLossPct}%`);
    return { state: "WEEKLY_LIMIT", dailyLossPct, weeklyLossPct, losingStreak, blocked: true, reasons };
  }
  if (dailyLossPct >= limits.maxDailyLossPct * 0.7 || weeklyLossPct >= limits.maxWeeklyLossPct * 0.7) {
    reasons.push("Within 70% of a drawdown limit — caution advised");
    return { state: "CAUTION", dailyLossPct, weeklyLossPct, losingStreak, blocked: false, reasons };
  }
  return { state: "OK", dailyLossPct, weeklyLossPct, losingStreak, blocked: false, reasons: [] };
}
