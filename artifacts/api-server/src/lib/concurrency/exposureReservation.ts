// Atomic master-account exposure reservation.
//
// The classic race: two SHARED_MASTER_MT5 submissions both read
// `currentOpenLots = X`, both compute `X + addingLot <= cap`, both
// proceed, and the master account ends up over-exposed.
//
// Fix:
//
//   1. Hold an advisory lock keyed by sharedMasterAccountId.
//   2. SUM open lots from shared_trade_attribution (pending|open) PLUS
//      lots from arx_dispatch_exposure_reservations (RESERVED).
//   3. If sum + addingLot > cap → refuse (and release lock).
//   4. Else INSERT a RESERVED row inside the lock; COMMIT releases the
//      lock and the next submission can run.
//
// `releaseReservation` flips RESERVED → RELEASED on dispatch failure
// (the row is kept for audit). `fulfillReservation` flips RESERVED →
// FULFILLED when the broker confirms a fill; the row remains in the
// aggregation source until the underlying attribution closes the trade.
import { ARX_LOCK_NS, withTxAdvisoryLock, type ArxLockNamespace, type PoolClient } from "./advisoryLock.js";
import { pool, db, arxDispatchExposureReservationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../logger.js";
import {
  RESERVED_RISK_IN_FLIGHT_STATUSES,
  RESERVED_RISK_ENTRY_COMMAND_TYPES,
} from "../live/masterBridgePool.js";

const pgPool = pool as unknown as { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> };

// R3 slice 3 — cap-semantics trap notice (startup, once). shared_master_accounts.
// max_total_exposure_lots DEFAULTS TO 0, and 0/NULL both mean UNLIMITED in the
// cap check below (`cap !== null && cap > 0`), matching the column's own schema
// comment ("0 / NULL = unlimited — not recommended in production"). This wave
// deliberately does NOT flip 0 to mean "a real cap of zero": every
// default-created master row carries 0, so a silent flip would refuse ALL
// shared-master dispatch. There is no boolean column marking "unlimited was
// chosen on purpose", so the trap stays and is named loudly here. Whether 0
// should become a hard zero-cap (with NULL as the only unlimited marker) is an
// OWNER decision — record it in the Owner Decision Registry
// (docs/OWNER_DECISIONS.md) before changing the predicate.
logger.warn({
  event: "MASTER_EXPOSURE_CAP_ZERO_MEANS_UNLIMITED",
  column: "shared_master_accounts.max_total_exposure_lots",
}, "master-exposure cap semantics: 0 (the column DEFAULT) and NULL both mean UNLIMITED total exposure — set a positive lot cap on the active shared master account for production; flipping 0 to a real zero-cap is an Owner Decision Registry call");

// R3 slice 3 — advisory-lock namespace for the per-user allocation-headroom
// reservation (keyB = userId). NOTE: the canonical ARX_LOCK_NS registry lives
// in advisoryLock.ts, which is coordinator-owned this wave — this value is
// reserved HERE, adjacent in sequence to the existing 0x4152_58xx namespaces,
// and must be folded into ARX_LOCK_NS verbatim when that file opens
// (registration reported to the coordinator). Deliberately NOT USER_SUBMIT:
// the one-click route already holds USER_SUBMIT(userId) around the whole
// submit — re-acquiring it from a second pooled connection inside dispatch
// would self-deadlock into a spurious refusal.
import { ARX_LOCK_NS } from "./advisoryLock.js";
// Registry-owned namespace: the single definition lives in ARX_LOCK_NS.
export const ARX_LOCK_NS_USER_ALLOCATION: number = ARX_LOCK_NS.USER_ALLOCATION;

/** Snapshot of the per-user headroom inputs read INSIDE the user lock —
 *  returned on refusal so the LIVE_BLOCKED audit shows the exact arithmetic. */
export interface UserHeadroomSnapshot {
  allocatedFunds: number;
  /** In-flight ENTRY exposure (commands + reservation-gap rows) × margin proxy. */
  reservedRiskUsd: number;
  /** Sum of this user's open floating LOSSES (≤ 0). */
  openFloatingLossUsd: number;
  estRequiredMarginUsd: number;
}

export type ReservationOutcome =
  | { ok: true; reservationId: number; currentOpenLots: number; reservedLots: number; cap: number | null }
  | {
      ok: false;
      reason:
        | "MASTER_ACCOUNT_EXPOSURE_LIMIT_REACHED"
        | "MASTER_EXPOSURE_LOCKED"
        // R3 slice 3 — per-user headroom refusals (advisory lock keyed by userId).
        | "USER_ALLOCATION_EXHAUSTED"
        | "USER_ALLOCATION_LOCKED";
      currentOpenLots: number;
      reservedLots: number;
      cap: number | null;
      /** Present only on the per-user headroom refusals. */
      userHeadroom?: UserHeadroomSnapshot;
    };

/** Sum committed (pending|open) + currently RESERVED lots for a master. */
async function sumExposure(
  client: PoolClient,
  sharedMasterAccountId: number,
): Promise<{ openLots: number; reservedLots: number; cap: number | null }> {
  const a = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(lot_size), 0) AS total
       FROM shared_trade_attribution
      WHERE shared_master_account_id = $1
        AND status IN ('pending','open')`,
    [sharedMasterAccountId],
  );
  const b = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(lot_size), 0) AS total
       FROM arx_dispatch_exposure_reservations
      WHERE shared_master_account_id = $1
        AND status = 'RESERVED'`,
    [sharedMasterAccountId],
  );
  const c = await client.query<{ cap: number | null }>(
    `SELECT max_total_exposure_lots AS cap
       FROM shared_master_accounts
      WHERE id = $1
      LIMIT 1`,
    [sharedMasterAccountId],
  );
  return {
    openLots: Number(a.rows[0]?.total ?? 0),
    reservedLots: Number(b.rows[0]?.total ?? 0),
    cap: c.rows[0]?.cap ?? null,
  };
}

export async function reserveExposureAtomic(args: {
  sharedMasterAccountId: number;
  addingLot: number;
  userId: number;
  commandId: string;
  symbol: string;
}): Promise<ReservationOutcome> {
  const lock = await withTxAdvisoryLock(
    ARX_LOCK_NS.MASTER_EXPOSURE,
    args.sharedMasterAccountId,
    async (client) => {
      const { openLots, reservedLots, cap } =
        await sumExposure(client, args.sharedMasterAccountId);
      const total = openLots + reservedLots + args.addingLot;
      if (cap !== null && cap > 0 && total > cap) {
        return { blocked: true as const, openLots, reservedLots, cap };
      }
      const ins = await client.query<{ id: number }>(
        `INSERT INTO arx_dispatch_exposure_reservations
           (user_id, command_id, shared_master_account_id, symbol, lot_size, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'RESERVED', NOW(), NOW())
         RETURNING id`,
        [args.userId, args.commandId, args.sharedMasterAccountId, args.symbol, args.addingLot],
      );
      return {
        blocked: false as const,
        reservationId: ins.rows[0]!.id,
        openLots, reservedLots, cap,
      };
    },
  );
  if (!lock.acquired) {
    return {
      ok: false, reason: "MASTER_EXPOSURE_LOCKED",
      currentOpenLots: 0, reservedLots: 0, cap: null,
    };
  }
  if (lock.value.blocked) {
    return {
      ok: false, reason: "MASTER_ACCOUNT_EXPOSURE_LIMIT_REACHED",
      currentOpenLots: lock.value.openLots,
      reservedLots: lock.value.reservedLots,
      cap: lock.value.cap,
    };
  }
  return {
    ok: true,
    reservationId: lock.value.reservationId,
    currentOpenLots: lock.value.openLots,
    reservedLots: lock.value.reservedLots,
    cap: lock.value.cap,
  };
}

/**
 * R3 slice 3 — PURE per-user headroom decision (offline-testable).
 * TRUE = refuse the reservation.
 *
 * Formula parity: available = max(0, allocated − reservedRisk + floatingLoss)
 * — the EXACT computeAvailableBalance composition (lib/live/
 * investorLiveBalance.ts) the preflight's getUserAllocationView uses, so the
 * locked dispatch-time check and the user-visible wallet figure can never
 * disagree on the arithmetic (parity is pinned by wave5Seam.test.ts rather
 * than by an import, keeping concurrency/ decoupled from the live/ graph).
 *
 * Fail-closed: any non-finite input, or a negative required margin, refuses —
 * corrupt data must never create capacity. openFloatingLossUsd is clamped to
 * ≤ 0 (it is a loss sum by construction; a positive value would inflate
 * headroom).
 */
export function userHeadroomBlocksReservation(s: {
  allocatedFunds: number;
  reservedRiskUsd: number;
  openFloatingLossUsd: number;
  estRequiredMarginUsd: number;
}): boolean {
  const vals = [s.allocatedFunds, s.reservedRiskUsd, s.openFloatingLossUsd, s.estRequiredMarginUsd];
  if (vals.some((v) => typeof v !== "number" || !Number.isFinite(v))) return true;
  if (s.estRequiredMarginUsd < 0) return true;
  const available = Math.max(
    0,
    s.allocatedFunds - s.reservedRiskUsd + Math.min(0, s.openFloatingLossUsd),
  );
  return s.estRequiredMarginUsd > available;
}

/**
 * R3 slice 3 — reservation with the per-user allocation headroom re-derived
 * and checked ATOMICALLY (audit: the preflight headroom check ran unlocked
 * against a reserved_risk column the reconciler stub hard-coded to 0, so two
 * parallel same-user dispatches could both pass it).
 *
 * Lock discipline (mirrors the master-pool pattern in this file; same
 * withTxAdvisoryLock helper):
 *
 *   1. pg advisory lock keyed by userId (ARX_LOCK_NS_USER_ALLOCATION) —
 *      non-blocking; a concurrent same-user dispatch gets
 *      USER_ALLOCATION_LOCKED instead of a silent double-pass.
 *   2. INSIDE that lock: read allocated funds, LIVE in-flight ENTRY exposure
 *      (SENT_TO_MT5_LIVE / LIVE_UNKNOWN / LIVE_RECONCILIATION_REQUIRED
 *      commands, PLUS still-RESERVED reservation rows whose command has not
 *      yet reached an in-flight status — the reserve-committed-but-not-yet-
 *      SENT gap), and open floating losses. Refuse via the pure predicate.
 *   3. Still inside the user lock, take the UNCHANGED master-exposure
 *      advisory-locked reservation (reserveExposureAtomic). Lock order is
 *      always USER_ALLOCATION → MASTER_EXPOSURE, and both are try-locks, so
 *      no blocking-lock deadlock is possible; the reservation row commits
 *      with the inner (master) transaction, i.e. BEFORE the user lock
 *      releases — the next same-user dispatch always sees it.
 *
 * Scope choices (constraint comments):
 *   - ENTRY commands only feed reservedRiskUsd: an in-flight CLOSE/MODIFY is
 *     risk-reducing intent; counting its lots as reserved margin would shrink
 *     entry headroom AND double-count against the open position's floating
 *     loss. Vocabulary is shared with masterBridgePool's reserved-risk
 *     reconciler (RESERVED_RISK_* consts) so the two can never drift.
 *   - `userHeadroom: null` skips the headroom leg AND the user lock entirely
 *     and delegates to reserveExposureAtomic unchanged (byte-equivalent path)
 *     — used for close/modify and for the governance-skip the preflight
 *     margin proxy already honours (enforceMarginProxy split).
 */
export async function reserveExposureAtomicWithUserHeadroom(args: {
  sharedMasterAccountId: number;
  addingLot: number;
  userId: number;
  commandId: string;
  symbol: string;
  userHeadroom: null | {
    estRequiredMarginUsd: number;
    marginProxyPerLotUsd: number;
  };
}): Promise<ReservationOutcome> {
  if (args.userHeadroom == null) {
    return reserveExposureAtomic(args);
  }
  const { estRequiredMarginUsd, marginProxyPerLotUsd } = args.userHeadroom;
  const inFlightStatuses = [...RESERVED_RISK_IN_FLIGHT_STATUSES];
  const entryTypes = [...RESERVED_RISK_ENTRY_COMMAND_TYPES];
  const lock = await withTxAdvisoryLock(
    // Cast-only until the coordinator folds the namespace into ARX_LOCK_NS
    // (advisoryLock.ts is out of scope this wave — see the const's comment).
    ARX_LOCK_NS_USER_ALLOCATION as ArxLockNamespace,
    args.userId,
    async (client) => {
      const alloc = await client.query<{ allocated: string | number | null }>(
        `SELECT COALESCE(allocated_funds, 0) AS allocated
           FROM user_slot_allocation
          WHERE user_id = $1
          LIMIT 1`,
        [args.userId],
      );
      const inflight = await client.query<{ lots: string | number | null }>(
        `SELECT COALESCE(SUM(requested_volume), 0) AS lots
           FROM arx_live_commands
          WHERE user_id = $1
            AND status = ANY($2)
            AND command_type = ANY($3)`,
        [args.userId, inFlightStatuses, entryTypes],
      );
      // Reserve-committed-but-not-yet-SENT gap: RESERVED reservation rows for
      // ENTRY commands still outside the in-flight statuses (mid-dispatch).
      const gap = await client.query<{ lots: string | number | null }>(
        `SELECT COALESCE(SUM(r.lot_size), 0) AS lots
           FROM arx_dispatch_exposure_reservations r
           JOIN arx_live_commands c ON c.command_id = r.command_id
          WHERE r.user_id = $1
            AND r.status = 'RESERVED'
            AND c.command_type = ANY($2)
            AND NOT (c.status = ANY($3))`,
        [args.userId, entryTypes, inFlightStatuses],
      );
      const loss = await client.query<{ loss: string | number | null }>(
        // Open-exposure predicate parity with openLiveExposureCondition
        // (lib/live/livePositionExposure.ts): closed_at IS NULL AND
        // reconcile_state IS NULL — a reconciled ghost must never shrink
        // headroom. LEAST(pl, 0) keeps only losses.
        `SELECT COALESCE(SUM(LEAST(floating_pl, 0)), 0) AS loss
           FROM arx_live_positions
          WHERE user_id = $1
            AND closed_at IS NULL
            AND reconcile_state IS NULL`,
        [args.userId],
      );
      const snapshot: UserHeadroomSnapshot = {
        allocatedFunds: Number(alloc.rows[0]?.allocated ?? 0),
        reservedRiskUsd:
          (Number(inflight.rows[0]?.lots ?? 0) + Number(gap.rows[0]?.lots ?? 0))
          * marginProxyPerLotUsd,
        openFloatingLossUsd: Number(loss.rows[0]?.loss ?? 0),
        estRequiredMarginUsd,
      };
      if (userHeadroomBlocksReservation(snapshot)) {
        return { blocked: true as const, snapshot };
      }
      // Master-exposure reservation, unchanged, on its own pooled connection
      // (try-lock — never blocks while we hold the user lock).
      const master = await reserveExposureAtomic({
        sharedMasterAccountId: args.sharedMasterAccountId,
        addingLot: args.addingLot,
        userId: args.userId,
        commandId: args.commandId,
        symbol: args.symbol,
      });
      return { blocked: false as const, master };
    },
  );
  if (!lock.acquired) {
    return {
      ok: false, reason: "USER_ALLOCATION_LOCKED",
      currentOpenLots: 0, reservedLots: 0, cap: null,
    };
  }
  if (lock.value.blocked) {
    return {
      ok: false, reason: "USER_ALLOCATION_EXHAUSTED",
      currentOpenLots: 0, reservedLots: 0, cap: null,
      userHeadroom: lock.value.snapshot,
    };
  }
  return lock.value.master;
}

export async function releaseReservation(reservationId: number): Promise<void> {
  await db.update(arxDispatchExposureReservationsTable)
    .set({ status: "RELEASED", updatedAt: new Date() })
    .where(eq(arxDispatchExposureReservationsTable.id, reservationId));
}

export async function fulfillReservation(reservationId: number): Promise<void> {
  await db.update(arxDispatchExposureReservationsTable)
    .set({ status: "FULFILLED", updatedAt: new Date() })
    .where(eq(arxDispatchExposureReservationsTable.id, reservationId));
}

/**
 * Lookup-by-commandId variants. Used from the live result/cancel paths
 * where the only stable handle we hold is the command id — and where
 * failing to settle the reservation would leak open exposure forever.
 *
 * Both functions only act on rows still in `RESERVED`. Re-settling an
 * already-settled row is a no-op (idempotent) so duplicate EA result
 * callbacks cannot flip a FULFILLED row back to RELEASED, or vice versa.
 */
export async function releaseReservationByCommandId(commandId: string): Promise<void> {
  await pgPool.query(
    `UPDATE arx_dispatch_exposure_reservations
        SET status='RELEASED', updated_at=NOW()
      WHERE command_id=$1 AND status='RESERVED'`,
    [commandId],
  );
}

export async function fulfillReservationByCommandId(commandId: string): Promise<void> {
  await pgPool.query(
    `UPDATE arx_dispatch_exposure_reservations
        SET status='FULFILLED', updated_at=NOW()
      WHERE command_id=$1 AND status='RESERVED'`,
    [commandId],
  );
}

/** Test-only helper — release every RESERVED row for a master. */
export async function __releaseAllReservationsForMasterTesting(
  sharedMasterAccountId: number,
): Promise<void> {
  await pgPool.query(
    `UPDATE arx_dispatch_exposure_reservations
        SET status='RELEASED', updated_at=NOW()
      WHERE shared_master_account_id=$1 AND status='RESERVED'`,
    [sharedMasterAccountId],
  );
}
