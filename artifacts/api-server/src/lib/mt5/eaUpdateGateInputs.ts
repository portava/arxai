// The safety inputs of the EA self-update gate, read once for every caller.
//
// The EA's real check (`GET /mt5/update-check`, routes/mt5RemoteOps.ts) and the
// admin EA-health preview (`GET /admin/ea/health`, routes/adminEaHealth.ts)
// both feed `evaluateEaUpdateGate` from here, so the preview reports the same
// decision the EA gets. Before this module the preview hardcoded
// killSwitchEngaged / maintenanceMode / hasOpenLiveTrade to false and used the
// watchdog's liveness instead of the gate's heartbeat window, so it could say
// "update allowed" where the EA's real check blocked.
//
// This module only READS. It does not change what the gate blocks on: the
// trader's own kill switch (arx_live_arming via liveArming.getMyArming), the
// per-trader EA remote-config maintenance flag (ea_remote_config), an open LIVE
// position, a live command still in flight, and heartbeat stability. Round 5
// (owner decision 5) adds the install-wide stops: while the platform emergency
// stop or the safety-core kill switch is engaged (or unreadable) the EA gets
// no automatic update. It is read last, through the platform-stop authority
// (lib/safety/platformSwitches.platformStop), so the existing reads keep their
// order. There is no bypass: the update stays blocked until the stop is
// released through its own audited release. The admin preview (diagnostics)
// still runs and reports the reason.

import { and, eq, inArray } from "drizzle-orm";
import { db, eaRemoteConfigTable, arxLiveCommandsTable } from "@workspace/db";
import { readOpenPositions } from "../positions/openPositions.js";
import { getMyArming } from "../live/liveArming.js";
import { classifyHeartbeatAt, heartbeatAllowsExecution } from "../brokerHub/freshness.js";
import { platformStop } from "../safety/platformSwitches.js";

/** Live command statuses that mean a command is still in flight. */
export const EA_UPDATE_PENDING_COMMAND_STATUSES = ["SENT_TO_MT5_LIVE", "LIVE_APPROVED"] as const;

export interface EaUpdateGateSafetyInputs {
  hasOpenLiveTrade: boolean;
  hasPendingCommand: boolean;
  heartbeatStable: boolean;
  killSwitchEngaged: boolean;
  /** Either install-wide stop (unreadable = engaged). */
  platformStopEngaged: boolean;
  maintenanceMode: boolean;
}

/** The reads behind the inputs (injectable for tests). */
export interface EaUpdateGateReaders {
  killSwitchEngaged(userId: number): Promise<boolean>;
  hasOpenLiveTrade(userId: number): Promise<boolean>;
  hasPendingCommand(userId: number): Promise<boolean>;
  maintenanceMode(userId: number): Promise<boolean>;
  /** Install-wide, not per trader. */
  platformStopEngaged(): Promise<boolean>;
}

export const dbEaUpdateGateReaders: EaUpdateGateReaders = {
  async killSwitchEngaged(userId) {
    const arming = await getMyArming(userId);
    return !!arming?.killSwitchEngaged;
  },
  async hasOpenLiveTrade(userId) {
    const open = await readOpenPositions({ userId, venue: "LIVE", basis: "UNCLOSED", limit: 1 });
    return open.length > 0;
  },
  async hasPendingCommand(userId) {
    const rows = await db
      .select({ id: arxLiveCommandsTable.id })
      .from(arxLiveCommandsTable)
      .where(
        and(
          eq(arxLiveCommandsTable.userId, userId),
          inArray(arxLiveCommandsTable.status, [...EA_UPDATE_PENDING_COMMAND_STATUSES]),
        ),
      )
      .limit(1);
    return rows.length > 0;
  },
  // maintenanceMode is a per-trader remote-config tunable.
  async maintenanceMode(userId) {
    const [cfg] = await db
      .select({ maintenanceMode: eaRemoteConfigTable.maintenanceMode })
      .from(eaRemoteConfigTable)
      .where(eq(eaRemoteConfigTable.userId, userId))
      .limit(1);
    return !!cfg?.maintenanceMode;
  },
  // Both install-wide stops; platformStop() never throws and fails closed.
  async platformStopEngaged() {
    return (await platformStop()).engaged;
  },
};

/**
 * Heartbeat stability for the update gate: the heartbeat must be "fresh" under
 * the shared policy (age < 15 s). Missing, invalid or future-dated → not stable.
 */
export function isHeartbeatStableForEaUpdate(lastHeartbeat: Date | null | undefined, nowMs: number): boolean {
  return heartbeatAllowsExecution(classifyHeartbeatAt(lastHeartbeat ?? null, nowMs));
}

/**
 * Read the update gate's safety inputs for one trader's bridge. Reads run in
 * the order the update-check route always used; `nowMs` defaults to the clock
 * after the reads, as before.
 */
export async function loadEaUpdateGateSafetyInputs(
  userId: number,
  lastHeartbeat: Date | null | undefined,
  opts: { nowMs?: number; readers?: EaUpdateGateReaders } = {},
): Promise<EaUpdateGateSafetyInputs> {
  const r = opts.readers ?? dbEaUpdateGateReaders;
  const killSwitchEngaged = await r.killSwitchEngaged(userId);
  const hasOpenLiveTrade = await r.hasOpenLiveTrade(userId);
  const hasPendingCommand = await r.hasPendingCommand(userId);
  const maintenanceMode = await r.maintenanceMode(userId);
  const platformStopEngaged = await r.platformStopEngaged();
  const heartbeatStable = isHeartbeatStableForEaUpdate(lastHeartbeat, opts.nowMs ?? Date.now());
  return { hasOpenLiveTrade, hasPendingCommand, heartbeatStable, killSwitchEngaged, platformStopEngaged, maintenanceMode };
}

/**
 * The admin EA-health preview's inputs for one connection: the same loader the
 * EA's update check uses. A connection with no user can never call the
 * per-user update check, and there is no trader state to read for it, so only
 * the heartbeat window and the install-wide stops are evaluated and the
 * trader-scoped inputs are reported clear (the real check never runs for such
 * a row).
 */
export async function previewEaUpdateGateSafety(
  userId: number | null,
  lastHeartbeat: Date | null | undefined,
  now: Date,
  readers?: EaUpdateGateReaders,
): Promise<EaUpdateGateSafetyInputs> {
  if (userId == null) {
    // The install-wide stops are not trader-scoped, so they are read here too.
    const platformStopEngaged = await (readers ?? dbEaUpdateGateReaders).platformStopEngaged();
    return {
      platformStopEngaged,
      hasOpenLiveTrade: false,
      hasPendingCommand: false,
      heartbeatStable: isHeartbeatStableForEaUpdate(lastHeartbeat, now.getTime()),
      killSwitchEngaged: false,
      maintenanceMode: false,
    };
  }
  return loadEaUpdateGateSafetyInputs(userId, lastHeartbeat, { nowMs: now.getTime(), readers });
}
