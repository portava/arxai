// Phase 13 — Protective Auto-Close: per-user settings loader.
//
// SAFETY:
//   * Default OFF for every user. A row that does not exist returns
//     `enabled:false`. Calling `upsertSettings` with `enabled:true`
//     records `optInAt` server-side; flipping back to false records
//     `optOutAt`. The kill-switch sets `killSwitchEngaged:true` AND
//     `enabled:false` atomically.
//   * All reads/writes are per-user scoped on userId.

import { db } from "@workspace/db";
import { protectiveAutoCloseSettingsTable, type ProtectiveAutoCloseSettings } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

export type ProtectiveSettings = ProtectiveAutoCloseSettings;

export interface EffectiveSettings {
  enabled: boolean;
  inactivityThresholdMin: number;
  mode: "ALERT_ONLY" | "CONFIRM_IF_ACTIVE" | "AUTO_IF_INACTIVE";
  closeType: "FULL" | "PARTIAL" | "TIGHTEN";
  partialClosePercent: number;
  maxAutoClosesPerTrade: number;
  cooldownMin: number;
  minConfidence: "HIGH" | "MEDIUM";
  requireMultiSignal: boolean;
  protectProfitEnabled: boolean;
  protectProfitGivebackPct: number;
  maxLossProtectionEnabled: boolean;
  maxLossProtectionPct: number;
  killSwitchEngaged: boolean;
  optInAt: string | null;
  optOutAt: string | null;
  source: "row" | "default";
}

const DEFAULTS: Omit<EffectiveSettings, "source"> = {
  enabled: false,
  inactivityThresholdMin: 15,
  mode: "ALERT_ONLY",
  closeType: "FULL",
  partialClosePercent: 50,
  maxAutoClosesPerTrade: 1,
  cooldownMin: 30,
  minConfidence: "HIGH",
  requireMultiSignal: true,
  protectProfitEnabled: false,
  protectProfitGivebackPct: 50,
  maxLossProtectionEnabled: false,
  maxLossProtectionPct: 70,
  killSwitchEngaged: false,
  optInAt: null,
  optOutAt: null,
};

export async function getEffectiveSettings(userId: number): Promise<EffectiveSettings> {
  const [row] = await db.select().from(protectiveAutoCloseSettingsTable)
    .where(eq(protectiveAutoCloseSettingsTable.userId, userId))
    .limit(1);
  if (!row) return { ...DEFAULTS, source: "default" };
  return {
    enabled: row.enabled,
    inactivityThresholdMin: row.inactivityThresholdMin,
    mode: row.mode as EffectiveSettings["mode"],
    closeType: row.closeType as EffectiveSettings["closeType"],
    partialClosePercent: row.partialClosePercent,
    maxAutoClosesPerTrade: row.maxAutoClosesPerTrade,
    cooldownMin: row.cooldownMin,
    minConfidence: row.minConfidence as EffectiveSettings["minConfidence"],
    requireMultiSignal: row.requireMultiSignal,
    protectProfitEnabled: row.protectProfitEnabled,
    protectProfitGivebackPct: row.protectProfitGivebackPct,
    maxLossProtectionEnabled: row.maxLossProtectionEnabled,
    maxLossProtectionPct: row.maxLossProtectionPct,
    killSwitchEngaged: row.killSwitchEngaged,
    optInAt: row.optInAt?.toISOString() ?? null,
    optOutAt: row.optOutAt?.toISOString() ?? null,
    source: "row",
  };
}

export interface SettingsPatch {
  enabled?: boolean;
  inactivityThresholdMin?: number;
  mode?: EffectiveSettings["mode"];
  closeType?: EffectiveSettings["closeType"];
  partialClosePercent?: number;
  maxAutoClosesPerTrade?: number;
  cooldownMin?: number;
  minConfidence?: EffectiveSettings["minConfidence"];
  requireMultiSignal?: boolean;
  protectProfitEnabled?: boolean;
  protectProfitGivebackPct?: number;
  maxLossProtectionEnabled?: boolean;
  maxLossProtectionPct?: number;
}

export async function upsertSettings(userId: number, patch: SettingsPatch): Promise<EffectiveSettings> {
  const now = new Date();
  const current = await getEffectiveSettings(userId);

  // Opt-in / opt-out audit timestamps.
  let optInAt: Date | null = current.optInAt ? new Date(current.optInAt) : null;
  let optOutAt: Date | null = current.optOutAt ? new Date(current.optOutAt) : null;
  if (typeof patch.enabled === "boolean") {
    if (patch.enabled && !current.enabled) optInAt = now;
    if (!patch.enabled && current.enabled) optOutAt = now;
  }

  // Re-enabling clears the kill switch. Disabling does NOT clear the kill
  // switch (it must be cleared explicitly by `clearKillSwitch`).
  const nextEnabled = patch.enabled ?? current.enabled;

  const values = {
    userId,
    enabled: nextEnabled && !current.killSwitchEngaged,
    inactivityThresholdMin: patch.inactivityThresholdMin ?? current.inactivityThresholdMin,
    mode: patch.mode ?? current.mode,
    closeType: patch.closeType ?? current.closeType,
    partialClosePercent: patch.partialClosePercent ?? current.partialClosePercent,
    maxAutoClosesPerTrade: patch.maxAutoClosesPerTrade ?? current.maxAutoClosesPerTrade,
    cooldownMin: patch.cooldownMin ?? current.cooldownMin,
    minConfidence: patch.minConfidence ?? current.minConfidence,
    requireMultiSignal: patch.requireMultiSignal ?? current.requireMultiSignal,
    protectProfitEnabled: patch.protectProfitEnabled ?? current.protectProfitEnabled,
    protectProfitGivebackPct: patch.protectProfitGivebackPct ?? current.protectProfitGivebackPct,
    maxLossProtectionEnabled: patch.maxLossProtectionEnabled ?? current.maxLossProtectionEnabled,
    maxLossProtectionPct: patch.maxLossProtectionPct ?? current.maxLossProtectionPct,
    killSwitchEngaged: current.killSwitchEngaged,
    optInAt,
    optOutAt,
    lastUpdatedBy: "user",
    updatedAt: now,
  };

  await db.insert(protectiveAutoCloseSettingsTable).values(values)
    .onConflictDoUpdate({
      target: protectiveAutoCloseSettingsTable.userId,
      set: {
        enabled: values.enabled,
        inactivityThresholdMin: values.inactivityThresholdMin,
        mode: values.mode,
        closeType: values.closeType,
        partialClosePercent: values.partialClosePercent,
        maxAutoClosesPerTrade: values.maxAutoClosesPerTrade,
        cooldownMin: values.cooldownMin,
        minConfidence: values.minConfidence,
        requireMultiSignal: values.requireMultiSignal,
        protectProfitEnabled: values.protectProfitEnabled,
        protectProfitGivebackPct: values.protectProfitGivebackPct,
        maxLossProtectionEnabled: values.maxLossProtectionEnabled,
        maxLossProtectionPct: values.maxLossProtectionPct,
        optInAt: values.optInAt,
        optOutAt: values.optOutAt,
        lastUpdatedBy: values.lastUpdatedBy,
        updatedAt: values.updatedAt,
      },
    });

  return getEffectiveSettings(userId);
}

/** Atomic kill-switch: disables protective auto-close AND records the kill flag. */
export async function engageKillSwitch(userId: number): Promise<EffectiveSettings> {
  const now = new Date();
  const current = await getEffectiveSettings(userId);
  await db.insert(protectiveAutoCloseSettingsTable).values({
    userId,
    enabled: false,
    killSwitchEngaged: true,
    optOutAt: current.enabled ? now : (current.optOutAt ? new Date(current.optOutAt) : null),
    lastUpdatedBy: "user_kill_switch",
    updatedAt: now,
  }).onConflictDoUpdate({
    target: protectiveAutoCloseSettingsTable.userId,
    set: {
      enabled: false,
      killSwitchEngaged: true,
      optOutAt: current.enabled ? now : (current.optOutAt ? new Date(current.optOutAt) : null),
      lastUpdatedBy: "user_kill_switch",
      updatedAt: now,
    },
  });
  return getEffectiveSettings(userId);
}

export async function clearKillSwitch(userId: number): Promise<EffectiveSettings> {
  await db.update(protectiveAutoCloseSettingsTable)
    .set({ killSwitchEngaged: false, lastUpdatedBy: "user_clear_kill", updatedAt: new Date() })
    .where(eq(protectiveAutoCloseSettingsTable.userId, userId));
  return getEffectiveSettings(userId);
}
