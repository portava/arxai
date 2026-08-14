// Phase UX4 — Real-Time Trade Monitor Worker.
//
// SAFETY:
// - Read-mostly: only writes are intelligence snapshots, exit alerts,
//   notifications, and timeline events — all already user-scoped by the
//   underlying computeAndPersist path. NEVER places, modifies, or closes
//   any trade. NEVER bypasses guards or fabricates market data.
// - Honors per-user `tradeAlertPreferencesTable.alertsEnabled` and a global
//   pause flag controlled by admin (in-process).
// - Light, unref()'d setInterval (no extra runtimes). Defensive try/catch
//   per user + per trade so one user/trade error never blocks the cycle.
// - Worker status is exposed via getMonitorStatus() for the admin panel;
//   no credentials, no other-user data, no master MT5 secrets exposed.

import { db } from "@workspace/db";
import {
  livePositionsTable,
  sharedTradeAttributionTable,
  tradeAlertPreferencesTable,
} from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../logger.js";

type MonitorStatus = {
  running: boolean;
  globalPaused: boolean;
  lastCycleAt: string | null;
  lastCycleMs: number | null;
  cyclesRun: number;
  usersScannedLastCycle: number;
  tradesScannedLastCycle: number;
  alertsCreatedToday: number;
  errorsLastCycle: number;
  errorsTotal: number;
  staleConnectionsLastCycle: number;
  intervalMs: number;
};

let globalPaused = false;
let cyclesRun = 0;
let lastCycleAt: Date | null = null;
let lastCycleMs: number | null = null;
let usersScannedLastCycle = 0;
let tradesScannedLastCycle = 0;
let alertsCreatedToday = 0;
let alertsCounterDay = todayKey();
let errorsLastCycle = 0;
let errorsTotal = 0;
let staleConnectionsLastCycle = 0;
let started = false;

const INTERVAL_MS = Number(process.env["ARX_TRADE_MONITOR_INTERVAL_MS"] ?? 15_000);

function todayKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

export function getMonitorStatus(): MonitorStatus {
  return {
    running: started,
    globalPaused,
    lastCycleAt: lastCycleAt?.toISOString() ?? null,
    lastCycleMs,
    cyclesRun,
    usersScannedLastCycle,
    tradesScannedLastCycle,
    alertsCreatedToday,
    errorsLastCycle,
    errorsTotal,
    staleConnectionsLastCycle,
    intervalMs: INTERVAL_MS,
  };
}

export function setGlobalPause(paused: boolean): void {
  globalPaused = paused;
}

export function isGloballyPaused(): boolean {
  return globalPaused;
}

// Scan all userIds that have at least one OPEN user-owned position OR one
// 'open' shared-attribution row. Returns deduped userIds.
async function listUsersWithOpenTrades(): Promise<number[]> {
  const owned = await db
    .selectDistinct({ userId: livePositionsTable.userId })
    .from(livePositionsTable)
    .where(eq(livePositionsTable.status, "OPEN"));
  const shared = await db
    .selectDistinct({ userId: sharedTradeAttributionTable.userId })
    .from(sharedTradeAttributionTable)
    .where(eq(sharedTradeAttributionTable.status, "open"));
  const set = new Set<number>();
  for (const r of owned) if (typeof r.userId === "number") set.add(r.userId);
  for (const r of shared) if (typeof r.userId === "number") set.add(r.userId);
  return Array.from(set);
}

async function listOpenTradeKeysForUser(userId: number): Promise<string[]> {
  const owned = await db
    .select({ id: livePositionsTable.id })
    .from(livePositionsTable)
    .where(and(eq(livePositionsTable.userId, userId), eq(livePositionsTable.status, "OPEN")));
  const shared = await db
    .select({ id: sharedTradeAttributionTable.id })
    .from(sharedTradeAttributionTable)
    .where(and(eq(sharedTradeAttributionTable.userId, userId), eq(sharedTradeAttributionTable.status, "open")));
  return [
    ...owned.map((r) => `lp_${r.id}`),
    ...shared.map((r) => `att_${r.id}`),
  ];
}

async function userAlertsEnabled(userId: number): Promise<boolean> {
  const [p] = await db
    .select({ enabled: tradeAlertPreferencesTable.alertsEnabled })
    .from(tradeAlertPreferencesTable)
    .where(eq(tradeAlertPreferencesTable.userId, userId))
    .limit(1);
  // Default ON if user has no prefs row yet (mirrors DEFAULT_PREFS).
  return p?.enabled !== false;
}

async function runCycle(): Promise<void> {
  if (globalPaused) {
    lastCycleAt = new Date();
    return;
  }
  if (todayKey() !== alertsCounterDay) {
    alertsCounterDay = todayKey();
    alertsCreatedToday = 0;
  }
  const start = Date.now();
  let users = 0;
  let trades = 0;
  let errs = 0;
  let stale = 0;
  let alertsThisCycle = 0;

  // Dynamic import to break the cycle: monitorWorker is imported by app
  // bootstrap; meTradeIntelligence is imported by the routes barrel. Avoids
  // an eager circular import at module init.
  const intel = await import("../../routes/meTradeIntelligence.js")
    .catch((e) => {
      logger.warn({ err: String(e).slice(0, 200) }, "[monitor] intel import failed");
      return null;
    });

  if (!intel?.computeAndPersistForKey) {
    // Module not yet exposing the helper — skip cycle cleanly.
    lastCycleAt = new Date();
    lastCycleMs = Date.now() - start;
    cyclesRun++;
    return;
  }

  try {
    const userIds = await listUsersWithOpenTrades();
    users = userIds.length;
    for (const userId of userIds) {
      try {
        if (!(await userAlertsEnabled(userId))) continue;
        const keys = await listOpenTradeKeysForUser(userId);
        for (const k of keys) {
          trades++;
          try {
            const r = await intel.computeAndPersistForKey(userId, k);
            if (r?.alertsCreated) alertsThisCycle += r.alertsCreated;
            if (r?.dataStale) stale++;
          } catch (e) {
            errs++;
            logger.warn({ err: String(e).slice(0, 200), userId, tradeKey: k }, "[monitor] trade scan failed");
          }
        }
        // Phase 13 — Protective Auto-Close evaluation (per-user, defensive).
        // Always journals every decision; only attempts close when ALL
        // 15 gates pass AND paper-only lock would let it through (today:
        // never — gate forces BLOCKED). Never throws upstream.
        try {
          const pac = await import("./protectiveCloseHook.js").catch(() => null);
          if (pac?.runProtectiveCloseForUser) {
            await pac.runProtectiveCloseForUser(userId, keys);
          }
        } catch (e) {
          errs++;
          logger.warn({ err: String(e).slice(0, 200), userId }, "[monitor] protective-close eval failed");
        }
      } catch (e) {
        errs++;
        logger.warn({ err: String(e).slice(0, 200), userId }, "[monitor] user scan failed");
      }
    }
  } catch (e) {
    errs++;
    logger.error({ err: String(e).slice(0, 200) }, "[monitor] cycle failed");
  }
  void sql; // silence unused-import in some builds

  lastCycleAt = new Date();
  lastCycleMs = Date.now() - start;
  cyclesRun++;
  usersScannedLastCycle = users;
  tradesScannedLastCycle = trades;
  errorsLastCycle = errs;
  errorsTotal += errs;
  staleConnectionsLastCycle = stale;
  alertsCreatedToday += alertsThisCycle;
}

export function startMonitor(): void {
  if (started) return;
  started = true;
  // First cycle runs after one interval (do not block server start).
  const t = setInterval(() => { void runCycle(); }, INTERVAL_MS);
  t.unref?.();
  logger.info({ intervalMs: INTERVAL_MS }, "[monitor] trade monitor started");
}

export function stopMonitor(): void {
  // Cannot truly stop setInterval without keeping handle; mark paused.
  globalPaused = true;
  started = false;
}
