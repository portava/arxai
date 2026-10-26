// P0-1 — Live command state-transition compare-and-set (CAS).
//
// WHY THIS MODULE EXISTS
//
// `dispatchLiveCommand` (liveCommandPipeline.ts) READS the command row,
// evaluates all 18 Phase B gates, and only THEN writes the row to
// SENT_TO_MT5_LIVE. That read-then-write is a TOCTOU window. Two concurrent
// dispatches of the SAME LIVE_APPROVED command — a double-tap, a retried
// fetch, two browser tabs, Ruby racing a manual click — both read
// status=LIVE_APPROVED, both pass all 18 gates (every gate is a property of
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
// - Dispatch claims run AFTER the existing gate evaluator has returned PASS.
//   Agent entries additionally revalidate their admission authority under locks.
//   This can only add a refusal; it cannot weaken, reorder or skip a live gate.
// - Losing the CAS is fail-CLOSED: no order is mirrored.
// - Read/writes are keyed by commandId; ownership (userId) is enforced by the
//   caller's `loadOwned()` before any of this runs.

import { and, eq } from "drizzle-orm";
import { db, arxLiveCommandsTable, type ArxLiveCommand } from "@workspace/db";
import {
  authorityRequestForCommand,
  assertUnchangedAuthorityCommand,
  isAgentEntryCommand,
  withEntryAuthority,
  AgentEntryAuthorityError,
} from "../selfTrade/entryAuthority.js";
import { writeSelfTradeAudit } from "../selfTrade/audit.js";

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
  expected?: ArxLiveCommand,
  database: typeof db = db,
  clock?: () => Date,
): Promise<ArxLiveCommand | null> {
  if (expected && expected.commandId !== commandId)
    throw new AgentEntryAuthorityError("ENTRY_AUTHORITY_LINK_MISMATCH");
  const observed =
    expected ??
    (
      await database
        .select()
        .from(arxLiveCommandsTable)
        .where(eq(arxLiveCommandsTable.commandId, commandId))
        .limit(1)
    )[0];
  if (observed && isAgentEntryCommand(observed))
    return claimAgentCommand(observed, "LIVE_APPROVED", patch, database, clock);
  const rows = await database
    .update(arxLiveCommandsTable)
    .set(patch)
    .where(
      and(
        eq(arxLiveCommandsTable.commandId, commandId),
        eq(arxLiveCommandsTable.status, "LIVE_APPROVED"),
      ),
    )
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
  expected?: ArxLiveCommand,
  database: typeof db = db,
  clock?: () => Date,
): Promise<ArxLiveCommand | null> {
  if (expected && expected.commandId !== commandId)
    throw new AgentEntryAuthorityError("ENTRY_AUTHORITY_LINK_MISMATCH");
  const observed =
    expected ??
    (
      await database
        .select()
        .from(arxLiveCommandsTable)
        .where(eq(arxLiveCommandsTable.commandId, commandId))
        .limit(1)
    )[0];
  if (observed && isAgentEntryCommand(observed))
    return claimAgentCommand(
      observed,
      "LIVE_CONFIRMATION_REQUIRED",
      patch,
      database,
      clock,
    );
  const rows = await database
    .update(arxLiveCommandsTable)
    .set(patch)
    .where(
      and(
        eq(arxLiveCommandsTable.commandId, commandId),
        eq(arxLiveCommandsTable.status, "LIVE_CONFIRMATION_REQUIRED"),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

async function claimAgentCommand(
  expected: ArxLiveCommand,
  requiredStatus: string,
  patch: LiveCommandPatch,
  database: typeof db,
  clock?: () => Date,
): Promise<ArxLiveCommand | null> {
  return withEntryAuthority(
    authorityRequestForCommand(expected),
    async (tx, execution, envelope) => {
      const [current] = await tx
        .select()
        .from(arxLiveCommandsTable)
        .where(eq(arxLiveCommandsTable.commandId, expected.commandId))
        .for("update");
      if (!current || current.status !== requiredStatus) return null;
      assertUnchangedAuthorityCommand(expected, current, execution, envelope);
      const now = clock?.() ?? new Date();
      if (
        requiredStatus === "LIVE_APPROVED" &&
        patch.expiresAt != null &&
        patch.expiresAt <= now
      )
        throw new AgentEntryAuthorityError("ENTRY_COMMAND_EXPIRED");
      // This committed CAS is the authority linearization point. A later pause
      // cannot retrospectively declare an already handed-off command unsent.
      const [claimed] = await tx
        .update(arxLiveCommandsTable)
        .set(patch)
        .where(
          and(
            eq(arxLiveCommandsTable.commandId, expected.commandId),
            eq(arxLiveCommandsTable.status, requiredStatus),
          ),
        )
        .returning();
      if (claimed)
        await writeSelfTradeAudit(tx, {
          agentId: execution.agentId,
          actorUserId: expected.userId,
          eventType:
            requiredStatus === "LIVE_APPROVED"
              ? "ENTRY_AUTHORITY_DISPATCH_CLAIMED"
              : "ENTRY_AUTHORITY_CONFIRMED",
          afterState: {
            executionId: execution.id,
            commandId: expected.commandId,
            admissionHash: envelope.snapshotHash,
            at: now.toISOString(),
          },
          reason:
            requiredStatus === "LIVE_APPROVED"
              ? "Authority revalidated and dispatch claimed atomically; later changes cannot declare this request unsent."
              : "Authority revalidated for confirmation; dispatch must validate again.",
        });
      return claimed ?? null;
    },
    database,
    clock,
  );
}
