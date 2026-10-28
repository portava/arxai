// Per-user risk profile: presets, prop-firm limits and the budget view.
//
// Replaces the old in-memory "Risk Governor 2.0" profile, which was one global
// profile for every user and reset on restart. A preset or a prop-firm setup
// is now written into the trader's own user_risk_settings row, where the one
// pre-trade Risk Governor reads it (strictest of trader, admin and platform
// wins, so a preset can never loosen an admin or platform limit). The views
// here are read models of the governor's own facts; they decide nothing.

import { and, desc, eq, gte } from "drizzle-orm";
import { db, userRiskEventsTable, userRiskSettingsTable } from "@workspace/db";
import { buildRiskContext } from "./enforce.js";
import { tradingDayStart, type RiskContext, type RiskVenue } from "./preTrade.js";
import { readActivePaperAccount, sumPaperRealizedSince } from "../tradeEngine/paperBookReader.js";
import { getOrCreateRiskSettings } from "./riskEvents.js";
import { loadEffectiveLimits } from "./limitSettings.js";
import { loadPlatformHalt } from "../safety/tradingHalt.js";

export const RISK_PRESETS = ["ULTRA_CONSERVATIVE", "CONSERVATIVE", "BALANCED_TESTER", "AGGRESSIVE_SIMULATOR", "PROP_FIRM_CHALLENGE"] as const;
export type RiskPreset = (typeof RISK_PRESETS)[number];

type PresetColumns = Pick<typeof userRiskSettingsTable.$inferInsert,
  "maxRiskPerTradeAmount" | "maxDailyLossAmount" | "maxWeeklyLossAmount" | "maxOpenTrades" | "maxPositionsPerSymbol"
  | "maxTradesPerDay" | "maxPositionSize" | "minRewardRiskRatio" | "maxConsecutiveLosses" | "blockAfterConsecutiveLosses"
  | "cooldownAfterLossMinutes" | "requireTakeProfit">;

// The same numbers the old presets carried, mapped onto the trader's columns.
export const PRESET_LIMITS: Record<RiskPreset, PresetColumns> = {
  ULTRA_CONSERVATIVE: { maxRiskPerTradeAmount: 5, maxDailyLossAmount: 15, maxWeeklyLossAmount: 50, maxOpenTrades: 1, maxPositionsPerSymbol: 1,
    maxTradesPerDay: 2, maxPositionSize: 0.02, minRewardRiskRatio: 2.5, maxConsecutiveLosses: 1, blockAfterConsecutiveLosses: true,
    cooldownAfterLossMinutes: 30, requireTakeProfit: true },
  CONSERVATIVE: { maxRiskPerTradeAmount: 15, maxDailyLossAmount: 50, maxWeeklyLossAmount: 200, maxOpenTrades: 2, maxPositionsPerSymbol: 1,
    maxTradesPerDay: 5, maxPositionSize: 0.05, minRewardRiskRatio: 1.8, maxConsecutiveLosses: 2, blockAfterConsecutiveLosses: true,
    cooldownAfterLossMinutes: 15, requireTakeProfit: true },
  BALANCED_TESTER: { maxRiskPerTradeAmount: 30, maxDailyLossAmount: 150, maxWeeklyLossAmount: 500, maxOpenTrades: 3, maxPositionsPerSymbol: 2,
    maxTradesPerDay: 10, maxPositionSize: 0.1, minRewardRiskRatio: 1.5, maxConsecutiveLosses: 3, blockAfterConsecutiveLosses: true,
    cooldownAfterLossMinutes: 10, requireTakeProfit: true },
  AGGRESSIVE_SIMULATOR: { maxRiskPerTradeAmount: 100, maxDailyLossAmount: 500, maxWeeklyLossAmount: 2000, maxOpenTrades: 5, maxPositionsPerSymbol: 3,
    maxTradesPerDay: 25, maxPositionSize: 0.5, minRewardRiskRatio: 1.2, maxConsecutiveLosses: 5, blockAfterConsecutiveLosses: true,
    cooldownAfterLossMinutes: 2, requireTakeProfit: true },
  PROP_FIRM_CHALLENGE: { maxRiskPerTradeAmount: 50, maxDailyLossAmount: 250, maxWeeklyLossAmount: 750, maxOpenTrades: 3, maxPositionsPerSymbol: 1,
    maxTradesPerDay: 8, maxPositionSize: 0.2, minRewardRiskRatio: 2, maxConsecutiveLosses: 2, blockAfterConsecutiveLosses: true,
    cooldownAfterLossMinutes: 20, requireTakeProfit: true },
};

export interface PropFirmConfig {
  enabled: boolean;
  startingBalance: number;
  profitTarget: number;
  maxDailyDrawdownUsd: number;
  maxTotalDrawdownUsd: number;
  minTradingDays: number;
  maxLotSize: number;
  maxPositions: number;
  newsTradingAllowed: boolean;
  weekendHoldingAllowed: boolean;
  consistencyRulePctOfTotal: number;
  /**
   * Where the challenge is measured from: the paper account and its stored
   * equity when the challenge was started (turned on, or Reset). Set by
   * configurePropFirm only; null/absent = not recorded, so progress cannot be
   * measured (a challenge saved before this was tracked, or started with no
   * active paper account).
   */
  challengeStart?: PropFirmChallengeStart | null;
}

export interface PropFirmChallengeStart {
  /** When the challenge was started (ISO). */
  at: string;
  paperAccountId: number;
  /** The paper account's stored equity at that moment … */
  equity: number;
  /** … and when that equity was last marked (paper_accounts.updated_at, ISO). */
  equityAsOf: string;
}

export const DEFAULT_PROP_FIRM: PropFirmConfig = {
  enabled: false, startingBalance: 100_000, profitTarget: 8_000,
  maxDailyDrawdownUsd: 5_000, maxTotalDrawdownUsd: 10_000, minTradingDays: 5,
  maxLotSize: 1.0, maxPositions: 3, newsTradingAllowed: false,
  weekendHoldingAllowed: false, consistencyRulePctOfTotal: 40,
};

/** Write a preset into the trader's own settings. Platform and admin limits still bound it. */
export async function applyRiskPreset(userId: number, preset: RiskPreset) {
  await getOrCreateRiskSettings(userId);
  const [row] = await db.update(userRiskSettingsTable)
    .set({ ...PRESET_LIMITS[preset], riskPreset: preset, updatedAt: new Date() })
    .where(eq(userRiskSettingsTable.userId, userId)).returning();
  return row!;
}

/**
 * Enable or change prop-firm mode. The challenge's daily and total drawdown,
 * lot and position caps become the trader's limits (drawdown as a percent of
 * the challenge balance). Turning it off keeps the limits until the trader
 * changes them, so switching off never silently loosens protection.
 *
 * The challenge is measured from the active paper account's equity when it
 * starts: turning the mode on, `restart` (Reset), or saving an enabled
 * challenge that has no recorded start. Editing an enabled challenge keeps
 * its start, so progress is not wiped by changing a target.
 */
export async function configurePropFirm(userId: number, patch: Partial<PropFirmConfig>, opts: { restart?: boolean } = {}) {
  const current = await getOrCreateRiskSettings(userId);
  const prev = (current.propFirm as Partial<PropFirmConfig> | null) ?? {};
  const { challengeStart: _clientStart, ...edits } = patch;
  const cfg: PropFirmConfig = { ...DEFAULT_PROP_FIRM, ...prev, ...edits };
  if (cfg.enabled && (opts.restart || !prev.enabled || !prev.challengeStart)) {
    const acct = await readActivePaperAccount(userId);
    cfg.challengeStart = acct
      ? { at: new Date().toISOString(), paperAccountId: acct.id, equity: acct.equity, equityAsOf: acct.updatedAt.toISOString() }
      : null;
  }
  const limits = cfg.enabled ? {
    maxDailyLossAmount: cfg.maxDailyDrawdownUsd,
    maxDrawdownPercent: cfg.startingBalance > 0 ? Number(((cfg.maxTotalDrawdownUsd / cfg.startingBalance) * 100).toFixed(2)) : null,
    maxPositionSize: cfg.maxLotSize,
    maxOpenTrades: Math.max(1, Math.round(cfg.maxPositions)),
  } : {};
  const [row] = await db.update(userRiskSettingsTable)
    .set({ ...limits, propFirm: cfg, updatedAt: new Date() })
    .where(eq(userRiskSettingsTable.userId, userId)).returning();
  return { config: cfg, settings: row! };
}

async function governorFacts(userId: number, venue: RiskVenue): Promise<RiskContext> {
  return buildRiskContext({ userId, venue, origin: "manual", action: "OPEN", symbol: "EURUSD", side: "BUY", lots: 0.01 },
    { facts: { quote: null } });
}

const r2 = (n: number) => Number(n.toFixed(2));

/** The trader's budget as the Risk Governor sees it on one venue. */
export async function riskOverview(userId: number, venue: RiskVenue = "PAPER") {
  const settings = await getOrCreateRiskSettings(userId);
  const ctx = await governorFacts(userId, venue);
  const L = ctx.limits;
  const equity = ctx.account?.equity ?? null;
  const realized = ctx.daily.realizedPnl ?? 0;
  const floatingLoss = ctx.daily.floatingPnl != null && ctx.daily.floatingPnl < 0 ? ctx.daily.floatingPnl : 0;
  const dailyUsed = Math.max(0, -(realized + floatingLoss));
  const caps = [L.maxDailyLossAmount, L.maxDailyLossPercent != null && equity != null ? (equity * L.maxDailyLossPercent) / 100 : null]
    .filter((v): v is number => v != null);
  const dailyLimit = caps.length ? Math.min(...caps) : null;
  const weekUsed = Math.max(0, -(ctx.activity?.weekRealizedPnl ?? 0));
  const wcaps = [L.discipline.maxWeeklyLossAmount, L.discipline.maxWeeklyLossPercent != null && equity != null ? (equity * L.discipline.maxWeeklyLossPercent) / 100 : null]
    .filter((v): v is number => v != null);
  const weeklyLimit = wcaps.length ? Math.min(...wcaps) : null;
  const openRisk = ctx.positions.reduce((s, p) => {
    const inst = ctx.instruments[p.symbol];
    if (p.stopLoss == null || !inst?.contractSize) return s;
    return s + Math.abs(p.entryPrice - p.stopLoss) * p.lots * inst.contractSize * (inst.quoteToAccountFx ?? 1);
  }, 0);
  const halt = ctx.halt ?? { engaged: false, sources: [], reason: null };
  const status = halt.engaged || (dailyLimit != null && dailyUsed >= dailyLimit) || (weeklyLimit != null && weekUsed >= weeklyLimit)
    ? "BLOCK" : dailyLimit != null && dailyUsed > dailyLimit * 0.7 ? "CAUTION" : "OK";
  return {
    venue,
    preset: settings.riskPreset ?? null,
    limits: L,
    budget: {
      dailyRiskLimit: dailyLimit != null ? r2(dailyLimit) : null, dailyRiskUsed: r2(dailyUsed),
      dailyRiskRemaining: dailyLimit != null ? r2(dailyLimit - dailyUsed) : null,
      weeklyRiskLimit: weeklyLimit != null ? r2(weeklyLimit) : null, weeklyRiskUsed: r2(weekUsed),
      weeklyRiskRemaining: weeklyLimit != null ? r2(weeklyLimit - weekUsed) : null,
      openRisk: r2(openRisk), openPositions: ctx.positions.length, equity, riskStatus: status,
    },
    activity: ctx.activity ?? null,
    halt,
    permissions: { trading: !halt.engaged, pauseReason: halt.reason },
  };
}

export type PropFirmStatusCode = "OFF" | "NOT_MEASURED" | "ACTIVE" | "WARNING" | "FAILED" | "TARGET_REACHED" | "PASSED";
export interface PropFirmRuleNotChecked { rule: string; reason: string }

/**
 * The challenge rules this view does not evaluate, with what (if anything)
 * stands behind them. Only the profit target and today's / current
 * drawdown are measured; everything here is listed as not checked, so a
 * reached target can never read as a passed challenge.
 */
function uncheckedChallengeRules(
  cfg: PropFirmConfig,
  limits: { maxLotSize: number; discipline: { maxOpenTrades: number | null } } | null,
  // Caveats on the two drawdown rules, when they were measured.
  drawdown: { earlierDays: boolean; lowestEquity: boolean },
): PropFirmRuleNotChecked[] {
  const out: PropFirmRuleNotChecked[] = [];
  if (drawdown.earlierDays) out.push({ rule: "DAILY_DD_EARLIER_DAYS", reason: "Only today's loss is checked. Daily losses on earlier days of the challenge are not." });
  if (drawdown.lowestEquity) out.push({ rule: "TOTAL_DD_LOWEST_EQUITY", reason: "Only current equity is checked. A deeper dip earlier in the challenge is not recorded." });
  out.push({ rule: "MIN_TRADING_DAYS", reason: `Trading days are not counted, so the minimum of ${cfg.minTradingDays} days is not checked.` });
  out.push({ rule: "CONSISTENCY", reason: `The ${cfg.consistencyRulePctOfTotal}% consistency rule (best day against total profit) is not checked.` });
  if (!cfg.newsTradingAllowed) out.push({ rule: "NEWS_TRADING", reason: "Trades opened around news are not checked against the no-news-trading rule." });
  if (!cfg.weekendHoldingAllowed) out.push({ rule: "WEEKEND_HOLDING", reason: "Positions held over a weekend are not checked against the no-weekend-holding rule." });
  const lot = limits?.maxLotSize ?? null;
  out.push({ rule: "MAX_LOT_SIZE", reason: `Your trades are not checked against the ${cfg.maxLotSize}-lot cap. `
    + (lot == null ? "Your lot limit in force could not be read."
      : lot <= cfg.maxLotSize ? `The Risk Governor refuses new orders above ${lot} lots (your limit in force).`
        : `Your lot limit in force is ${lot}, above the cap, so larger orders are not refused.`) });
  const open = limits ? limits.discipline.maxOpenTrades : undefined;
  out.push({ rule: "MAX_POSITIONS", reason: `Your trades are not checked against the ${cfg.maxPositions}-position cap. `
    + (open === undefined ? "Your open-trade limit in force could not be read."
      : open == null ? "No open-trade limit is in force, so extra positions are not refused."
        : open <= cfg.maxPositions ? `The Risk Governor refuses a new order when ${open} trades are open (your limit in force).`
          : `Your open-trade limit in force is ${open}, above the cap, so extra positions are not refused.`) });
  return out;
}

/**
 * Prop-firm progress on the paper ledger, against the trader's stored challenge.
 *
 * Measured from the challenge start (config.challengeStart): profit is the
 * active paper account's stored equity minus its equity when the challenge
 * started, and today's drawdown counts paper P/L settled since the later of
 * the trading day's start and the challenge start, plus the current floating
 * loss. Equity is the account's last stored mark (equityAsOf).
 *
 * A rule is scored (passed / failed) only when that measurement exists. With
 * no active paper account, no recorded challenge start, or a start on a
 * different paper account, nothing is measured: the money figures are null,
 * no rule is passed or failed, each such rule is in `notChecked` with the
 * reason, and an enabled challenge reads NOT_MEASURED, never ACTIVE.
 */
export async function propFirmStatus(userId: number, now: Date = new Date()) {
  const settings = await getOrCreateRiskSettings(userId);
  const cfg: PropFirmConfig = { ...DEFAULT_PROP_FIRM, ...((settings.propFirm as Partial<PropFirmConfig> | null) ?? {}) };
  const acct = await readActivePaperAccount(userId);
  const limits = await loadEffectiveLimits(userId).catch(() => null);
  const start = cfg.challengeStart ?? null;
  const passed: string[] = []; const failed: string[] = [];
  const notChecked: PropFirmRuleNotChecked[] = [];
  const notes: string[] = [];
  const base = {
    config: cfg, equitySource: "paper_ledger" as const,
    paperAccountId: acct?.id ?? null,
    equityUsd: acct ? r2(acct.equity) : null,
    /** When the paper account's equity was last marked; equity is not re-read live. */
    equityAsOf: acct ? acct.updatedAt.toISOString() : null,
    challengeStartedAt: start?.at ?? null,
    startEquityUsd: start ? r2(start.equity) : null,
  };

  const notMeasuredReason = !acct
    ? "No active paper account, so paper equity could not be read."
    : !start
      ? "The challenge start was not recorded, so there is no starting equity to measure from. Press Reset to start the challenge from your paper account's current equity."
      : start.paperAccountId !== acct.id
        ? `The challenge started on paper account #${start.paperAccountId}, but your active paper account is #${acct.id}. Press Reset to restart the challenge on #${acct.id}.`
        : null;

  if (notMeasuredReason != null || !acct || !start) {
    const reason = notMeasuredReason ?? "Not measured.";
    for (const rule of ["PROFIT_TARGET", "DAILY_DD", "TOTAL_DD"]) notChecked.push({ rule, reason });
    notChecked.push(...uncheckedChallengeRules(cfg, limits, { earlierDays: false, lowestEquity: false }));
    return {
      ...base, measured: false, notMeasuredReason: reason as string | null,
      profitUsd: null as number | null, profitTargetProgress: null as number | null,
      dailyDrawdownRemainingUsd: null as number | null, totalDrawdownRemainingUsd: null as number | null,
      dailyDrawdownSince: null as string | null,
      passed, failed, notChecked, notes,
      status: (cfg.enabled ? "NOT_MEASURED" : "OFF") as PropFirmStatusCode,
    };
  }

  const profit = acct.equity - start.equity;
  const dayStart = tradingDayStart(now).getTime();
  const since = new Date(Math.max(dayStart, Date.parse(start.at) || 0));
  const realizedToday = await sumPaperRealizedSince({ account: acct.id }, since);
  const floating = acct.equity - acct.currentBalance;
  const dailyDD = Math.max(0, -(realizedToday + Math.min(0, floating)));
  const totalDD = Math.max(0, -profit);
  if (Math.abs(cfg.startingBalance - start.equity) >= 0.01) {
    notes.push(`The challenge size is $${cfg.startingBalance}, but your paper account started the challenge with $${r2(start.equity)} equity. `
      + `Profit, target and drawdown are measured in dollars from $${r2(start.equity)} and are not scaled.`);
  }
  if (profit >= cfg.profitTarget) passed.push("PROFIT_TARGET");
  if (dailyDD >= cfg.maxDailyDrawdownUsd) failed.push("DAILY_DD"); else passed.push("DAILY_DD");
  if (totalDD >= cfg.maxTotalDrawdownUsd) failed.push("TOTAL_DD"); else passed.push("TOTAL_DD");
  notChecked.push(...uncheckedChallengeRules(cfg, limits, { earlierDays: !(Date.parse(start.at) >= dayStart), lowestEquity: true }));
  // A reached target is not a passed challenge while any rule is unchecked.
  const status: PropFirmStatusCode = !cfg.enabled ? "OFF" : failed.length ? "FAILED"
    : profit >= cfg.profitTarget ? (notChecked.length ? "TARGET_REACHED" : "PASSED")
    : dailyDD > cfg.maxDailyDrawdownUsd * 0.7 || totalDD > cfg.maxTotalDrawdownUsd * 0.7 ? "WARNING" : "ACTIVE";
  return {
    ...base, measured: true, notMeasuredReason: null as string | null,
    profitUsd: r2(profit) as number | null,
    profitTargetProgress: (cfg.profitTarget > 0 ? r2((profit / cfg.profitTarget) * 100) : 0) as number | null,
    dailyDrawdownRemainingUsd: r2(cfg.maxDailyDrawdownUsd - dailyDD) as number | null,
    totalDrawdownRemainingUsd: r2(cfg.maxTotalDrawdownUsd - totalDD) as number | null,
    /** Today's drawdown counts paper P/L settled from here (trading-day start or challenge start, whichever is later). */
    dailyDrawdownSince: since.toISOString() as string | null,
    passed, failed, notChecked, notes, status,
  };
}

export interface RiskEventView {
  eventId: string; ts: string; userId: number; symbol?: string; source?: string;
  rule: string; severity: "INFO" | "WARN" | "BLOCK"; decision: string; explanation: string;
}

/** Risk Governor audit rows (user_risk_events), newest first. `userId` = one trader; omit for the operator view. */
export async function listRiskEventsView(opts: { userId?: number; limit?: number; since?: Date } = {}): Promise<RiskEventView[]> {
  const conds = [
    opts.userId != null ? eq(userRiskEventsTable.userId, opts.userId) : undefined,
    opts.since ? gte(userRiskEventsTable.createdAt, opts.since) : undefined,
  ].filter((c) => c != null);
  const rows = await db.select().from(userRiskEventsTable).where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(userRiskEventsTable.createdAt)).limit(Math.min(opts.limit ?? 200, 2000));
  return rows.map((r) => {
    const d = (r.details ?? {}) as Record<string, unknown>;
    const intent = (d["intent"] ?? {}) as Record<string, unknown>;
    return {
      eventId: `ure_${r.id}`, ts: r.createdAt.toISOString(), userId: r.userId,
      symbol: typeof intent["symbol"] === "string" ? intent["symbol"] : undefined,
      source: typeof intent["origin"] === "string" ? intent["origin"] : undefined,
      rule: r.eventType,
      severity: r.decision === "block" ? "BLOCK" : r.decision === "warning" ? "WARN" : "INFO",
      decision: r.decision, explanation: r.reason,
    };
  });
}

/** Install-wide trading availability from the platform stop switches. */
export async function platformRiskPermissions() {
  const halt = await loadPlatformHalt();
  return {
    aiTrading: !halt.engaged, manualTrading: !halt.engaged,
    // The paper simulator is halted only by the safety-core switch (lib/safety/tradingHalt).
    simulator: !halt.sources.includes("safety_core_kill_switch"),
    liveTesterIntent: !halt.engaged, futureMt5: false as const,
    pauseReason: halt.reason, haltSources: halt.sources,
  };
}
