// The one writer that ENGAGES the platform emergency stop, and the one release
// operation for either install-wide stop (Tier 1 Platform
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
// RELEASING a stop (round 5, owner decision 1) is releasePlatformStop() below:
// the one explicit, authorized, audited release of ONE selected install-wide
// stop. Live activation never releases a stop (it refuses and points here).
//
//   platform_emergency_stop  every global_trading_settings row: flag false,
//                            engaged-at and reason cleared, actor recorded;
//                            the audit row (keeping the reason and time it had)
//                            is written in the same transaction.
//   safety_core_kill_switch  delegated to its owner, lib/safetyCore.ts
//                            resetKillSwitch() (acknowledgement required; it
//                            drops to OBSERVE_ONLY / RECOVERY_MODE), then audited.
//
// A release never touches the other stop and never arms anything: the operator
// live-execution arm, platform mode, venue enables and the safety-core mode are
// not raised (the safety core's own reset lowers its mode, never raises it).

import { db, globalTradingSettingsTable, adminActionAuditLogTable } from "@workspace/db";
import { logger } from "../logger.js";
import { operatorRoleFromSession } from "../security/adminRoleGate.js";
import { resetKillSwitch } from "../safetyCore.js";
import {
  platformStop,
  stopSourceEngaged,
  type GlobalTradingSettingsRow,
  type PlatformStop,
  type PlatformStopSource,
} from "./platformSwitches.js";

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

// ── Release: one explicit, authorized, audited operation (owner decision 1) ──

/** Which audited surface asked for the release (logged and stored in the audit row). */
export type PlatformStopReleaseSource =
  | "admin_trading_reset_kill"
  | "system_kill_switch_reset";

/** The audit action each stop's release writes (the emergency stop keeps reset-kill's historical name). */
export const RELEASE_AUDIT_ACTION: Record<PlatformStopSource, string> = {
  platform_emergency_stop: "RESET_KILL_SWITCH",
  safety_core_kill_switch: "RESET_SAFETY_CORE_KILL_SWITCH",
};

export interface ReleasePlatformStopArgs {
  /** The ONE stop to release. The other stop is never touched. */
  stop: PlatformStopSource;
  /** Why (at least 4 characters); stored in the audit row. */
  reason: string;
  actor: { userId: number | null; role: string | null | undefined };
  source: PlatformStopReleaseSource;
  ipAddress?: string | null;
  /** safety_core_kill_switch only: the owner's acknowledgement phrase. */
  acknowledgement?: string;
  /** safety_core_kill_switch only: the label the safety core records as resetBy (default "<role>:<userId>"). */
  resetBy?: string;
}

export type ReleasePlatformStopRefusal = "NOT_AUTHORIZED" | "REASON_REQUIRED" | "NO_SETTINGS_ROW" | "SAFETY_CORE_REFUSED";

export type ReleasePlatformStopResult =
  | {
    ok: true;
    stop: PlatformStopSource;
    /** Was the selected stop engaged just before the release. */
    wasEngaged: boolean;
    releasedAt: Date;
    /** platform_emergency_stop: every settings row after the write, in id order. */
    rows: GlobalTradingSettingsRow[];
    /** safety_core_kill_switch: the owner's answer. */
    safetyCore?: { reasons: string[]; blockers: string[] };
  }
  | {
    ok: false;
    stop: PlatformStopSource;
    code: ReleasePlatformStopRefusal;
    message: string;
    safetyCore?: { reasons: string[]; blockers: string[] };
  };

/** The before-state read; tests inject it. */
export interface ReleasePlatformStopDeps {
  readStop?: () => Promise<PlatformStop>;
}

/**
 * Release ONE install-wide stop. Refuses (writes nothing) unless the actor is
 * an operator (ADMIN/OWNER) and gives a reason. A refusal is returned, never
 * thrown; a database error throws (for the emergency stop nothing is
 * committed: the write and its audit row are one transaction).
 */
export async function releasePlatformStop(
  args: ReleasePlatformStopArgs,
  deps: ReleasePlatformStopDeps = {},
): Promise<ReleasePlatformStopResult> {
  const role = operatorRoleFromSession(args.actor.role);
  if (!role) {
    return { ok: false, stop: args.stop, code: "NOT_AUTHORIZED", message: "Only an ADMIN or OWNER may release an install-wide stop." };
  }
  const reason = String(args.reason ?? "").trim();
  if (reason.length < 4) {
    return { ok: false, stop: args.stop, code: "REASON_REQUIRED", message: "A reason (at least 4 characters) is required to release a stop." };
  }
  const before = await (deps.readStop ?? platformStop)();
  const wasEngaged = stopSourceEngaged(before, args.stop);
  const beforeState = {
    stop: args.stop,
    engaged: wasEngaged,
    reason: before.detail[args.stop] ?? null,
    engagedAt: before.engagedAt?.[args.stop]?.toISOString() ?? null,
    otherStopsEngaged: before.sources.filter((s) => s !== args.stop),
    source: args.source,
  };

  if (args.stop === "safety_core_kill_switch") {
    const r = await resetKillSwitch({
      resetBy: args.resetBy ?? `${role.toLowerCase()}:${args.actor.userId ?? "unknown"}`,
      acknowledgement: args.acknowledgement ?? "",
    });
    if (!r.ok) {
      return {
        ok: false, stop: args.stop, code: "SAFETY_CORE_REFUSED",
        message: r.blockers.join("; ") || "The safety core refused the reset.",
        safetyCore: { reasons: r.reasons, blockers: r.blockers },
      };
    }
    const releasedAt = new Date();
    await db.insert(adminActionAuditLogTable).values({
      adminId: args.actor.userId,
      adminRole: role,
      action: RELEASE_AUDIT_ACTION[args.stop],
      beforeState,
      afterState: { stop: args.stop, engaged: false, releasedAt: releasedAt.toISOString() },
      reason,
      ipAddress: args.ipAddress ?? null,
    });
    logger.warn({ stop: args.stop, source: args.source, actorUserId: args.actor.userId, wasEngaged }, "safety-core kill switch released (audited)");
    return { ok: true, stop: args.stop, wasEngaged, releasedAt, rows: [], safetyCore: { reasons: r.reasons, blockers: r.blockers } };
  }

  // platform_emergency_stop: every settings row, with its audit row, atomically.
  const releasedAt = new Date();
  const rows = await db.transaction(async (tx) => {
    const updated = await tx.update(globalTradingSettingsTable)
      .set({
        emergencyKillSwitch: false,
        killSwitchEngagedAt: null,
        killSwitchReason: null,
        updatedByAdminId: args.actor.userId,
        updatedAt: releasedAt,
      })
      .returning();
    if (!updated.length) return null;
    await tx.insert(adminActionAuditLogTable).values({
      adminId: args.actor.userId,
      adminRole: role,
      action: RELEASE_AUDIT_ACTION[args.stop],
      beforeState: { ...beforeState, emergencyKillSwitch: wasEngaged },
      afterState: { emergencyKillSwitch: false, rowCount: updated.length, releasedAt: releasedAt.toISOString() },
      reason,
      ipAddress: args.ipAddress ?? null,
    });
    return [...updated].sort((a, b) => a.id - b.id);
  });
  if (!rows) {
    return { ok: false, stop: args.stop, code: "NO_SETTINGS_ROW", message: "There is no global_trading_settings row to release." };
  }
  logger.warn(
    { stop: args.stop, source: args.source, actorUserId: args.actor.userId, wasEngaged, rowCount: rows.length },
    "platform emergency stop released on every settings row (audited)",
  );
  return { ok: true, stop: args.stop, wasEngaged, releasedAt, rows };
}
