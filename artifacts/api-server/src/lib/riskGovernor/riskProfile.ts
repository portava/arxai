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
import { readActivePaperAccount, readOpenPaperOrders, readPaperCloses } from "../tradeEngine/paperBookReader.js";
import { paperRiskTotals } from "../paperExecution/paperRiskCount.js";
import { paperRiskEquity, valueOpenPaperPositions } from "../paperExecution/paperOpenRisk.js";
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
  /**
   * The paper account's balance at that moment (equity minus floating P/L).
   * Absent on starts recorded before it was tracked: the floating P/L at the
   * start is then not known.
   */
  balance?: number;
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
      ? { at: new Date().toISOString(), paperAccountId: acct.id, equity: acct.equity, equityAsOf: acct.updatedAt.toISOString(), balance: acct.currentBalance }
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
  // Today's loss is measured only from a computed realized P/L, and on PAPER
  // only from an account that was read (with no active paper account the
  // fact loader reads no book: the governor's realized figure is a 0 nobody
  // measured and there is no activity, and nothing failed to load). Unmeasured
  // use is null, never 0, and the *UnknownReason says why in plain words.
  const noPaperAccount = venue === "PAPER" && ctx.account == null;
  const dailyRiskUsedUnknownReason = noPaperAccount ? "there is no active paper account"
    : ctx.daily.realizedPnl == null ? "today's realized P/L could not be computed" : null;
  const weeklyRiskUsedUnknownReason = noPaperAccount ? "there is no active paper account"
    : ctx.activity == null ? "this week's trading activity could not be read" : null;
  const floatingLoss = ctx.daily.floatingPnl != null && ctx.daily.floatingPnl < 0 ? ctx.daily.floatingPnl : 0;
  const dailyUsed = dailyRiskUsedUnknownReason == null ? Math.max(0, -(ctx.daily.realizedPnl! + floatingLoss)) : null;
  // An equity that was read and is at or below 0 (on PAPER, the paper risk
  // count's equity) leaves no room under any percent cap: the Risk Governor
  // refuses every new order (its per-trade rule, and its daily and weekly
  // percent caps read used up). Each percent cap is then valued at 0, never
  // at a negative amount.
  const equityExhausted = ctx.account != null && equity != null && Number.isFinite(equity) && equity <= 0;
  const pctCap = (pct: number | null) => (pct == null || equity == null ? null : equityExhausted ? 0 : (equity * pct) / 100);
  const caps = [L.maxDailyLossAmount, pctCap(L.maxDailyLossPercent)]
    .filter((v): v is number => v != null);
  const dailyLimit = caps.length ? Math.min(...caps) : null;
  // This week's loss needs the activity facts; without them it is unknown.
  const weekUsed = weeklyRiskUsedUnknownReason == null && ctx.activity != null ? Math.max(0, -ctx.activity.weekRealizedPnl) : null;
  const wcaps = [L.discipline.maxWeeklyLossAmount, pctCap(L.discipline.maxWeeklyLossPercent)]
    .filter((v): v is number => v != null);
  const weeklyLimit = wcaps.length ? Math.min(...wcaps) : null;
  const openRisk = ctx.positions.reduce((s, p) => {
    const inst = ctx.instruments[p.symbol];
    if (p.stopLoss == null || !inst?.contractSize) return s;
    return s + Math.abs(p.entryPrice - p.stopLoss) * p.lots * inst.contractSize * (inst.quoteToAccountFx ?? 1);
  }, 0);
  const halt = ctx.halt ?? { engaged: false, sources: [], reason: null };
  // What this view cannot value. A percent cap needs equity; "used" needs the
  // day's realized P/L (daily) or the activity facts (weekly). Unknown facts
  // are never read as 0 / "none set" / OK.
  const dailyCapSet = L.maxDailyLossAmount != null || L.maxDailyLossPercent != null;
  const weeklyCapSet = L.discipline.maxWeeklyLossAmount != null || L.discipline.maxWeeklyLossPercent != null;
  const dailyRiskLimitUnvalued = L.maxDailyLossPercent != null && equity == null;
  const weeklyRiskLimitUnvalued = L.discipline.maxWeeklyLossPercent != null && equity == null;
  const unknowns: string[] = [];
  if (dailyRiskLimitUnvalued) unknowns.push(`your ${L.maxDailyLossPercent}% daily loss cap cannot be valued because account equity is unknown`);
  if (weeklyRiskLimitUnvalued) unknowns.push(`your ${L.discipline.maxWeeklyLossPercent}% weekly loss cap cannot be valued because account equity is unknown`);
  if (dailyCapSet && dailyRiskUsedUnknownReason) unknowns.push(`${dailyRiskUsedUnknownReason}, so daily risk used is unknown`);
  if (weeklyCapSet && weeklyRiskUsedUnknownReason) unknowns.push(`${weeklyRiskUsedUnknownReason}, so weekly risk used is unknown`);
  // PAPER: the governor counts closed paper trades at the lower of their
  // booked total and their paper risk model total, so "used" and the equity a
  // percent cap is valued on can differ from the booked figures. Say so, with
  // both.
  const riskCountNote = paperRiskCountNote(ctx);
  const dailyReached = dailyLimit != null && dailyUsed != null && dailyUsed >= dailyLimit;
  const weeklyReached = weeklyLimit != null && weekUsed != null && weekUsed >= weeklyLimit;
  // The governor refuses every new order when the activity facts are
  // unreadable and any cap that needs them is set (preTrade evaluateDiscipline).
  const D = L.discipline;
  const activityCapSet = D.maxTradesPerDay != null || D.maxWeeklyLossAmount != null || D.maxWeeklyLossPercent != null
    || D.maxConsecutiveLosses != null || D.cooldownAfterLossMinutes != null;
  const activityUnread = ctx.activity == null && activityCapSet;
  if (activityUnread) {
    const needs = [
      ...(D.maxTradesPerDay != null ? [`your ${D.maxTradesPerDay}-trades-a-day limit`] : []),
      ...(D.maxConsecutiveLosses != null ? [`your ${D.maxConsecutiveLosses}-losses-in-a-row limit`] : []),
      ...(D.cooldownAfterLossMinutes != null ? [`your ${D.cooldownAfterLossMinutes}-minute cooldown after a loss`] : []),
      ...(weeklyCapSet ? ["your weekly loss cap"] : []),
    ];
    const list = needs.length > 1 ? `${needs.slice(0, -1).join(", ")} and ${needs[needs.length - 1]}` : needs[0]!;
    unknowns.push(noPaperAccount
      ? `there is no active paper account, so ${list} cannot be checked and the Risk Governor refuses new orders until one is active`
      : `your recent trading activity could not be read, so ${list} cannot be checked and the Risk Governor refuses new orders until it can be read`);
  }
  // What an exhausted equity blocks, with the figure the governor reads (and,
  // on PAPER, the booked equity beside the risk count), first in the reason.
  const exhaustedReason = equityExhausted ? equityExhaustedReason(ctx, L) : null;
  const reasons = [...(exhaustedReason ? [exhaustedReason] : []), ...unknowns];
  const riskStatusReason = reasons.length ? `${reasons.join("; ")}.`.replace(/^./, (c) => c.toUpperCase()) : null;
  // Unread activity with such a cap set blocks like a reached limit
  // (blockedBy activity_unread), so the status is BLOCK, never OK / UNKNOWN;
  // so does an exhausted equity (blockedBy equity_exhausted).
  const status = halt.engaged || dailyReached || weeklyReached || activityUnread || equityExhausted
    ? "BLOCK" : dailyLimit != null && dailyUsed != null && dailyUsed > dailyLimit * 0.7 ? "CAUTION" : unknowns.length ? "UNKNOWN" : "OK";
  // What stops new trades, as this view measures it. A read model only: the
  // Risk Governor decides each order. trading is false whenever anything here
  // blocks, so it never says "trading" next to a BLOCK status.
  const blockedBy = [
    ...(halt.engaged ? ["stop_switch" as const] : []),
    ...(dailyReached ? ["daily_loss_limit" as const] : []),
    ...(weeklyReached ? ["weekly_loss_limit" as const] : []),
    ...(activityUnread ? ["activity_unread" as const] : []),
    ...(equityExhausted ? ["equity_exhausted" as const] : []),
  ];
  return {
    venue,
    preset: settings.riskPreset ?? null,
    limits: L,
    budget: {
      // *Used and *Remaining are null when the use was not measured (see the
      // *RiskUsedUnmeasured flags), never 0 / the whole cap.
      dailyRiskLimit: dailyLimit != null ? r2(dailyLimit) : null, dailyRiskUsed: dailyUsed != null ? r2(dailyUsed) : null,
      dailyRiskRemaining: dailyLimit != null && dailyUsed != null ? r2(dailyLimit - dailyUsed) : null,
      weeklyRiskLimit: weeklyLimit != null ? r2(weeklyLimit) : null, weeklyRiskUsed: weekUsed != null ? r2(weekUsed) : null,
      weeklyRiskRemaining: weeklyLimit != null && weekUsed != null ? r2(weeklyLimit - weekUsed) : null,
      openRisk: r2(openRisk), openPositions: ctx.positions.length, equity, riskStatus: status,
      // Additive: null equity is unknown (no account read), not "none set";
      // an *Unvalued cap is configured as a percent but cannot be valued, so
      // a null (or amount-only) limit is not "no cap".
      equityKnown: equity != null, dailyRiskLimitUnvalued, weeklyRiskLimitUnvalued, riskStatusReason,
      // Additive: false when the *RiskUsed figure was not measured (it is then
      // null, and so is *RiskRemaining), with the plain reason.
      dailyRiskUsedKnown: dailyRiskUsedUnknownReason == null, dailyRiskUsedUnknownReason,
      weeklyRiskUsedKnown: weeklyRiskUsedUnknownReason == null, weeklyRiskUsedUnknownReason,
      /** A daily / weekly cap is set but what was used against it could not be measured. */
      dailyRiskUsedUnmeasured: dailyCapSet && dailyUsed == null,
      weeklyRiskUsedUnmeasured: weeklyCapSet && weekUsed == null,
      /**
       * Additive: set when the Risk Governor's paper loss count or the equity
       * it values caps on is below the booked figures (closed paper trades
       * count at the lower of their booked total and their paper risk model
       * total); says both figures in plain words. null when they agree.
       */
      riskCountNote,
    },
    activity: ctx.activity ?? null,
    halt,
    permissions: { trading: blockedBy.length === 0, pauseReason: halt.reason, stopSwitchEngaged: halt.engaged, blockedBy },
  };
}

const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(r2(n)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Why an equity read at or below 0 blocks new trades, in the words the Risk
 * Governor's refusals use (preTrade nonPositiveEquity): the equity it reads
 * (on PAPER, the paper risk count, with the booked equity beside it when they
 * differ), and the percent limits it uses up.
 */
function equityExhaustedReason(ctx: Pick<RiskContext, "account">, L: RiskContext["limits"]): string {
  const a = ctx.account!;
  const figure = a.bookedEquity != null
    ? `the paper risk count puts account equity at ${usd(a.equity!)}, at or below zero (the paper account shows ${usd(a.bookedEquity)} booked)`
    : `account equity is ${usd(a.equity!)}, at or below zero`;
  const perTrade = L.maxRiskPerTradePercent != null ? `your ${L.maxRiskPerTradePercent}% per-trade limit` : "your per-trade limit";
  const usedUp = [
    ...(L.maxDailyLossPercent != null ? [`your ${L.maxDailyLossPercent}% daily loss cap`] : []),
    ...(L.discipline.maxWeeklyLossPercent != null ? [`your ${L.discipline.maxWeeklyLossPercent}% weekly loss cap`] : []),
  ];
  const caps = usedUp.length ? `, and ${usedUp.join(" and ")} ${usedUp.length > 1 ? "are" : "is"} used up` : "";
  return `${figure}, so ${perTrade} leaves no risk for a new trade${caps}. The Risk Governor refuses new trades until equity is above zero`;
}

/**
 * Plain-English note for a paper risk count that differs from the booked
 * figures (RiskContext.daily.bookedRealizedPnl / bookedFloatingPnl,
 * account.bookedEquity and activity.bookedWeekRealizedPnl are set only then).
 * null when the governor counts exactly what was booked.
 */
export function paperRiskCountNote(ctx: Pick<RiskContext, "daily" | "account"> & { activity?: RiskContext["activity"] }): string | null {
  const parts: string[] = [];
  const booked = ctx.daily.bookedRealizedPnl;
  if (booked != null && ctx.daily.realizedPnl != null) {
    parts.push(`today's realized paper P&L is counted as ${usd(ctx.daily.realizedPnl)} (booked ${usd(booked)})`);
  }
  // The week's figure (weekly used, the weekly caps) is the risk count too.
  const bookedWeek = ctx.activity?.bookedWeekRealizedPnl;
  if (bookedWeek != null && ctx.activity != null) {
    parts.push(`this week's (the last 7 days') realized paper P&L is counted as ${usd(ctx.activity.weekRealizedPnl)} (booked ${usd(bookedWeek)})`);
  }
  const bookedFloating = ctx.daily.bookedFloatingPnl;
  if (bookedFloating != null && ctx.daily.floatingPnl != null) {
    parts.push(`open positions are counted at ${usd(ctx.daily.floatingPnl)} (the paper account shows ${usd(bookedFloating)} floating)`);
  }
  const bookedEq = ctx.account?.bookedEquity;
  if (bookedEq != null && ctx.account?.equity != null) {
    parts.push(`equity is counted as ${usd(ctx.account.equity)} (the paper account shows ${usd(bookedEq)})`);
  }
  if (!parts.length) return null;
  const at = ctx.daily.openValuedAtStop ?? [];
  const list = at.length > 1 ? `${at.slice(0, -1).join(", ")} and ${at[at.length - 1]}` : at[0];
  const stop = !at.length ? ""
    : at.length === 1
      ? ` The open ${list} position could not be valued at a current price here (no market quote for it was read), so it is counted at its stop, the most it can lose through its stop.`
      : ` The open ${list} positions could not be valued at a current price here (no market quote for them was read), so they are counted at their stops, the most they can lose through their stops.`;
  return `For your loss limits ${parts.join(", and ")}. The Risk Governor counts closed paper trades at the lower of two totals over the same trades, their booked P&L and the paper risk model (price move × lots × 100), and each open position at the lower of its sized value and the paper risk model at the paper venue's current price, never above the floating P&L the account shows, so a limit is never checked against a smaller loss or a larger equity than either basis gives.${stop}`;
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
  if (drawdown.earlierDays) out.push({ rule: "DAILY_DD_EARLIER_DAYS", reason: "Only today's loss is checked (DAILY_DD_TODAY). Daily losses on earlier days of the challenge are not, so DAILY_DD is not confirmed." });
  if (drawdown.lowestEquity) out.push({ rule: "TOTAL_DD_LOWEST_EQUITY", reason: "Only current equity is checked (TOTAL_DD_CURRENT). A deeper dip earlier in the challenge is not recorded, so TOTAL_DD is not confirmed." });
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

/** Why today's drawdown on the paper risk count is only bounded on a start day with positions open at the start. */
function propDailyRiskCountBoundReason(atMost: number, booked: number, cap: number): string {
  return "Positions were open when the challenge started, and the start recorded only their booked P&L, so today's drawdown since the start "
    + `cannot be measured on the paper risk count the Risk Governor's daily loss cap reads: it is at most ${usd(atMost)} there, and ${usd(booked)} on the paper account's booked figures, against the ${usd(cap)} cap.`;
}

/**
 * The prop status note for a day whose drawdown the paper risk count puts
 * above the booked figures: both figures, which one DAILY_DD is checked
 * against, what differs and how the risk count is taken. `bound`: the risk
 * count's figure is only the most it can be (propDailyRiskCountBoundReason),
 * and `bookedFailed` says whether the booked figure alone fails DAILY_DD.
 */
function propDailyRiskCountNote(
  riskCountDD: number, bookedDD: number,
  realized: { booked: number; risk: number },
  open: { floating: number; bookedFloating: number; openValuedAtStop: string[] },
  bound: { bookedFailed: boolean; cap: number } | null = null,
): string {
  const parts: string[] = [];
  if (realized.risk < realized.booked - 0.005) parts.push(`the paper trades closed since then count ${usd(realized.risk)} (booked ${usd(realized.booked)})`);
  if (open.floating < open.bookedFloating - 0.005) parts.push(`open positions count ${usd(open.floating)} (the paper account shows ${usd(open.bookedFloating)} floating)`);
  const at = open.openValuedAtStop;
  const list = at.length > 1 ? `${at.slice(0, -1).join(", ")} and ${at[at.length - 1]}` : at[0];
  const stop = !at.length ? ""
    : at.length === 1
      ? ` The open ${list} position could not be valued at a current price here (no market quote for it was read), so it is counted at its stop, the most it can lose through its stop.`
      : ` The open ${list} positions could not be valued at a current price here (no market quote for them was read), so they are counted at their stops, the most they can lose through their stops.`;
  const head = bound
    ? `${propDailyRiskCountBoundReason(riskCountDD, bookedDD, bound.cap)} ${bound.bookedFailed ? "DAILY_DD fails on the booked figures alone." : "DAILY_DD is not confirmed."}`
    : `Today's drawdown is ${usd(riskCountDD)} on the paper risk count, the figure the Risk Governor's daily loss cap reads, and ${usd(bookedDD)} on the paper account's booked figures; DAILY_DD is checked against the larger, ${usd(riskCountDD)}.`;
  return head
    + (parts.length ? ` On the risk count ${parts.join(", and ")}.` : "")
    + ` The risk count takes closed paper trades at the lower of their booked total and their price move × lots × 100 total, and each open position at the lower of its sized and its price move × lots × 100 value at the paper venue's current price, never above the floating P&L the account shows.${stop}`;
}

/**
 * Prop-firm progress on the paper ledger, against the trader's stored challenge.
 *
 * Measured from the challenge start (config.challengeStart): profit is the
 * active paper account's stored equity minus its equity when the challenge
 * started, and today's drawdown counts paper P/L settled since the later of
 * the trading day's start and the challenge start, plus the current floating
 * loss. On the day the challenge started, a floating loss already open at the
 * start is in the start equity, so only floating loss beyond it counts, and
 * the figure is never less than the drop in equity since the start (with no
 * balance recorded at the start: that drop alone). Today's drawdown is taken
 * on the booked figures and on the Risk Governor's paper risk count, and
 * DAILY_DD is checked against the larger (dailyDrawdownBasis says which; a
 * note gives both when they differ).
 * Equity is the account's last stored mark (equityAsOf).
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
      ? "The challenge start was not recorded, so there is no starting equity to measure from. Reset it with \"Turn on with saved values\" on Prop Firm Risk Mode to start the challenge from your paper account's current equity."
      : start.paperAccountId !== acct.id
        ? `The challenge started on paper account #${start.paperAccountId}, but your active paper account is #${acct.id}. Reset it with "Turn on with saved values" on Prop Firm Risk Mode to restart the challenge on #${acct.id}.`
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
      /** False while the mode is off or nothing was measured: no rule was checked. */
      rulesEvaluated: false,
      /** Core rules not checked because they could not be measured (notMeasuredReason). Empty while the mode is off. */
      notEvaluated: cfg.enabled ? ["PROFIT_TARGET", "DAILY_DD", "TOTAL_DD"] : [],
      /** Whether the paper equity was read. */
      equityMeasured: acct != null,
      /** Additive: why each rule in notEvaluated was not checked, in plain words. */
      notEvaluatedReasons: (cfg.enabled ? { PROFIT_TARGET: reason, DAILY_DD: reason, TOTAL_DD: reason } : {}) as Record<string, string>,
      /** Additive: false when the day's drawdown (and dailyDrawdownRemainingUsd) was not measured. */
      dailyDrawdownMeasured: false,
      dailyDrawdownUsd: null as number | null, dailyDrawdownBookedUsd: null as number | null,
      dailyDrawdownRiskCountUsd: null as number | null, dailyDrawdownBasis: null as "booked" | "paper_risk_count" | null,
    };
  }

  const profit = acct.equity - start.equity;
  const dayStart = tradingDayStart(now).getTime();
  const since = new Date(Math.max(dayStart, Date.parse(start.at) || 0));
  const earlierDays = !(Date.parse(start.at) >= dayStart);
  // Today's drawdown is measured on both bases over the same closes and open
  // positions, and DAILY_DD fails on either (read-only; nothing is settled):
  //   booked      the paper P/L settled since `since` as booked, and the
  //               floating P&L the account stores (equity − balance);
  //   risk count  what the Risk Governor's daily loss cap reads
  //               (enforce.ts loadPaperFacts): the settled P/L at the lower of
  //               its booked and price move × lots × 100 totals, and the open
  //               positions at the lower of their sized and ×100 value at the
  //               paper venue's mark (paperOpenRisk.ts), never above the
  //               stored floating P&L. No market quote is read here, so a
  //               market-priced open position is counted at its stop (named).
  const book = { account: acct.id };
  const realized = paperRiskTotals(await readPaperCloses(book, { since }));
  const open = paperRiskEquity(acct, [], await valueOpenPaperPositions(await readOpenPaperOrders(book), { now, userId, quote: null }));
  // On the start day the loss is measured from the start: a floating loss
  // already open then is in start.equity and is not a loss since the start.
  // It is never less than the drop in equity since the start, so a floating
  // GAIN open at the start and given back (closed or not) counts as a loss.
  // A start recorded without its balance has no known floating P/L at the
  // start, so it is the drop in equity since the start alone. On the risk
  // count the drop since the start is the booked drop plus how much lower the
  // risk count puts the P/L settled since the start and the open positions
  // now. The start recorded only booked figures, so on a start day with
  // positions open at the start (or no balance recorded) the risk count's
  // figure is the most it can be, not a measure (riskCountBound): DAILY_DD
  // then fails on the booked figure alone, and is otherwise not confirmed.
  const startBalance = typeof start.balance === "number" && Number.isFinite(start.balance) ? start.balance : null;
  const flatAtStart = startBalance != null && Math.abs(start.equity - startBalance) < 0.005;
  const dayDrawdown = (settled: number, floating: number) => {
    const dropSinceStart = Math.max(0, start.equity - acct.equity + (realized.booked - settled) + (open.bookedFloating - floating));
    return earlierDays
      ? Math.max(0, -(settled + Math.min(0, floating)))
      : startBalance != null
        ? Math.max(dropSinceStart, -(settled + Math.min(0, floating) - Math.min(0, start.equity - startBalance)))
        : dropSinceStart;
  };
  const bookedDD = dayDrawdown(realized.booked, open.bookedFloating);
  const riskCountDD = dayDrawdown(realized.risk, open.floating);
  const riskCountAbove = riskCountDD > bookedDD + 0.005;
  const riskCountBound = riskCountAbove && !earlierDays && !flatAtStart;
  const dailyDD = Math.max(bookedDD, riskCountDD);
  const dailyCap = cfg.maxDailyDrawdownUsd;
  const dailyFailed = riskCountBound ? bookedDD >= dailyCap : dailyDD >= dailyCap;
  // Not confirmed: only a bound on the risk count's figure, and the booked figure does not fail it.
  const dailyUnconfirmed = riskCountBound && !dailyFailed;
  const dailyBasis: "booked" | "paper_risk_count" = riskCountAbove ? "paper_risk_count" : "booked";
  if (riskCountAbove) {
    notes.push(propDailyRiskCountNote(r2(riskCountDD), r2(bookedDD), realized, open, riskCountBound ? { bookedFailed: dailyFailed, cap: dailyCap } : null));
  }
  const dailyNotConfirmedReason = dailyUnconfirmed ? `${propDailyRiskCountBoundReason(r2(riskCountDD), r2(bookedDD), dailyCap)} DAILY_DD is not confirmed.` : null;
  if (cfg.enabled && dailyNotConfirmedReason) notChecked.push({ rule: "DAILY_DD", reason: dailyNotConfirmedReason });
  const totalDD = Math.max(0, -profit);
  if (Math.abs(cfg.startingBalance - start.equity) >= 0.01) {
    notes.push(`The challenge size is $${cfg.startingBalance}, but your paper account started the challenge with $${r2(start.equity)} equity. `
      + `Profit, target and drawdown are measured in dollars from $${r2(start.equity)} and are not scaled.`);
  }
  // Rules are checked only while the mode is on: while it is off nothing is
  // listed as passed or failed. A rule is passed only when all of it was
  // measured: today's loss is all of DAILY_DD only for a challenge that
  // started today, and current equity is never all of TOTAL_DD (a deeper dip
  // earlier is not recorded). The measured part then passes under its own
  // name (DAILY_DD_TODAY, TOTAL_DD_CURRENT) and the rule's caveat stays in
  // notChecked; a breach of the measured part fails the rule itself.
  if (cfg.enabled) {
    if (profit >= cfg.profitTarget) passed.push("PROFIT_TARGET");
    if (dailyFailed) failed.push("DAILY_DD"); else if (!dailyUnconfirmed) passed.push(earlierDays ? "DAILY_DD_TODAY" : "DAILY_DD");
    if (totalDD >= cfg.maxTotalDrawdownUsd) failed.push("TOTAL_DD"); else passed.push("TOTAL_DD_CURRENT");
  }
  notChecked.push(...uncheckedChallengeRules(cfg, limits, { earlierDays, lowestEquity: true }));
  // A reached target is not a passed challenge while any rule is unchecked.
  const status: PropFirmStatusCode = !cfg.enabled ? "OFF" : failed.length ? "FAILED"
    : profit >= cfg.profitTarget ? (notChecked.length ? "TARGET_REACHED" : "PASSED")
    : dailyDD > cfg.maxDailyDrawdownUsd * 0.7 || totalDD > cfg.maxTotalDrawdownUsd * 0.7 ? "WARNING" : "ACTIVE";
  return {
    ...base, measured: true, notMeasuredReason: null as string | null,
    profitUsd: r2(profit) as number | null,
    profitTargetProgress: (cfg.profitTarget > 0 ? r2((profit / cfg.profitTarget) * 100) : 0) as number | null,
    // null when the risk count's figure is only a bound (riskCountBound).
    dailyDrawdownRemainingUsd: (riskCountBound ? null : r2(cfg.maxDailyDrawdownUsd - dailyDD)) as number | null,
    totalDrawdownRemainingUsd: r2(cfg.maxTotalDrawdownUsd - totalDD) as number | null,
    /** Today's drawdown counts paper P/L settled from here (trading-day start or challenge start, whichever is later). */
    dailyDrawdownSince: since.toISOString() as string | null,
    passed, failed, notChecked, notes, status,
    rulesEvaluated: cfg.enabled,
    notEvaluated: (cfg.enabled && dailyUnconfirmed ? ["DAILY_DD"] : []) as string[],
    /** Additive: why each rule in notEvaluated was not checked. */
    notEvaluatedReasons: (cfg.enabled && dailyNotConfirmedReason ? { DAILY_DD: dailyNotConfirmedReason } : {}) as Record<string, string>,
    equityMeasured: true,
    /** Additive: false when the day's drawdown (and dailyDrawdownRemainingUsd) was not measured. */
    dailyDrawdownMeasured: !riskCountBound,
    /**
     * Additive: today's drawdown as DAILY_DD checks it (the larger of the two
     * bases), each basis, and which one it is: "paper_risk_count" when the
     * Risk Governor's paper risk count puts it higher than the booked figures
     * (a note then gives both), else "booked". The risk count's figure (and
     * so the larger one and the basis) is null when it could not be measured
     * from the start (a start day with positions open at the start; the note
     * gives the most it can be).
     */
    dailyDrawdownUsd: (riskCountBound ? null : r2(dailyDD)) as number | null,
    dailyDrawdownBookedUsd: r2(bookedDD) as number | null,
    dailyDrawdownRiskCountUsd: (riskCountBound ? null : r2(riskCountDD)) as number | null,
    dailyDrawdownBasis: (riskCountBound ? null : dailyBasis) as "booked" | "paper_risk_count" | null,
  };
}

export interface RiskEventView {
  eventId: string; ts: string; userId: number; symbol?: string; source?: string;
  /** The venue the row itself recorded (details.intent.venue, or details.venue
   *  for Position Guardian rows). Absent when the row does not say. */
  environment?: RiskVenue;
  rule: string; severity: "INFO" | "WARN" | "BLOCK"; decision: string; explanation: string;
}

const RISK_VENUES = new Set<string>(["PAPER", "DEMO", "LIVE"] satisfies RiskVenue[]);
const recordedVenue = (v: unknown): RiskVenue | undefined =>
  (typeof v === "string" && RISK_VENUES.has(v) ? v as RiskVenue : undefined);

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
      environment: recordedVenue(intent["venue"]) ?? recordedVenue(d["venue"]),
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
