// The one writer that ENGAGES the platform emergency stop (Tier 1 Platform
// Safety, round 4).
//
// global_trading_settings has no singleton constraint, and the read authority
// (./platformSwitches.ts) says the stop is engaged when ANY row says so. An
// engage that wrote one row only was therefore safe for the reader but left
// the rows disagreeing. engagePlatformStop() writes every row the same way:
// emergency_kill_switch = true, kill_switch_engaged_at, kill_switch_reason and
// updated_by_admin_id (the actor), all from one timestamp.
//
// Callers are the audited admin handlers. Each keeps writing its own audit
// event (same action name and before/after snapshot as before) in the same
// request; check-single-safety-switch-source fails the build when a file
// writes an engaged emergency stop anywhere else, or when a caller of this
// writer does not write admin_action_audit_log.
//
// Not here: RELEASING the stop. The reset handler (routes/adminTrading.ts) and
// the activation handler (routes/adminLiveSharedReadiness.ts) still release
// it themselves. Whether activation may release a stop at all is an owner
// decision, so the release paths are left as they are.

import { db, globalTradingSettingsTable } from "@workspace/db";
import { logger } from "../logger.js";
import type { GlobalTradingSettingsRow } from "./platformSwitches.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** The database handle or an open transaction (a caller that engages inside its own transaction passes it). */
export type StopWriteExecutor = typeof db | Tx;

/** Which audited handler engaged the stop (logged with the write). */
export type PlatformStopEngageSource =
  | "admin_trading_emergency_kill"
  | "admin_live_shared_kill_switch"
  | "admin_live_shared_rollback";

export interface EngagePlatformStopArgs {
  /** Stored as kill_switch_reason, exactly as given. */
  reason: string;
  /** Stored as updated_by_admin_id. */
  actorUserId: number | null;
  source: PlatformStopEngageSource;
}

export interface EngagePlatformStopResult {
  engagedAt: Date;
  /** Every settings row after the write, in id order (the first is the canonical row). */
  rows: GlobalTradingSettingsRow[];
}

/**
 * Engage the platform emergency stop on EVERY global_trading_settings row.
 * Throws when the write fails (the caller's handler answers with its error, as
 * before); a write that matched no row also throws, since nothing was engaged.
 */
export async function engagePlatformStop(
  args: EngagePlatformStopArgs,
  exec: StopWriteExecutor = db,
): Promise<EngagePlatformStopResult> {
  const engagedAt = new Date();
  const updated = await exec.update(globalTradingSettingsTable)
    .set({
      emergencyKillSwitch: true,
      killSwitchEngagedAt: engagedAt,
      killSwitchReason: args.reason,
      updatedByAdminId: args.actorUserId,
      updatedAt: engagedAt,
    })
    .returning();
  if (!updated.length) throw new Error("engagePlatformStop: no global_trading_settings row to engage");
  const rows = [...updated].sort((a, b) => a.id - b.id);
  logger.warn(
    { source: args.source, actorUserId: args.actorUserId, reason: args.reason, engagedAt: engagedAt.toISOString(), rowCount: rows.length },
    "platform emergency stop engage written (commits with the caller's transaction)",
  );
  return { engagedAt, rows };
}

/** The canonical (lowest id) row after an engage, or the row with this id when given. */
export function engagedRow(result: EngagePlatformStopResult, id?: number): GlobalTradingSettingsRow {
  return (id != null ? result.rows.find((r) => r.id === id) : undefined) ?? result.rows[0]!;
}
