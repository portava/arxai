import { db } from "@workspace/db";
import { tradesTable } from "@workspace/db";
import { eq, gte, and } from "drizzle-orm";
import { sql } from "drizzle-orm";

export interface RiskAuditInput {
  // Settings
  riskPerTradePct: number;
  maxDailyLossPct: number;
  maxWeeklyLossPct: number;
  maxTradesPerDay: number;
  maxOpenTrades: number;
  stopAfterLosingStreak: number;
  minConfidenceScore: number;
  // Signal-specific (optional)
  confidence?: number;
  riskReward?: number;
  symbol?: string;
  // Special rules
  us30BlockNews?: boolean;
  stocksBlockEarnings?: boolean;
  forexBlockEvents?: boolean;
  vol75ExtraConfidence?: boolean;
}

export interface RiskAuditResult {
  passed: boolean;
  reasonsBlocked: string[];
  warnings: string[];
  riskPercent: number;
  projectedLoss: number;
  riskReward: number;
  dailyLossUsed: number;
  weeklyLossUsed: number;
  tradesRemaining: number;
  openTradesCount: number;
  losingStreak: number;
  cooldownActive: boolean;
}

export async function computeRiskAudit(
  accountBalance: number,
  input: RiskAuditInput
): Promise<RiskAuditResult> {
  const reasonsBlocked: string[] = [];
  const warnings: string[] = [];

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  weekStart.setHours(0, 0, 0, 0);

  // ── Daily closed P&L ──────────────────────────────────────────────────────
  const todayClosed = await db
    .select()
    .from(tradesTable)
    .where(and(gte(tradesTable.closedAt, todayStart), eq(tradesTable.status, "CLOSED")));

  const dailyPnl = todayClosed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const dailyLossUsed = dailyPnl < 0 ? (Math.abs(dailyPnl) / accountBalance) * 100 : 0;

  // ── Weekly closed P&L ─────────────────────────────────────────────────────
  const weekClosed = await db
    .select()
    .from(tradesTable)
    .where(and(gte(tradesTable.closedAt, weekStart), eq(tradesTable.status, "CLOSED")));

  const weeklyPnl = weekClosed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const weeklyLossUsed = weeklyPnl < 0 ? (Math.abs(weeklyPnl) / accountBalance) * 100 : 0;

  // ── Open trades ───────────────────────────────────────────────────────────
  const openTrades = await db
    .select()
    .from(tradesTable)
    .where(eq(tradesTable.status, "OPEN"));
  const openTradesCount = openTrades.length;

  // ── Today's total trades ──────────────────────────────────────────────────
  const todayAll = await db
    .select()
    .from(tradesTable)
    .where(gte(tradesTable.createdAt, todayStart));
  const tradesRemaining = Math.max(0, input.maxTradesPerDay - todayAll.length);

  // ── Losing streak (last N closed) ─────────────────────────────────────────
  const recentClosed = await db
    .select()
    .from(tradesTable)
    .where(eq(tradesTable.status, "CLOSED"))
    .orderBy(sql`${tradesTable.closedAt} DESC`)
    .limit(input.stopAfterLosingStreak + 2);

  let losingStreak = 0;
  for (const t of recentClosed) {
    if ((t.pnl ?? 0) < 0) losingStreak++;
    else break;
  }
  const cooldownActive = losingStreak >= input.stopAfterLosingStreak;

  // ── Evaluate rules ────────────────────────────────────────────────────────

  if (dailyLossUsed >= input.maxDailyLossPct) {
    reasonsBlocked.push(
      `Daily loss limit reached: ${dailyLossUsed.toFixed(2)}% used of ${input.maxDailyLossPct}% allowed`
    );
  } else if (dailyLossUsed >= input.maxDailyLossPct * 0.75) {
    warnings.push(
      `Daily loss at ${dailyLossUsed.toFixed(1)}% — approaching limit (${input.maxDailyLossPct}%)`
    );
  }

  if (weeklyLossUsed >= input.maxWeeklyLossPct) {
    reasonsBlocked.push(
      `Weekly loss limit reached: ${weeklyLossUsed.toFixed(2)}% used of ${input.maxWeeklyLossPct}% allowed`
    );
  }

  if (tradesRemaining <= 0) {
    reasonsBlocked.push(`Daily trade limit reached (${input.maxTradesPerDay} trades today)`);
  } else if (tradesRemaining <= 2) {
    warnings.push(`Only ${tradesRemaining} trade(s) remaining today`);
  }

  if (openTradesCount >= input.maxOpenTrades) {
    reasonsBlocked.push(`Max open trades reached (${openTradesCount}/${input.maxOpenTrades})`);
  }

  if (cooldownActive) {
    reasonsBlocked.push(
      `Losing streak cooldown active (${losingStreak} consecutive losses ≥ limit of ${input.stopAfterLosingStreak})`
    );
  }

  // Confidence check
  const effectiveMinConfidence =
    input.symbol?.includes("(1s)") && input.vol75ExtraConfidence
      ? input.minConfidenceScore + 10
      : input.minConfidenceScore;

  if (input.confidence !== undefined && input.confidence < effectiveMinConfidence) {
    reasonsBlocked.push(
      `Signal confidence too low: ${input.confidence}% < required ${effectiveMinConfidence}%${effectiveMinConfidence > input.minConfidenceScore ? " (V75 1s +10 applied)" : ""}`
    );
  }

  // Symbol-specific warnings (informational, not blocking unless news is confirmed)
  if (input.symbol) {
    if (input.symbol.includes("(1s)")) {
      warnings.push("V75 (1s) Index: Extreme tick volatility — reduce lot size and widen SL.");
    }
    if (input.us30BlockNews && (input.symbol.includes("US30") || input.symbol.includes("DJ30"))) {
      warnings.push("US30: Check for major U.S. economic releases (NFP, FOMC, CPI) — news block is ON.");
    }
    if (input.stocksBlockEarnings && /^[A-Z]{2,5}$/.test(input.symbol)) {
      warnings.push(`${input.symbol}: Verify no earnings release today — stocks earnings block is ON.`);
    }
    const isFx = /[A-Z]{3}\/[A-Z]{3}|EURUSD|GBPUSD|USDJPY|AUDUSD/.test(input.symbol);
    if (input.forexBlockEvents && isFx) {
      warnings.push("Forex: Check for central bank decisions and high-impact news events.");
    }
  }

  const projectedLoss = accountBalance * (input.riskPerTradePct / 100);
  const riskReward = input.riskReward ?? 2;

  return {
    passed: reasonsBlocked.length === 0,
    reasonsBlocked,
    warnings,
    riskPercent: input.riskPerTradePct,
    projectedLoss: Math.round(projectedLoss * 100) / 100,
    riskReward,
    dailyLossUsed: Math.round(dailyLossUsed * 100) / 100,
    weeklyLossUsed: Math.round(weeklyLossUsed * 100) / 100,
    tradesRemaining,
    openTradesCount,
    losingStreak,
    cooldownActive,
  };
}
