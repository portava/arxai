// Build MM — System config registry.
//
// SAFETY: This registry is for visibility and SAFE settings only. It cannot
// enable live trading. liveTradingEnabled is hard-locked to false. brokerMode
// is hard-locked to READ_ONLY. marketDataMode is hard-locked to read_only.
// notificationCriticalAlwaysOn is hard-locked to true. paper-only mode cannot
// be turned off.

import { db, systemConfigRegistryTable } from "@workspace/db";
import { desc } from "drizzle-orm";

export interface SystemConfig {
  id: number;
  appMode: "PAPER_ONLY";
  liveTradingEnabled: false;
  brokerMode: "READ_ONLY";
  marketDataMode: "read_only";
  paperAutopilotEnabled: boolean;
  notificationCriticalAlwaysOn: true;
  replayOnlyMode: boolean;
  dataImportEnabled: boolean;
  secretRedactionEnabled: true;
  currentSafetyLock: string | null;
  lastHealthCheckAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const HARD_LOCK = {
  appMode: "PAPER_ONLY" as const,
  liveTradingEnabled: false as const,
  brokerMode: "READ_ONLY" as const,
  marketDataMode: "read_only" as const,
  notificationCriticalAlwaysOn: true as const,
  secretRedactionEnabled: true as const,
};

async function ensureConfig(): Promise<SystemConfig> {
  const rows = await db.select().from(systemConfigRegistryTable).orderBy(desc(systemConfigRegistryTable.id)).limit(1);
  if (rows.length === 0) {
    const [created] = await db.insert(systemConfigRegistryTable).values({}).returning();
    return enforceLocks(created!);
  }
  return enforceLocks(rows[0]!);
}

function enforceLocks(row: typeof systemConfigRegistryTable.$inferSelect): SystemConfig {
  return {
    id: row.id,
    appMode: HARD_LOCK.appMode,
    liveTradingEnabled: HARD_LOCK.liveTradingEnabled,
    brokerMode: HARD_LOCK.brokerMode,
    marketDataMode: HARD_LOCK.marketDataMode,
    paperAutopilotEnabled: row.paperAutopilotEnabled,
    notificationCriticalAlwaysOn: HARD_LOCK.notificationCriticalAlwaysOn,
    replayOnlyMode: row.replayOnlyMode,
    dataImportEnabled: row.dataImportEnabled,
    secretRedactionEnabled: HARD_LOCK.secretRedactionEnabled,
    currentSafetyLock: row.currentSafetyLock,
    lastHealthCheckAt: row.lastHealthCheckAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getConfig(): Promise<SystemConfig> {
  return ensureConfig();
}

export interface ConfigPatch {
  paperAutopilotEnabled?: boolean;
  replayOnlyMode?: boolean;
  dataImportEnabled?: boolean;
  currentSafetyLock?: string | null;
  lastHealthCheckAt?: Date | null;
  // ── Forbidden fields (silently ignored, hard-locked above) ──
  appMode?: string; liveTradingEnabled?: boolean; brokerMode?: string;
  marketDataMode?: string; notificationCriticalAlwaysOn?: boolean;
  secretRedactionEnabled?: boolean;
}

export async function patchConfig(patch: ConfigPatch): Promise<SystemConfig> {
  const cur = await ensureConfig();
  const safe: Partial<typeof systemConfigRegistryTable.$inferInsert> = { updatedAt: new Date() };
  if (patch.paperAutopilotEnabled != null) safe.paperAutopilotEnabled = !!patch.paperAutopilotEnabled;
  if (patch.replayOnlyMode != null)        safe.replayOnlyMode = !!patch.replayOnlyMode;
  if (patch.dataImportEnabled != null)     safe.dataImportEnabled = !!patch.dataImportEnabled;
  if (patch.currentSafetyLock !== undefined) safe.currentSafetyLock = patch.currentSafetyLock;
  if (patch.lastHealthCheckAt !== undefined) safe.lastHealthCheckAt = patch.lastHealthCheckAt;
  // hard-locks always re-asserted on every write
  safe.appMode = HARD_LOCK.appMode;
  safe.liveTradingEnabled = HARD_LOCK.liveTradingEnabled;
  safe.brokerMode = HARD_LOCK.brokerMode;
  safe.marketDataMode = HARD_LOCK.marketDataMode;
  safe.notificationCriticalAlwaysOn = HARD_LOCK.notificationCriticalAlwaysOn;
  safe.secretRedactionEnabled = HARD_LOCK.secretRedactionEnabled;
  await db.update(systemConfigRegistryTable).set(safe).where((await import("drizzle-orm")).eq(systemConfigRegistryTable.id, cur.id));
  return ensureConfig();
}
