// A trader's risk settings, as the older settings page and its readers see
// them (Tier 1 Risk Governor: one trader-editable limit store).
//
// Limits live in user_risk_settings, the store the pre-trade Risk Governor
// resolves. Preferences that are not limits (risk mode label, confidence
// floor, symbol rules, the trader's own live lock) stay in risk_settings.
// This module joins the two under the older page's field names and splits a
// write back into them, so no caller reads or writes a limit in risk_settings.

import { db, riskSettingsTable, userRiskSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { PLATFORM_RISK_CEILINGS } from "../riskGovernor/preTrade.js";
import { readTraderRiskSettings } from "../riskGovernor/limitSettings.js";

type Prefs = typeof riskSettingsTable.$inferSelect;
type Limits = typeof userRiskSettingsTable.$inferSelect;

/** Older page field → user_risk_settings column. */
export const LEGACY_LIMIT_FIELDS = {
  riskPerTradePct: "maxRiskPerTradePercent",
  maxDailyLossPct: "maxDailyLossPercent",
  maxWeeklyLossPct: "maxWeeklyLossPercent",
  maxOpenTrades: "maxOpenTrades",
  maxTradesPerDay: "maxTradesPerDay",
  maxLotSize: "maxPositionSize",
  stopAfterLosingStreak: "maxConsecutiveLosses",
  cooldownAfterLossMinutes: "cooldownAfterLossMinutes",
} as const;
export type LegacyLimitField = keyof typeof LEGACY_LIMIT_FIELDS;

// Columns that are optional in user_risk_settings: 0 on the older page means "off".
const NULLABLE = new Set<LegacyLimitField>(["maxWeeklyLossPct", "maxLotSize"]);

export interface TraderRiskSettings {
  id: number;
  riskMode: string;
  riskPerTradePct: number;
  maxDailyLossPct: number;
  maxWeeklyLossPct: number;
  maxOpenTrades: number;
  maxTradesPerDay: number;
  maxLotSize: number;
  stopAfterLosingStreak: number;
  cooldownAfterLossMinutes: number;
  minConfidenceScore: number;
  disableDuringAbnormalVolatility: boolean;
  liveLocked: boolean;
  vol75ExtraConfidence: boolean;
  vol75SmallLot: boolean;
  us30BlockNews: boolean;
  stocksBlockEarnings: boolean;
  forexBlockEvents: boolean;
}

async function prefsRow(userId: number): Promise<Prefs> {
  const [row] = await db.select().from(riskSettingsTable).where(eq(riskSettingsTable.userId, userId)).limit(1);
  if (row) return row;
  const [ins] = await db.insert(riskSettingsTable).values({ userId }).onConflictDoNothing().returning();
  return ins ?? (await db.select().from(riskSettingsTable).where(eq(riskSettingsTable.userId, userId)).limit(1))[0]!;
}

async function limitsRow(userId: number): Promise<Limits> {
  const row = await readTraderRiskSettings(userId);
  if (row) return row;
  const [ins] = await db.insert(userRiskSettingsTable).values({ userId }).onConflictDoNothing().returning();
  return ins ?? (await readTraderRiskSettings(userId))!;
}

function compose(p: Prefs, l: Limits): TraderRiskSettings {
  return {
    id: p.id,
    riskMode: p.riskMode,
    riskPerTradePct: l.maxRiskPerTradePercent,
    maxDailyLossPct: l.maxDailyLossPercent,
    maxWeeklyLossPct: l.maxWeeklyLossPercent ?? 0,
    maxOpenTrades: l.maxOpenTrades,
    maxTradesPerDay: l.maxTradesPerDay,
    // No own lot cap = the platform ceiling is the cap in force.
    maxLotSize: l.maxPositionSize ?? PLATFORM_RISK_CEILINGS.maxLotSize,
    stopAfterLosingStreak: l.maxConsecutiveLosses,
    cooldownAfterLossMinutes: l.cooldownAfterLossMinutes,
    minConfidenceScore: p.minConfidenceScore,
    disableDuringAbnormalVolatility: p.disableDuringAbnormalVolatility,
    liveLocked: p.liveLocked,
    vol75ExtraConfidence: p.vol75ExtraConfidence,
    vol75SmallLot: p.vol75SmallLot,
    us30BlockNews: p.us30BlockNews,
    stocksBlockEarnings: p.stocksBlockEarnings,
    forexBlockEvents: p.forexBlockEvents,
  };
}

/** The trader's settings: limits from user_risk_settings, preferences from risk_settings. Creates either row on first read. */
export async function getOrCreateUserRiskSettings(userId: number): Promise<TraderRiskSettings> {
  const [p, l] = await Promise.all([prefsRow(userId), limitsRow(userId)]);
  return compose(p, l);
}

/** Apply a change in the older page's field names: limits to user_risk_settings, the rest to risk_settings. */
export async function updateUserRiskSettings(
  userId: number,
  patch: Partial<Omit<TraderRiskSettings, "id">>,
  opts: { riskPreset?: string | null } = {},
): Promise<TraderRiskSettings> {
  const limits: Record<string, unknown> = {};
  const prefs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k in LEGACY_LIMIT_FIELDS) {
      const field = k as LegacyLimitField;
      limits[LEGACY_LIMIT_FIELDS[field]] = NULLABLE.has(field) && !(typeof v === "number" && v > 0) ? null : v;
    } else {
      prefs[k] = v;
    }
  }
  await Promise.all([prefsRow(userId), limitsRow(userId)]);
  if (Object.keys(limits).length || opts.riskPreset !== undefined) {
    await db.update(userRiskSettingsTable)
      .set({ ...limits, ...(opts.riskPreset !== undefined ? { riskPreset: opts.riskPreset } : {}), updatedAt: new Date() })
      .where(eq(userRiskSettingsTable.userId, userId));
  }
  if (Object.keys(prefs).length) {
    await db.update(riskSettingsTable).set({ ...prefs, updatedAt: new Date() }).where(eq(riskSettingsTable.userId, userId));
  }
  return getOrCreateUserRiskSettings(userId);
}
