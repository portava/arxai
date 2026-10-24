// The one read authority for the platform's safety switches (Tier 1 Platform
// Safety, single source).
//
// Every switch that can say "trading is stopped" or "this venue is open" is
// read here (or, for the per-trader halt, in ./tradingHalt.ts next to it).
// Nothing else in the server reads these columns; check-single-safety-switch-
// source fails the build when a file does.
//
//   switch                         stored in                                         read by
//   platform mode + venue enables  global_trading_settings.platform_mode,            readPlatformSwitches
//                                  demo_enabled, live_enabled
//   platform emergency stop        global_trading_settings.emergency_kill_switch     readPlatformSwitches, tradingHalt
//   operator live-execution arm    global_trading_settings.live_broker_execution_    readPlatformSwitches (AND the env
//                                  armed  (+ env ARX_LIVE_BROKER_EXECUTION_ENABLED)  master switch, one helper)
//   safety-core kill switch        safety_core.kill_switch_engaged                   readSafetyCoreSwitch, tradingHalt
//   trader kill switch             arx_live_arming.kill_switch_engaged (per user)    tradingHalt (owner: lib/live/liveArming.ts)
//
// "May this venue trade now, and why not" is venueTradingVerdict(): the venue
// must be open on the platform AND no stop switch may halt the trader there
// (./tradingHalt.ts). It adds no gate of its own and approves nothing: every
// order still passes its path's guard chain and the pre-trade Risk Governor.
//
// Fail closed, and the stricter source wins:
//   - a switch that cannot be read counts as engaged / the venue as closed;
//   - global_trading_settings is meant to hold one row, but nothing enforces
//     it (the seed can race). Readers used to pick different rows (lowest id,
//     id = 1, or an unordered LIMIT 1). Here every row is read and the
//     strictest answer wins: the emergency stop is engaged if ANY row says so,
//     a venue or the operator arm is on only if EVERY row says so. With one
//     row (every normal install) this is exactly that row.
//
// Writers are not here. The switches are written by their audited admin
// handlers (routes/adminTrading.ts and the reviewed writers listed in the
// guard) and the safety-core state machine (lib/safetyCore.ts).

import { asc } from "drizzle-orm";
import { db, globalTradingSettingsTable, safetyCoreTable } from "@workspace/db";
import { isLiveBrokerExecutionEnabledEnv } from "@workspace/domain/safety-contracts/isLiveBrokerExecutionEnabled";
import { logger } from "../logger.js";

export type GlobalTradingSettingsRow = typeof globalTradingSettingsTable.$inferSelect;
export type PlatformMode = "OFF" | "SIMULATED" | "DEMO" | "LIVE";
/** The broker venues a platform switch can open or close. */
export type BrokerVenue = "DEMO" | "LIVE";

/** Columns of global_trading_settings that are safety switches. */
export const SWITCH_FIELDS = [
  "platformMode",
  "simulatedEnabled",
  "demoEnabled",
  "liveEnabled",
  "emergencyKillSwitch",
  "killSwitchEngagedAt",
  "killSwitchReason",
  "liveBrokerExecutionArmed",
  "liveBrokerExecutionArmedAt",
  "liveBrokerExecutionArmedBy",
  "liveBrokerExecutionArmedBridgeId",
] as const satisfies readonly (keyof GlobalTradingSettingsRow)[];
export type SwitchField = (typeof SWITCH_FIELDS)[number];

/** The settings row without its safety switches (routing, shared master, policy flags). */
export type GlobalTradingConfig = Omit<GlobalTradingSettingsRow, SwitchField>;

export interface PlatformSwitches {
  /** False when the settings could not be read (or no row and fail-closed): every answer below is then the strict one. */
  readable: boolean;
  unreadableReason: "missing" | "error" | null;
  /** Rows in global_trading_settings that were combined (normally 1). */
  rowCount: number;
  platformMode: PlatformMode;
  /** The raw venue enable flags (on only if on in every row). Prefer venueOpen. */
  venueEnabled: Record<BrokerVenue, boolean>;
  /** A broker venue is open when its enable flag is on and the platform mode admits it. */
  venueOpen: Record<BrokerVenue, boolean>;
  emergencyStop: { engaged: boolean; reason: string | null; engagedAt: Date | null };
  /** Phase B master switch: the server env AND the operator's arm flag. */
  liveBrokerExecution: {
    envEnabled: boolean;
    operatorArmed: boolean;
    enabled: boolean;
    armedAt: Date | null;
    armedBy: number | null;
    armedBridgeId: number | null;
  };
}

/** What the schema defaults to: a fresh install is available, stop released, live execution not armed (owner decision 2026-10-24). */
export const DEFAULT_SWITCH_ROW: Pick<GlobalTradingSettingsRow, SwitchField> = {
  platformMode: "LIVE",
  simulatedEnabled: true,
  demoEnabled: true,
  liveEnabled: true,
  emergencyKillSwitch: false,
  killSwitchEngagedAt: null,
  killSwitchReason: null,
  liveBrokerExecutionArmed: false,
  liveBrokerExecutionArmedAt: null,
  liveBrokerExecutionArmedBy: null,
  liveBrokerExecutionArmedBridgeId: null,
};

const MODES: readonly PlatformMode[] = ["OFF", "SIMULATED", "DEMO", "LIVE"];
/** An unknown stored value reads as OFF (strictest). Exact match: the admin handler only writes these four. */
export function platformModeOf(raw: unknown): PlatformMode {
  return (MODES as readonly unknown[]).includes(raw) ? (raw as PlatformMode) : "OFF";
}

function venueOpenOn(row: Pick<GlobalTradingSettingsRow, "platformMode" | "demoEnabled" | "liveEnabled">): Record<BrokerVenue, boolean> {
  const mode = platformModeOf(row.platformMode);
  return {
    DEMO: row.demoEnabled === true && (mode === "DEMO" || mode === "LIVE"),
    LIVE: row.liveEnabled === true && mode === "LIVE",
  };
}

function failClosed(reason: "missing" | "error", rowCount = 0): PlatformSwitches {
  const envEnabled = isLiveBrokerExecutionEnabledEnv();
  return {
    readable: false,
    unreadableReason: reason,
    rowCount,
    platformMode: "OFF",
    venueEnabled: { DEMO: false, LIVE: false },
    venueOpen: { DEMO: false, LIVE: false },
    emergencyStop: { engaged: true, reason: reason === "missing" ? "settings missing" : "state unreadable", engagedAt: null },
    liveBrokerExecution: { envEnabled, operatorArmed: false, enabled: false, armedAt: null, armedBy: null, armedBridgeId: null },
  };
}

/**
 * Pure: the switches as the given rows say them. Rows in id order; the first
 * is the canonical row the admin handlers write. Empty → fail closed.
 */
export function switchesFromRows(rows: ReadonlyArray<Pick<GlobalTradingSettingsRow, SwitchField>>): PlatformSwitches {
  if (!rows.length) return failClosed("missing");
  const canonical = rows[0]!;
  const engagedRow = rows.find((r) => r.emergencyKillSwitch !== false);
  const opens = rows.map(venueOpenOn);
  // Strictest platform mode across rows (OFF < SIMULATED < DEMO < LIVE).
  const platformMode = rows.map((r) => platformModeOf(r.platformMode))
    .reduce((a, b) => (MODES.indexOf(b) < MODES.indexOf(a) ? b : a));
  const operatorArmed = rows.every((r) => r.liveBrokerExecutionArmed === true);
  const envEnabled = isLiveBrokerExecutionEnabledEnv();
  return {
    readable: true,
    unreadableReason: null,
    rowCount: rows.length,
    platformMode,
    venueEnabled: { DEMO: rows.every((r) => r.demoEnabled === true), LIVE: rows.every((r) => r.liveEnabled === true) },
    venueOpen: { DEMO: opens.every((o) => o.DEMO), LIVE: opens.every((o) => o.LIVE) },
    emergencyStop: {
      engaged: !!engagedRow,
      reason: engagedRow?.killSwitchReason ?? null,
      engagedAt: engagedRow?.killSwitchEngagedAt ?? null,
    },
    liveBrokerExecution: {
      envEnabled,
      operatorArmed,
      enabled: envEnabled && operatorArmed,
      armedAt: operatorArmed ? canonical.liveBrokerExecutionArmedAt ?? null : null,
      armedBy: operatorArmed ? canonical.liveBrokerExecutionArmedBy ?? null : null,
      armedBridgeId: operatorArmed ? canonical.liveBrokerExecutionArmedBridgeId ?? null : null,
    },
  };
}

const MAX_ROWS = 16;

async function readRows(): Promise<GlobalTradingSettingsRow[]> {
  return db.select().from(globalTradingSettingsTable).orderBy(asc(globalTradingSettingsTable.id)).limit(MAX_ROWS);
}

/**
 * The full canonical settings row (lowest id), seeding the singleton from the
 * schema defaults when there is none. Null when the read fails.
 *
 * Only the audited admin writers (and their before/after audit snapshots) use
 * the raw row; everyone else reads readPlatformSwitches() or the switch-free
 * getGlobalTradingConfig().
 */
export async function loadGlobalTradingSettingsRow(): Promise<GlobalTradingSettingsRow | null> {
  try {
    const rows = await db.select().from(globalTradingSettingsTable)
      .orderBy(asc(globalTradingSettingsTable.id)).limit(1);
    if (rows[0]) return rows[0];
    // Seed the singleton from the schema defaults if missing: trading
    // available, emergency stop released (owner decision 2026-10-24).
    const inserted = await db.insert(globalTradingSettingsTable).values({}).returning();
    return inserted[0]!;
  } catch (err) {
    logger.warn({ err: String(err) }, "global_trading_settings read failed; using fail-closed default");
    return null;
  }
}

/** Removes the safety switches from a settings row. */
export function configView(row: GlobalTradingSettingsRow): GlobalTradingConfig {
  const out: Record<string, unknown> = { ...row };
  for (const f of SWITCH_FIELDS) delete out[f];
  return out as GlobalTradingConfig;
}

/** The canonical settings row without its switches (seeds like loadGlobalTradingSettingsRow). Null when unreadable. */
export async function getGlobalTradingConfig(): Promise<GlobalTradingConfig | null> {
  const row = await loadGlobalTradingSettingsRow();
  return row ? configView(row) : null;
}

export interface ReadSwitchesOptions {
  /**
   * When global_trading_settings has no row:
   *   "fail_closed" (default) — stop engaged, venues closed, not armed;
   *   "defaults"  — the schema defaults (a fresh install is available), no write;
   *   "seed"      — insert the singleton from the schema defaults, then read it.
   * A read error always fails closed.
   */
  ifMissing?: "fail_closed" | "defaults" | "seed";
}

/** The platform switches, every row combined strictly. Never throws. */
export async function readPlatformSwitches(opts: ReadSwitchesOptions = {}): Promise<PlatformSwitches> {
  const ifMissing = opts.ifMissing ?? "fail_closed";
  try {
    let rows = await readRows();
    if (!rows.length && ifMissing === "seed") {
      await loadGlobalTradingSettingsRow();
      rows = await readRows();
    }
    if (!rows.length) return ifMissing === "defaults" ? { ...switchesFromRows([DEFAULT_SWITCH_ROW]), rowCount: 0 } : failClosed("missing");
    return switchesFromRows(rows);
  } catch (err) {
    logger.warn({ err: String(err) }, "platform switches unreadable; failing closed");
    return failClosed("error");
  }
}

/** Platform switches plus the switch-free config, from one read of the table. */
export async function loadPlatformSettings(opts: ReadSwitchesOptions = {}): Promise<{
  switches: PlatformSwitches;
  config: GlobalTradingConfig | null;
}> {
  const ifMissing = opts.ifMissing ?? "fail_closed";
  try {
    let rows = await readRows();
    if (!rows.length && ifMissing === "seed") {
      await loadGlobalTradingSettingsRow();
      rows = await readRows();
    }
    if (!rows.length) {
      return { switches: ifMissing === "defaults" ? { ...switchesFromRows([DEFAULT_SWITCH_ROW]), rowCount: 0 } : failClosed("missing"), config: null };
    }
    return { switches: switchesFromRows(rows), config: configView(rows[0]!) };
  } catch (err) {
    logger.warn({ err: String(err) }, "platform settings unreadable; failing closed");
    return { switches: failClosed("error"), config: null };
  }
}

// ── Safety core ─────────────────────────────────────────────────────────────

export interface SafetyCoreSwitch {
  readable: boolean;
  /** Null when there is no safety_core row yet (lib/safetyCore.ts seeds it at boot). */
  present: boolean;
  engaged: boolean;
  reason: string | null;
  engagedAt: Date | null;
  operationalMode: string | null;
  globalState: string | null;
}

/**
 * The safety-core kill switch from the canonical (lowest id) safety_core row,
 * without seeding it (a read never writes). lib/safetyCore.ts owns the row.
 * A read error reports readable=false, engaged=true.
 */
export async function readSafetyCoreSwitch(): Promise<SafetyCoreSwitch> {
  try {
    const row = (await db.select({
      on: safetyCoreTable.killSwitchEngaged,
      why: safetyCoreTable.killSwitchReason,
      at: safetyCoreTable.killSwitchEngagedAt,
      mode: safetyCoreTable.operationalMode,
      state: safetyCoreTable.globalState,
    }).from(safetyCoreTable).orderBy(asc(safetyCoreTable.id)).limit(1))[0];
    if (!row) return { readable: true, present: false, engaged: false, reason: null, engagedAt: null, operationalMode: null, globalState: null };
    return {
      readable: true, present: true, engaged: row.on === true, reason: row.why ?? null, engagedAt: row.at ?? null,
      operationalMode: row.mode ?? null, globalState: row.state ?? null,
    };
  } catch (err) {
    logger.warn({ err: String(err) }, "safety_core unreadable; failing closed");
    return { readable: false, present: false, engaged: true, reason: "state unreadable", engagedAt: null, operationalMode: null, globalState: null };
  }
}
