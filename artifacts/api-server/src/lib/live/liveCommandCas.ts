// P0-1 — Live command state-transition compare-and-set (CAS).
//
// WHY THIS MODULE EXISTS
//
// `dispatchLiveCommand` (liveCommandPipeline.ts) READS the command row,
// evaluates all 18 Phase B gates, and only THEN writes the row to
// SENT_TO_MT5_LIVE. That read-then-write is a TOCTOU window. Two concurrent
// dispatches of the SAME LIVE_APPROVED command — a double-tap, a retried
// fetch, two browser tabs, Ruby racing a manual click — both read
// status=LIVE_APPROVED, both pass all 23 gates (every gate is a property of
// the user/bridge/symbol, not of "has this command already been sent"), and
// both reach the write.
//
// If that write matches on `command_id` ALONE, BOTH succeed. Each caller then
// mirrors an order into the `mt5_commands` mailbox the EA polls, and the
// broker executes the same trade TWICE. Real money, real position, no error
// surfaced anywhere.
//
// The `arx_live_commands_idem_active_uq` partial unique index CANNOT catch
// this. That index constrains INSERTs of *distinct* rows sharing an
// idempotencyKey; this race UPDATEs *one* row twice, so the index is never
// consulted. Only a status predicate on the UPDATE closes it.
//
// THE FIX: make each transition a compare-and-set. `UPDATE ... WHERE
// command_id = $1 AND status = <expected>` is atomic in Postgres — of N
// concurrent statements exactly one matches a row and returns it; the rest
// match zero rows and return nothing. The caller that gets nothing back LOST
// the race and MUST refuse without side effects (no EA mirror, no audit
// "SENT", no exposure attribution).
//
// This is the same idiom `sweepExpiredLiveCommands` already uses to stop the
// TTL sweep racing an EA pickup; dispatch and confirm simply never got it.
//
// SAFETY:
// - This module NEVER decides whether a dispatch is allowed. It runs strictly
//   AFTER the 23-gate evaluator has returned PASS. It cannot weaken, reorder,
//   or skip a gate — it can only refuse a transition that already raced.
// - Losing the CAS is fail-CLOSED: no order is mirrored.
// - Read/writes are keyed by commandId; ownership (userId) is enforced by the
//   caller's `loadOwned()` before any of this runs.

import { and, eq } from "drizzle-orm";
import { db, arxLiveCommandsTable, type ArxLiveCommand } from "@workspace/db";

/**
 * Typed refusal — a concurrent dispatcher already moved this command out of
 * LIVE_APPROVED, so this caller must NOT mirror an EA order. Surfaced to the
 * route layer instead of a success result.
 */
export const LIVE_DISPATCH_RACE_LOST = "LIVE_DISPATCH_RACE_LOST" as const;

/**
 * Typed refusal — a concurrent confirmer already moved this command out of
 * LIVE_CONFIRMATION_REQUIRED.
 */
export const LIVE_CONFIRM_RACE_LOST = "LIVE_CONFIRM_RACE_LOST" as const;

/** Columns a transition is allowed to stamp. */
type LiveCommandPatch = Partial<typeof arxLiveCommandsTable.$inferInsert>;

/**
 * Atomically claim `commandId` for dispatch.
 *
 * Applies `patch` ONLY if the row is still `LIVE_APPROVED`. Returns the
 * updated row on a win, or `null` when the CAS matched zero rows — meaning a
 * concurrent dispatcher already claimed it. A `null` return MUST be treated as
 * a refusal: do not enqueue the EA mirror.
 */
export async function claimLiveCommandForDispatch(
  commandId: string,
  patch: LiveCommandPatch,
): Promise<ArxLiveCommand | null> {
  const rows = await db.update(arxLiveCommandsTable)
    .set(patch)
    .where(and(
      eq(arxLiveCommandsTable.commandId, commandId),
      eq(arxLiveCommandsTable.status, "LIVE_APPROVED"),
    ))
    .returning();
  return rows[0] ?? null;
}

/**
 * Atomically claim `commandId` for confirmation.
 *
 * Applies `patch` ONLY if the row is still `LIVE_CONFIRMATION_REQUIRED`.
 * Returns `null` when a concurrent confirmer already claimed it.
 */
export async function claimLiveCommandForConfirm(
  commandId: string,
  patch: LiveCommandPatch,
): Promise<ArxLiveCommand | null> {
  const rows = await db.update(arxLiveCommandsTable)
    .set(patch)
    .where(and(
      eq(arxLiveCommandsTable.commandId, commandId),
      eq(arxLiveCommandsTable.status, "LIVE_CONFIRMATION_REQUIRED"),
    ))
    .returning();
  return rows[0] ?? null;
}
