// Task #1 — Shared bridge: MT5 is source of truth.
//
// Pool recompute service. Given (or resolving) a master mt5_connection id:
//  1. Reads the live mt5_connection row (heartbeat-driven balance/equity/
//     free/used margin + last heartbeat timestamp).
//  2. Sums user_slot_allocation.allocated_funds + reserved_risk + the
//     live unrealised P/L of every position owned by an allocated user.
//  3. Derives availability = min(balance, equity) - totalAllocated.
//  4. Sets is_over_allocated + allocation_deficit when availability < 0.
//  5. Classifies the heartbeat snapshot as FRESH | STALE | MISSING using
//     the existing 60s admin freshness budget.
//  6. Upserts a single row in arx_master_bridge_pool keyed by
//     master_connection_id. Never inserts more than one row per master.
//
// SAFETY:
// - Pure derived projection. Never mutates user_slot_allocation,
//   arx_live_commands, mt5_connection, or any safety gate.
// - When sharedLivePaused is currently true on the existing row, the
//   recompute PRESERVES that flag (only an explicit admin pause/resume
//   endpoint may flip it).
// - The Prop-Firm hook (allow_over_allocation_prop_firm_mode) is read
//   from arx_master_account_config and currently has no effect — the
//   derived is_over_allocated/allocation_deficit still reflect the real
//   master balance for honesty. The dispatch pre-gate and admin guard
//   are responsible for deciding whether to *block* on the deficit.
//   This separation keeps the projection truthful regardless of mode.

import { and, eq, isNull } from "drizzle-orm";
import { openLiveExposureCondition } from "./livePositionExposure.js";
import { computeAvailableBalance } from "./investorLiveBalance.js";
import {
  db,
  arxMasterAccountConfigTable,
  arxMasterBridgePoolTable,
  arxLivePositionsTable,
  mt5ConnectionTable,
  userSlotAllocationTable,
  type ArxMasterBridgePool,
} from "@workspace/db";

const POOL_SNAPSHOT_FRESH_BUDGET_MS = 60_000;

export type PoolSnapshotStatus = "FRESH" | "STALE" | "MISSING";

export interface PoolRecomputeResult {
  ok: boolean;
  masterConnectionId: number | null;
  pool: ArxMasterBridgePool | null;
  reason?: "MASTER_BRIDGE_NOT_PINNED" | "MASTER_CONNECTION_MISSING";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Resolve the currently active master connection id from
 * arx_master_account_config. Returns null if no active pin row exists.
 * Unlike the admin getMasterContext() helper this does NOT fall through
 * to auto-detection: the pool table is keyed by master_connection_id and
 * we only persist a row for an explicitly pinned master to avoid
 * thrashing the unique row between detector flips.
 */
export async function resolveActiveMasterConnectionId(): Promise<number | null> {
  const cfg = await db.select({
    masterConnectionId: arxMasterAccountConfigTable.masterConnectionId,
  }).from(arxMasterAccountConfigTable)
    .where(eq(arxMasterAccountConfigTable.isActive, true))
    .limit(1);
  return cfg[0]?.masterConnectionId ?? null;
}

/**
 * Recompute and upsert the master bridge pool row.
 *
 * When `masterConnectionId` is omitted, falls back to the active pin row
 * via resolveActiveMasterConnectionId. Returns { ok:false, reason } when
 * no master is pinned or the pinned connection row has been deleted.
 */
export async function recomputeMasterPool(args?: {
  masterConnectionId?: number;
}): Promise<PoolRecomputeResult> {
  const resolvedId = args?.masterConnectionId ?? (await resolveActiveMasterConnectionId());
  if (resolvedId == null) {
    return { ok: false, masterConnectionId: null, pool: null, reason: "MASTER_BRIDGE_NOT_PINNED" };
  }

  const connRows = await db.select().from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.id, resolvedId)).limit(1);
  const conn = connRows[0];
  if (!conn) {
    return { ok: false, masterConnectionId: resolvedId, pool: null, reason: "MASTER_CONNECTION_MISSING" };
  }

  const mt5Balance = Number(conn.accountBalance ?? 0);
  const mt5Equity = Number(conn.accountEquity ?? 0);
  const mt5FreeMargin = Number(conn.freeMargin ?? 0);
  const mt5UsedMargin = Number(conn.margin ?? 0);
  const lastMt5SnapshotAt = conn.lastHeartbeat ? new Date(conn.lastHeartbeat) : null;
  const snapshotAgeMs = lastMt5SnapshotAt ? Date.now() - lastMt5SnapshotAt.getTime() : null;
  const snapshotStatus: PoolSnapshotStatus =
    snapshotAgeMs == null ? "MISSING"
      : snapshotAgeMs > POOL_SNAPSHOT_FRESH_BUDGET_MS ? "STALE"
        : "FRESH";

  // Sum allocations + reserved risk across every user_slot_allocation
  // row regardless of active flag. A deactivated row whose allocatedFunds
  // were not zeroed must still count against the master balance — the
  // funds are still notionally committed until an admin sets them to 0.
  const allocRows = await db.select({
    userId: userSlotAllocationTable.userId,
    allocatedFunds: userSlotAllocationTable.allocatedFunds,
    reservedRisk: userSlotAllocationTable.reservedRisk,
  }).from(userSlotAllocationTable);

  const totalAllocated = allocRows.reduce((s, r) => s + Number(r.allocatedFunds ?? 0), 0);
  const totalReservedRisk = allocRows.reduce((s, r) => s + Number(r.reservedRisk ?? 0), 0);

  // Sum unrealised P/L across allocated users only — restricting by
  // userId set ensures unallocated bridge tenants (legacy rows) can't
  // distort the pool's user-side P/L bucket.
  const allocUserIds = new Set(allocRows.map((r) => r.userId));
  let totalUserUnrealizedPnl = 0;
  if (allocUserIds.size > 0) {
    // Open exposure only — closed AND reconciled ghosts excluded via the shared
    // truth predicate so they can never inflate unrealized P/L or flip
    // is_over_allocated.
    const openPositions = await db.select({
      userId: arxLivePositionsTable.userId,
      floatingPl: arxLivePositionsTable.floatingPl,
    }).from(arxLivePositionsTable).where(openLiveExposureCondition());
    for (const p of openPositions) {
      if (allocUserIds.has(p.userId)) {
        totalUserUnrealizedPnl += Number(p.floatingPl ?? 0);
      }
    }
  }

  // Strict Real-Balance Mode: availability = min(balance, equity) - totalAllocated.
  // We use min() so a temporarily depressed equity (open floating loss)
  // tightens the pool the same way a cash drain would.
  const availableFunds = Math.min(mt5Balance, mt5Equity) - totalAllocated;
  const isOverAllocated = availableFunds < 0;
  const allocationDeficit = isOverAllocated ? Math.abs(availableFunds) : 0;

  const now = new Date();

  // Upsert. Preserve sharedLivePaused / pausedReason / pausedAt /
  // pausedByUserId from any existing row — only the admin pause/resume
  // endpoints may flip them.
  const existingRows = await db.select().from(arxMasterBridgePoolTable)
    .where(eq(arxMasterBridgePoolTable.masterConnectionId, resolvedId)).limit(1);
  const existing = existingRows[0];

  const baseValues = {
    masterConnectionId: resolvedId,
    mt5Balance: round2(mt5Balance),
    mt5Equity: round2(mt5Equity),
    mt5FreeMargin: round2(mt5FreeMargin),
    mt5UsedMargin: round2(mt5UsedMargin),
    accountCurrency: conn.accountCurrency ?? null,
    totalAllocated: round2(totalAllocated),
    totalReservedRisk: round2(totalReservedRisk),
    totalUserUnrealizedPnl: round2(totalUserUnrealizedPnl),
    allocationDeficit: round2(allocationDeficit),
    isOverAllocated,
    lastMt5SnapshotAt,
    snapshotAgeMs,
    snapshotStatus,
    recomputedAt: now,
  };

  let pool: ArxMasterBridgePool;
  if (existing) {
    const [updated] = await db.update(arxMasterBridgePoolTable)
      .set(baseValues)
      .where(eq(arxMasterBridgePoolTable.id, existing.id))
      .returning();
    pool = updated!;
  } else {
    const [inserted] = await db.insert(arxMasterBridgePoolTable).values({
      ...baseValues,
      sharedLivePaused: false,
      pausedReason: null,
      pausedAt: null,
      pausedByUserId: null,
    }).returning();
    pool = inserted!;
  }

  return { ok: true, masterConnectionId: resolvedId, pool };
}

/**
 * Read-only loader. Returns the current pool row WITHOUT recomputing.
 * Returns null when no master is pinned or no pool row exists yet.
 */
export async function loadMasterPool(): Promise<ArxMasterBridgePool | null> {
  const id = await resolveActiveMasterConnectionId();
  if (id == null) return null;
  const rows = await db.select().from(arxMasterBridgePoolTable)
    .where(eq(arxMasterBridgePoolTable.masterConnectionId, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Load a single user's per-allocation view, paired with the current pool
 * row. Used by the user-facing Live Shared access endpoint. Never
 * returns other users' figures.
 */
export async function getUserAllocationView(userId: number): Promise<{
  pool: ArxMasterBridgePool | null;
  assignedAllocation: number;
  reservedRisk: number;
  availableAllocation: number;
  // Sum of this user's OWN open floating losses (always <= 0). Surfaced so
  // display + blocker copy can show an honest "assigned − reserved − floating
  // loss" breakdown instead of an unexplained 0. Never includes other users'.
  openFloatingLoss: number;
  // True only when a user_slot_allocation row exists AND assigns > 0. Lets
  // every surface distinguish "no allocation has been assigned to you yet"
  // (missing) from "your allocation is fully consumed" (confirmed-zero) —
  // both still block live dispatch, but they need different honest copy.
  hasAllocation: boolean;
  bridgeAvailability: "HEALTHY" | "RECONCILING" | "UNAVAILABLE";
  bridgeMessage: string;
}> {
  const pool = await loadMasterPool();
  const allocRows = await db.select({
    allocatedFunds: userSlotAllocationTable.allocatedFunds,
    reservedRisk: userSlotAllocationTable.reservedRisk,
  }).from(userSlotAllocationTable)
    .where(eq(userSlotAllocationTable.userId, userId)).limit(1);
  const alloc = allocRows[0];
  const assignedAllocation = round2(Number(alloc?.allocatedFunds ?? 0));
  const reservedRisk = round2(Number(alloc?.reservedRisk ?? 0));
  const hasAllocation = alloc != null && assignedAllocation > 0;
  // Subtract user's own open floating losses from headroom so a drawdown
  // shrinks the "available to trade" figure the user sees.
  // Open exposure only (shared truth predicate) — reconciled / orphan-resolved
  // rows must never shrink the user's available allocation.
  const openRows = await db.select({
    floatingPl: arxLivePositionsTable.floatingPl,
  }).from(arxLivePositionsTable).where(openLiveExposureCondition(userId));
  const openFloatingLoss = openRows.reduce(
    (s, r) => s + Math.min(0, Number(r.floatingPl ?? 0)),
    0,
  );
  // Shared formula with the canonical investor balance composer so the wallet
  // "available to trade" can never drift from the balance surfaces (Task #430).
  const availableAllocation = computeAvailableBalance(
    assignedAllocation,
    reservedRisk,
    openFloatingLoss,
  );

  let bridgeAvailability: "HEALTHY" | "RECONCILING" | "UNAVAILABLE" = "UNAVAILABLE";
  let bridgeMessage = "Live bridge is not currently available.";
  if (pool) {
    if (pool.sharedLivePaused) {
      bridgeAvailability = "UNAVAILABLE";
      bridgeMessage = "Live bridge is paused for reconciliation.";
    } else if (pool.snapshotStatus === "MISSING") {
      bridgeAvailability = "UNAVAILABLE";
      bridgeMessage = "Live bridge is offline.";
    } else if (pool.snapshotStatus === "STALE") {
      bridgeAvailability = "RECONCILING";
      bridgeMessage = "Live bridge snapshot is reconciling — please retry shortly.";
    } else if (pool.isOverAllocated) {
      bridgeAvailability = "RECONCILING";
      bridgeMessage = "Live bridge allocation is temporarily unavailable while the master balance is being reconciled.";
    } else {
      bridgeAvailability = "HEALTHY";
      bridgeMessage = "Live bridge is healthy.";
    }
  }

  return {
    pool, assignedAllocation, reservedRisk, availableAllocation,
    openFloatingLoss: round2(openFloatingLoss), hasAllocation,
    bridgeAvailability, bridgeMessage,
  };
}

/**
 * Compute and persist per-allocation reserved-risk. Currently a thin
 * wrapper that uses 0 (no per-position margin model yet); kept as the
 * single mutation surface so a future margin model only needs to land
 * here. Updates user_slot_allocation.reserved_risk + last_reconciled_at.
 */
export async function reconcileAllocationsReservedRisk(): Promise<{ updated: number }> {
  const allocRows = await db.select({
    id: userSlotAllocationTable.id,
    userId: userSlotAllocationTable.userId,
  }).from(userSlotAllocationTable);
  const now = new Date();
  let updated = 0;
  for (const a of allocRows) {
    // Sum margin held against open positions for this user. With no
    // per-position margin column yet, this is 0 — but writing the row
    // keeps last_reconciled_at honest.
    const reserved = 0;
    await db.update(userSlotAllocationTable).set({
      reservedRisk: reserved,
      lastReconciledAt: now,
      updatedAt: now,
    }).where(eq(userSlotAllocationTable.id, a.id));
    updated += 1;
  }
  return { updated };
}
