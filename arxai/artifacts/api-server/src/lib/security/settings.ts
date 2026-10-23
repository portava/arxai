// Build NN — security settings registry. Hard-locks paper-only and live-disabled.

import { db, securitySettingsTable } from "@workspace/db";

export type Settings = typeof securitySettingsTable.$inferSelect;

export async function getSettings(): Promise<Settings> {
  const rows = await db.select().from(securitySettingsTable).limit(1);
  if (rows.length > 0) return rows[0];
  const [created] = await db.insert(securitySettingsTable).values({}).returning();
  return created;
}

export interface PatchSettings {
  authRequired?: boolean;
  rateLimitEnabled?: boolean;
}

export const HARD_LOCKED_SETTING_KEYS = [
  "roleSystemEnabled","auditLoggingEnabled","secretRedactionEnabled",
  "criticalAlertsAlwaysOn","paperOnlyEnforced","liveTradingPermanentlyDisabled",
] as const;

export interface PatchResult {
  ok: boolean;
  settings: Settings;
  rejected: string[];
  attemptedHardLockChange: boolean;
}

export async function patchSettings(patch: Record<string, unknown>): Promise<PatchResult> {
  const attemptedHardLockChange = Object.keys(patch).some(
    (k) => (HARD_LOCKED_SETTING_KEYS as readonly string[]).includes(k)
  );
  if (attemptedHardLockChange) {
    return { ok: false, settings: await getSettings(), rejected: Object.keys(patch).filter((k) => (HARD_LOCKED_SETTING_KEYS as readonly string[]).includes(k)), attemptedHardLockChange: true };
  }
  const safe: Record<string, unknown> = {};
  if (typeof patch.authRequired === "boolean") safe.authRequired = patch.authRequired;
  if (typeof patch.rateLimitEnabled === "boolean") safe.rateLimitEnabled = patch.rateLimitEnabled;
  // Always re-assert hard locks.
  safe.roleSystemEnabled = true;
  safe.auditLoggingEnabled = true;
  safe.secretRedactionEnabled = true;
  safe.criticalAlertsAlwaysOn = true;
  safe.paperOnlyEnforced = true;
  safe.liveTradingPermanentlyDisabled = true;
  safe.updatedAt = new Date();
  const rejected = Object.keys(patch).filter((k) => !["authRequired","rateLimitEnabled"].includes(k));
  await db.update(securitySettingsTable).set(safe);
  return { ok: true, settings: await getSettings(), rejected, attemptedHardLockChange: false };
}
