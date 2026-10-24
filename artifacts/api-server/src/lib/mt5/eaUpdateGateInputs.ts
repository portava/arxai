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
// position, a live command still in flight, and heartbeat stability. The
// install-wide stops are deliberately NOT inputs (owner decision; an EA update
// is not an order and no governor runs behind it).

import { and, eq, inArray } from "drizzle-orm";
import { db, eaRemoteConfigTable, arxLiveCommandsTable } from "@workspace/db";
import { readOpenPositions } from "../positions/openPositions.js";
import { getMyArming } from "../live/liveArming.js";
import { EA_HEARTBEAT_FRESH_MS } from "../brokerHub/freshness.js";

/** Live command statuses that mean a command is still in flight. */
export const EA_UPDATE_PENDING_COMMAND_STATUSES = ["SENT_TO_MT5_LIVE", "LIVE_APPROVED"] as const;

export interface EaUpdateGateSafetyInputs {
  hasOpenLiveTrade: boolean;
  hasPendingCommand: boolean;
  heartbeatStable: boolean;
  killSwitchEngaged: boolean;
  maintenanceMode: boolean;
}

/** The reads behind the inputs (injectable for tests). */
export interface EaUpdateGateReaders {
  killSwitchEngaged(userId: number): Promise<boolean>;
  hasOpenLiveTrade(userId: number): Promise<boolean>;
  hasPendingCommand(userId: number): Promise<boolean>;
  maintenanceMode(userId: number): Promise<boolean>;
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
};

/** Heartbeat stability for the update gate: last heartbeat within the 15 s gate window. */
export function isHeartbeatStableForEaUpdate(lastHeartbeat: Date | null | undefined, nowMs: number): boolean {
  const lastHb = lastHeartbeat ? new Date(lastHeartbeat).getTime() : 0;
  return nowMs - lastHb <= EA_HEARTBEAT_FRESH_MS;
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
  const heartbeatStable = isHeartbeatStableForEaUpdate(lastHeartbeat, opts.nowMs ?? Date.now());
  return { hasOpenLiveTrade, hasPendingCommand, heartbeatStable, killSwitchEngaged, maintenanceMode };
}

/**
 * The admin EA-health preview's inputs for one connection: the same loader the
 * EA's update check uses. A connection with no user can never call the
 * per-user update check, and there is no trader state to read for it, so only
 * the heartbeat window is evaluated and the trader-scoped inputs are reported
 * clear (the real check never runs for such a row).
 */
export async function previewEaUpdateGateSafety(
  userId: number | null,
  lastHeartbeat: Date | null | undefined,
  now: Date,
  readers?: EaUpdateGateReaders,
): Promise<EaUpdateGateSafetyInputs> {
  if (userId == null) {
    return {
      hasOpenLiveTrade: false,
      hasPendingCommand: false,
      heartbeatStable: isHeartbeatStableForEaUpdate(lastHeartbeat, now.getTime()),
      killSwitchEngaged: false,
      maintenanceMode: false,
    };
  }
  return loadEaUpdateGateSafetyInputs(userId, lastHeartbeat, { nowMs: now.getTime(), readers });
}
