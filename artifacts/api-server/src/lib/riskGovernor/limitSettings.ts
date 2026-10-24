// The one reader of the Risk Governor's limit settings (Tier 1 Risk Governor:
// one limit source).
//
// Two stores hold the numbers the pre-trade Risk Governor enforces:
//   user_risk_settings — the trader's own limits (the one trader-editable
//                        limit store; both settings pages write it),
//   user_risk_limits   — the operator's hard limits for that trader.
// The governor resolves them with the platform ceilings (strictest wins) in
// resolveEffectiveLimits (./preTrade.ts). Every server file that needs these
// rows reads them here, so a page, a report or a pre-check reads the same
// row the governor does. A caller that needs the limit IN FORCE (what the
// governor will actually apply) uses loadEffectiveLimits; a caller that
// shows the trader's own saved value uses readTraderRiskSettings.
//
// Reads only. The audited writers (the settings pages, presets, the admin
// risk-limits handler) are listed in scripts/src/ci/check-single-risk-limit-source.ts.

import { db, userRiskSettingsTable, userRiskLimitsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { resolveEffectiveLimits, type EffectiveLimits, type StoredLimitRows } from "./preTrade.js";

export type TraderRiskSettingsRow = typeof userRiskSettingsTable.$inferSelect;
export type OperatorRiskLimitsRow = typeof userRiskLimitsTable.$inferSelect;

/** The trader's own user_risk_settings row, or null when they never saved one. */
export async function readTraderRiskSettings(userId: number): Promise<TraderRiskSettingsRow | null> {
  const [row] = await db.select().from(userRiskSettingsTable).where(eq(userRiskSettingsTable.userId, userId)).limit(1);
  return row ?? null;
}

/** user_risk_settings rows for several traders (no row = not in the result). */
export async function readTraderRiskSettingsMany(userIds: readonly number[]): Promise<TraderRiskSettingsRow[]> {
  if (userIds.length === 0) return [];
  return db.select().from(userRiskSettingsTable).where(inArray(userRiskSettingsTable.userId, [...userIds]));
}

/** The operator's user_risk_limits row for this trader, or null when none is set. */
export async function readOperatorRiskLimits(userId: number): Promise<OperatorRiskLimitsRow | null> {
  const [row] = await db.select().from(userRiskLimitsTable).where(eq(userRiskLimitsTable.userId, userId)).limit(1);
  return row ?? null;
}

/** user_risk_limits rows for several traders (no row = not in the result). */
export async function readOperatorRiskLimitsMany(userIds: readonly number[]): Promise<OperatorRiskLimitsRow[]> {
  if (userIds.length === 0) return [];
  return db.select().from(userRiskLimitsTable).where(inArray(userRiskLimitsTable.userId, [...userIds]));
}

/** The trader's stored limit rows: own settings (the one trader-editable store) and operator limits. */
export async function loadStoredLimitRows(userId: number): Promise<StoredLimitRows> {
  const u = await readTraderRiskSettings(userId);
  const a = await readOperatorRiskLimits(userId);
  return { userSettings: u, adminLimits: a };
}

/** The limits in force for this trader: the same values the Risk Governor applies on every order. */
export async function loadEffectiveLimits(userId: number): Promise<EffectiveLimits> {
  return resolveEffectiveLimits(await loadStoredLimitRows(userId));
}
