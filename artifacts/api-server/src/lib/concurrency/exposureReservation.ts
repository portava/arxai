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
import { ARX_LOCK_NS, withTxAdvisoryLock, type PoolClient } from "./advisoryLock.js";
import { pool, db, arxDispatchExposureReservationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const pgPool = pool as unknown as { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> };

export type ReservationOutcome =
  | { ok: true; reservationId: number; currentOpenLots: number; reservedLots: number; cap: number | null }
  | { ok: false; reason: "MASTER_ACCOUNT_EXPOSURE_LIMIT_REACHED" | "MASTER_EXPOSURE_LOCKED"; currentOpenLots: number; reservedLots: number; cap: number | null };

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
