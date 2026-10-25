// The shared-live pause authority (Tier 1 Platform Safety, round 5, owner
// decision 19).
//
// "Is shared-live paused for this pool, and who may pause or resume it" is a
// Platform Safety decision. Broker Hub keeps the broker facts the pool row
// mirrors (balance, equity, margin, snapshot freshness), and the LIVE pool
// recompute (lib/live/masterBridgePool.ts) keeps writing those facts and
// preserves the pause columns it does not own. Only this file writes the pause
// columns (shared_live_paused, paused_reason, paused_at, paused_by_user_id),
// and every reader of the flag interprets the row through sharedLivePauseOf().
//
// Scope: one shared-master pool row (arx_master_bridge_pool.id). The pause is
// never install-wide. It does not touch global_trading_settings, the safety
// core, the operator live arm or any other pool row; the install-wide stops
// stay with ./platformStopWriter.ts. A per-allocation stop is the
// allocation's own freeze (user_slot_allocation.trading_frozen), which this
// decision does not move.
//
//   pauseSharedLive()   operator-only, reason required; sets the flag, reason,
//                       time and actor on the ONE scoped row and writes the
//                       audit row (SHARED_LIVE_PAUSED_OVER_ALLOCATION) in the
//                       same transaction. Re-pausing refreshes reason/time/actor.
//   resumeSharedLive()  operator-only; clears the flag and its reason/time/actor
//                       on the ONE scoped row and writes SHARED_LIVE_RESUMED in
//                       the same transaction. Resuming never arms or opens
//                       anything else.
//
// Pausing stops new shared-live entries at the dispatch pre-gate
// (lib/live/liveCommandPipeline.ts) and new allocations; it never closes a
// position, and closes / modifies keep flowing.
//
// check-single-safety-switch-source (rule 11) fails the build when another
// runtime file reads or writes the flag itself.

import { eq } from "drizzle-orm";
import { db, arxMasterBridgePoolTable, adminActionAuditLogTable, type ArxMasterBridgePool } from "@workspace/db";
import { operatorRoleFromSession } from "../security/adminRoleGate.js";

/** One shared-master pool row. The only scope a shared-live pause has. */
export interface SharedLivePauseScope {
  poolId: number;
}

export interface SharedLivePauseState {
  scope: SharedLivePauseScope;
  paused: boolean;
  reason: string | null;
  pausedAt: Date | null;
  pausedByUserId: number | null;
}

type PauseColumns = Pick<ArxMasterBridgePool, "id" | "sharedLivePaused" | "pausedReason" | "pausedAt" | "pausedByUserId">;

/**
 * The pause decision for one pool row the caller already loaded (pure). Every
 * reader of the flag goes through here, so "paused" means the same thing on the
 * dispatch pre-gate, the allocation pre-check and the bridge views.
 */
export function sharedLivePauseOf(pool: PauseColumns): SharedLivePauseState {
  return {
    scope: { poolId: pool.id },
    paused: pool.sharedLivePaused === true,
    reason: pool.pausedReason ?? null,
    pausedAt: pool.pausedAt ?? null,
    pausedByUserId: pool.pausedByUserId ?? null,
  };
}

export interface SharedLivePauseActor {
  userId: number;
  /** Session role; only ADMIN / OWNER may pause or resume. */
  role: string | null | undefined;
}

export type SharedLivePauseRefusal = "NOT_AUTHORIZED" | "REASON_REQUIRED" | "POOL_NOT_FOUND";

export type SharedLivePauseResult =
  | { ok: true; scope: SharedLivePauseScope; before: SharedLivePauseState; pool: ArxMasterBridgePool }
  | { ok: false; scope: SharedLivePauseScope; code: SharedLivePauseRefusal; message: string };

export interface PauseSharedLiveArgs {
  scope: SharedLivePauseScope;
  reason: string;
  actor: SharedLivePauseActor;
  ipAddress?: string | null;
}

export interface ResumeSharedLiveArgs {
  scope: SharedLivePauseScope;
  actor: SharedLivePauseActor;
  reason?: string | null;
  ipAddress?: string | null;
}

const PAUSE_ACTION = "SHARED_LIVE_PAUSED_OVER_ALLOCATION";
const RESUME_ACTION = "SHARED_LIVE_RESUMED";

/** Pause shared-live for one pool: operator-only, reason required, audited in the same transaction. */
export async function pauseSharedLive(args: PauseSharedLiveArgs): Promise<SharedLivePauseResult> {
  const scope = { poolId: args.scope.poolId };
  const role = operatorRoleFromSession(args.actor.role);
  if (!role) return { ok: false, scope, code: "NOT_AUTHORIZED", message: "Only an ADMIN or OWNER may pause shared-live trading." };
  const reason = String(args.reason ?? "").trim();
  if (!reason) return { ok: false, scope, code: "REASON_REQUIRED", message: "A reason is required to pause shared-live trading." };

  return db.transaction(async (tx): Promise<SharedLivePauseResult> => {
    const [row] = await tx.select().from(arxMasterBridgePoolTable)
      .where(eq(arxMasterBridgePoolTable.id, scope.poolId)).for("update");
    if (!row) return { ok: false, scope, code: "POOL_NOT_FOUND", message: "No shared-master pool row has this id." };
    const before = sharedLivePauseOf(row);
    const [pool] = await tx.update(arxMasterBridgePoolTable).set({
      sharedLivePaused: true,
      pausedReason: reason,
      pausedAt: new Date(),
      pausedByUserId: args.actor.userId,
    }).where(eq(arxMasterBridgePoolTable.id, scope.poolId)).returning();
    await tx.insert(adminActionAuditLogTable).values({
      adminId: args.actor.userId,
      adminRole: role,
      action: PAUSE_ACTION,
      targetUserId: null,
      beforeState: { sharedLivePaused: before.paused },
      afterState: { sharedLivePaused: true, pausedReason: reason, poolId: scope.poolId },
      reason,
      ipAddress: args.ipAddress ?? null,
    });
    return { ok: true, scope, before, pool: pool! };
  });
}

/** Resume shared-live for one pool: operator-only, audited in the same transaction. */
export async function resumeSharedLive(args: ResumeSharedLiveArgs): Promise<SharedLivePauseResult> {
  const scope = { poolId: args.scope.poolId };
  const role = operatorRoleFromSession(args.actor.role);
  if (!role) return { ok: false, scope, code: "NOT_AUTHORIZED", message: "Only an ADMIN or OWNER may resume shared-live trading." };
  const reason = args.reason == null ? null : String(args.reason).trim() || null;

  return db.transaction(async (tx): Promise<SharedLivePauseResult> => {
    const [row] = await tx.select().from(arxMasterBridgePoolTable)
      .where(eq(arxMasterBridgePoolTable.id, scope.poolId)).for("update");
    if (!row) return { ok: false, scope, code: "POOL_NOT_FOUND", message: "No shared-master pool row has this id." };
    const before = sharedLivePauseOf(row);
    const [pool] = await tx.update(arxMasterBridgePoolTable).set({
      sharedLivePaused: false,
      pausedReason: null,
      pausedAt: null,
      pausedByUserId: null,
    }).where(eq(arxMasterBridgePoolTable.id, scope.poolId)).returning();
    await tx.insert(adminActionAuditLogTable).values({
      adminId: args.actor.userId,
      adminRole: role,
      action: RESUME_ACTION,
      targetUserId: null,
      beforeState: { sharedLivePaused: before.paused, pausedReason: before.reason },
      afterState: { sharedLivePaused: false, poolId: scope.poolId },
      reason,
      ipAddress: args.ipAddress ?? null,
    });
    return { ok: true, scope, before, pool: pool! };
  });
}
