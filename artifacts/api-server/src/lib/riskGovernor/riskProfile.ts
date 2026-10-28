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
import type { RiskContext, RiskVenue } from "./preTrade.js";
import { getOrCreateRiskSettings } from "./riskEvents.js";
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
 */
export async function configurePropFirm(userId: number, patch: Partial<PropFirmConfig>) {
  const current = await getOrCreateRiskSettings(userId);
  const cfg: PropFirmConfig = { ...DEFAULT_PROP_FIRM, ...((current.propFirm as Partial<PropFirmConfig> | null) ?? {}), ...patch };
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
  if (dailyCapSet && ctx.daily.realizedPnl == null) unknowns.push("today's realized P/L could not be computed, so daily risk used is unknown");
  if (weeklyCapSet && ctx.activity == null) unknowns.push("this week's trading activity could not be read, so weekly risk used is unknown");
  const riskStatusReason = unknowns.length ? `${unknowns.join("; ")}.`.replace(/^./, (c) => c.toUpperCase()) : null;
  const status = halt.engaged || (dailyLimit != null && dailyUsed >= dailyLimit) || (weeklyLimit != null && weekUsed >= weeklyLimit)
    ? "BLOCK" : dailyLimit != null && dailyUsed > dailyLimit * 0.7 ? "CAUTION" : unknowns.length ? "UNKNOWN" : "OK";
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
      // Additive: null equity is unknown (no account read), not "none set";
      // an *Unvalued cap is configured as a percent but cannot be valued, so
      // a null (or amount-only) limit is not "no cap".
      equityKnown: equity != null, dailyRiskLimitUnvalued, weeklyRiskLimitUnvalued, riskStatusReason,
    },
    activity: ctx.activity ?? null,
    halt,
    permissions: { trading: !halt.engaged, pauseReason: halt.reason },
  };
}

/** Prop-firm progress on the paper ledger, against the trader's stored challenge. */
export async function propFirmStatus(userId: number) {
  const settings = await getOrCreateRiskSettings(userId);
  const cfg: PropFirmConfig = { ...DEFAULT_PROP_FIRM, ...((settings.propFirm as Partial<PropFirmConfig> | null) ?? {}) };
  const ov = await riskOverview(userId, "PAPER");
  const equity = ov.budget.equity;
  const equityMeasured = equity != null;
  const profit = equity != null ? equity - cfg.startingBalance : 0;
  const dailyDD = ov.budget.dailyRiskUsed;
  const totalDD = Math.max(0, -profit);
  // Rules are checked only while the mode is on; a rule that needs the paper
  // equity is not checked without it. Neither case is ever listed as passed.
  const passed: string[] = []; const failed: string[] = []; const notEvaluated: string[] = [];
  if (cfg.enabled) {
    if (!equityMeasured) notEvaluated.push("PROFIT_TARGET");
    else if (profit >= cfg.profitTarget) passed.push("PROFIT_TARGET");
    if (dailyDD >= cfg.maxDailyDrawdownUsd) failed.push("DAILY_DD"); else passed.push("DAILY_DD");
    if (!equityMeasured) notEvaluated.push("TOTAL_DD");
    else if (totalDD >= cfg.maxTotalDrawdownUsd) failed.push("TOTAL_DD"); else passed.push("TOTAL_DD");
  }
  const status = !cfg.enabled ? "OFF" : failed.length ? "FAILED" : profit >= cfg.profitTarget ? "PASSED"
    : dailyDD > cfg.maxDailyDrawdownUsd * 0.7 || totalDD > cfg.maxTotalDrawdownUsd * 0.7 ? "WARNING" : "ACTIVE";
  return {
    config: cfg, profitUsd: r2(profit),
    profitTargetProgress: cfg.profitTarget > 0 ? r2((profit / cfg.profitTarget) * 100) : 0,
    dailyDrawdownRemainingUsd: r2(cfg.maxDailyDrawdownUsd - dailyDD),
    totalDrawdownRemainingUsd: r2(cfg.maxTotalDrawdownUsd - totalDD),
    passed, failed, status, equitySource: "paper_ledger" as const,
    /** False while the mode is off: no rule was checked. */
    rulesEvaluated: cfg.enabled,
    /** Rules not checked because the paper equity could not be read. */
    notEvaluated,
    equityMeasured,
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
