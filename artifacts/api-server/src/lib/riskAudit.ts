import { db } from "@workspace/db";
import { tradesTable } from "@workspace/db";
import { eq, gte, and, inArray, type SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { tradingDayStart } from "./riskGovernor/preTrade.js";

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

/**
 * The statuses a closed row in the legacy trades table holds (schema
 * comment, paperBook, tradeManager). Nothing writes a bare "CLOSED".
 */
export const LEGACY_CLOSED_TRADE_STATUSES = ["CLOSED_WIN", "CLOSED_LOSS"] as const;

export interface RiskAuditOptions {
  /**
   * Count closed rows by the statuses the trades table really holds
   * (LEGACY_CLOSED_TRADE_STATUSES). Without it the old filter status =
   * "CLOSED" is kept; it matches no row, so daily / weekly loss and the
   * losing streak read 0 and their checks pass unmeasured. The /risk/audit
   * view sets it. The legacy /mt5/execute check does not: what that gate
   * counts is an execution decision, left as it was.
   */
  countClosedRows?: boolean;
  /**
   * Count only this trader's rows. Without it every user's rows are counted
   * (open trades, trades today, losses, streak), as the legacy /mt5/execute
   * check still does: scoping that gate would loosen it, an execution
   * decision left as it was. The /risk/audit view sets it.
   */
  userId?: number;
  /**
   * The trader's stop switches as the pre-trade Risk Governor reads them
   * (lib/safety/tradingHalt.ts). An engaged one halts new trades whatever the
   * legacy rows say, so the audit cannot pass over it. The /risk/audit view
   * passes it. The legacy /mt5/execute check does not: adding it there would
   * change what that gate blocks, an execution decision left as it was.
   */
  halt?: RiskAuditHalt;
}

/** Which stop switches halt this trader's new trades, and on which venues. */
export interface RiskAuditHalt {
  engaged: boolean;
  /** Engaged switches (tradingHalt HaltSource codes), platform-wide ones first. */
  sources: string[];
  /** Plain-English reason for the first engaged switch; null when none is engaged. */
  reason: string | null;
  /** Venues on which new trades are halted. Empty when none is engaged. */
  venues: Array<"PAPER" | "DEMO" | "LIVE">;
}

/**
 * Combine the governor's PAPER and LIVE halt reads. Every switch that halts
 * PAPER also halts DEMO / LIVE; the platform emergency stop halts only DEMO /
 * LIVE (the paper simulator reaches no broker).
 */
export function riskAuditHaltFrom(
  paper: { engaged: boolean; sources: string[]; reason: string | null },
  live: { engaged: boolean; sources: string[]; reason: string | null },
): RiskAuditHalt {
  const engaged = paper.engaged || live.engaged;
  const src = live.engaged ? live : paper;
  return {
    engaged,
    sources: engaged ? [...src.sources] : [],
    reason: engaged ? src.reason : null,
    venues: paper.engaged ? ["PAPER", "DEMO", "LIVE"] : live.engaged ? ["DEMO", "LIVE"] : [],
  };
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
  /**
   * True when daily / weekly loss, the losing streak and the cooldown were
   * measured from closed rows (RiskAuditOptions.countClosedRows). False:
   * they were not measured and read 0 / clear whatever the real P/L.
   */
  closedTradesMeasured: boolean;
  /** Where the counts come from: the legacy simulated trades table (no new rows since /execute-trade was retired). */
  measuredFrom: "LEGACY_TRADES_TABLE";
  /** USER: only the trader's own rows were counted. ALL_USERS: every user's rows. */
  scope: "USER" | "ALL_USERS";
  /** The stop switches read for this audit (RiskAuditOptions.halt); null when they were not read. */
  tradingHalt: RiskAuditHalt | null;
}

export async function computeRiskAudit(
  accountBalance: number,
  input: RiskAuditInput,
  opts: RiskAuditOptions = {},
): Promise<RiskAuditResult> {
  const reasonsBlocked: string[] = [];
  const warnings: string[] = [];
  const closedTradesMeasured = opts.countClosedRows === true;
  const isClosed: SQL = closedTradesMeasured
    ? inArray(tradesTable.status, [...LEGACY_CLOSED_TRADE_STATUSES])
    : eq(tradesTable.status, "CLOSED");
  const scoped = opts.userId != null;
  // and() of one condition is that condition; with a user it adds user_id = ?.
  const own = (cond: SQL): SQL => (scoped ? and(cond, eq(tradesTable.userId, opts.userId!))! : cond);

  // The Risk Governor's trading day (owner decision 9): UTC midnight, not
  // server-local midnight. The trade-count source here is still the legacy
  // trades table (listed in docs/TIER1_RISK_GOVERNOR_SOURCE.md).
  const todayStart = tradingDayStart(new Date());

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  weekStart.setHours(0, 0, 0, 0);

  // ── Daily closed P&L ──────────────────────────────────────────────────────
  const todayClosed = await db
    .select()
    .from(tradesTable)
    .where(own(and(gte(tradesTable.closedAt, todayStart), isClosed)!));

  // A row whose P/L is UNKNOWN is left out of every P/L sum (trades schema).
  const knownPnl = (t: { pnlStatus: string | null }) => t.pnlStatus !== "UNKNOWN";
  const dailyUnknown = todayClosed.filter((t) => !knownPnl(t)).length;
  if (dailyUnknown > 0) {
    warnings.push(`${dailyUnknown} trade(s) closed today have no known P/L and are not counted in daily loss.`);
  }
  const dailyPnl = todayClosed.filter(knownPnl).reduce((s, t) => s + (t.pnl ?? 0), 0);
  const dailyLossUsed = dailyPnl < 0 ? (Math.abs(dailyPnl) / accountBalance) * 100 : 0;

  // ── Weekly closed P&L ─────────────────────────────────────────────────────
  const weekClosed = await db
    .select()
    .from(tradesTable)
    .where(own(and(gte(tradesTable.closedAt, weekStart), isClosed)!));

  const weeklyPnl = weekClosed.filter(knownPnl).reduce((s, t) => s + (t.pnl ?? 0), 0);
  const weeklyLossUsed = weeklyPnl < 0 ? (Math.abs(weeklyPnl) / accountBalance) * 100 : 0;

  // ── Open trades ───────────────────────────────────────────────────────────
  const openTrades = await db
    .select()
    .from(tradesTable)
    .where(own(eq(tradesTable.status, "OPEN")));
  const openTradesCount = openTrades.length;

  // ── Today's total trades ──────────────────────────────────────────────────
  const todayAll = await db
    .select()
    .from(tradesTable)
    .where(own(gte(tradesTable.createdAt, todayStart)));
  const tradesRemaining = Math.max(0, input.maxTradesPerDay - todayAll.length);

  // ── Losing streak (last N closed) ─────────────────────────────────────────
  const recentClosed = await db
    .select()
    .from(tradesTable)
    .where(own(isClosed))
    .orderBy(sql`${tradesTable.closedAt} DESC`)
    .limit(input.stopAfterLosingStreak + 2);

  let losingStreak = 0;
  for (const t of recentClosed) {
    const lost = knownPnl(t) ? (t.pnl ?? 0) < 0 : t.status === "CLOSED_LOSS";
    if (lost) losingStreak++;
    else break;
  }
  const cooldownActive = losingStreak >= input.stopAfterLosingStreak;

  // ── Evaluate rules ────────────────────────────────────────────────────────

  // An engaged stop switch halts new trades before any legacy rule applies.
  if (opts.halt?.engaged) {
    reasonsBlocked.push(
      `New trades are halted on ${opts.halt.venues.join(", ") || "your account"}: ${opts.halt.reason ?? "a stop switch is engaged."}`
    );
  }

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
    closedTradesMeasured,
    measuredFrom: "LEGACY_TRADES_TABLE",
    scope: scoped ? "USER" : "ALL_USERS",
    tradingHalt: opts.halt ?? null,
  };
}
