// Only server-side, idempotent settlement. No broker, Guardian or advisory dispatch.
import { db, arxLiveCommandsTable, type ArxLiveCommand } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID, createHash } from "node:crypto";
import type { EvidenceTx } from "./executionEvidence.js";

export const SETTLEMENT_MAX_ATTEMPTS = 8;
export const SETTLEMENT_LEASE_MS = 30_000;
export const SETTLEMENT_CONSUMERS = [
  "EXPOSURE_RESERVATION",
  "MANUAL_CLOSE_POSITION",
  "AGENT_CLOSE_POSITION",
] as const;
export type SettlementConsumer = (typeof SETTLEMENT_CONSUMERS)[number];
export type SettlementClaim = {
  id: number;
  command_row_id: number;
  user_id: number;
  consumer: SettlementConsumer;
  receipt_fingerprint: string;
  generation: number;
  attempts: number;
  lease_token: string;
};
export class StaleSettlementClaim extends Error {
  constructor() {
    super("SETTLEMENT_CLAIM_SUPERSEDED");
  }
}
export class SettlementEvidenceHeld extends Error {}
function receiptMatchesCommand(
  p: Record<string, unknown> | undefined,
  command: ArxLiveCommand,
) {
  return (
    p &&
    p.finalStatus === command.status &&
    p.executedVolume === command.executedVolume &&
    p.brokerTicket === command.brokerTicket
  );
}
/** Exact retry still reports current truth. A prior DONE does not certify a
 * mutable command row that now disagrees with its accepted receipt. Caller has
 * the command lock; no position is modified or historical receipt rewritten. */
export async function holdChangedSettlementEvidence(
  tx: EvidenceTx,
  command: ArxLiveCommand,
) {
  const result =
    await tx.execute(sql`select payload from execution_events where command_id=${command.id}
    and payload->>'applied'='true' and payload ? 'reportFingerprint' order by sequence_no desc limit 1`);
  const receipt = result.rows[0]?.payload as
    | Record<string, unknown>
    | undefined;
  if (!receipt || receiptMatchesCommand(receipt, command)) return;
  await tx.execute(sql`update result_settlement_jobs set status='HELD',reason=case
      when consumer='MANUAL_CLOSE_POSITION' then 'MANUAL_CLOSE_RECEIPT_MISMATCH'
      when consumer='AGENT_CLOSE_POSITION' then 'MANAGEMENT_RESULT_EVIDENCE_UNVERIFIED'
      else 'SETTLEMENT_COMMAND_EVIDENCE_CHANGED' end,
    lease_token=null,lease_until=null,updated_at=clock_timestamp()
    where command_row_id=${command.id} and user_id=${command.userId}`);
}
export function settlementWorkerEnabled(
  raw = process.env.ARX_RESULT_SETTLEMENT_WORKER_ENABLED,
) {
  return raw === "true";
}
export function settlementRetryMs(
  id: number,
  generation: number,
  attempts: number,
) {
  const unit =
    createHash("sha256")
      .update(`${id}:${generation}:${attempts}`)
      .digest()
      .readUInt32BE(0) / 0xffffffff;
  return Math.floor(
    Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1)) *
      (0.8 + 0.2 * unit),
  );
}

/** Caller owns the command lock and the same transaction as immutable receipt/audit.
 * Only accepted newer evidence advances generation; HTTP retries cannot reset holds.
 */
export async function enqueueResultSettlement(
  tx: EvidenceTx,
  command: ArxLiveCommand,
  fingerprint: string,
  consumers: readonly SettlementConsumer[],
  legacy = false,
) {
  for (const consumer of consumers) {
    const changed = await tx.execute(sql`insert into result_settlement_jobs
      (command_row_id,user_id,consumer,receipt_fingerprint,status,reason)
      values (${command.id},${command.userId},${consumer},${fingerprint},
        ${legacy ? "HELD" : "PENDING"},${legacy ? "LEGACY_RECEIPT_REQUIRES_REVIEW" : null})
      on conflict (command_row_id,consumer) do ${
        legacy
          ? sql`nothing`
          : sql`update set
        receipt_fingerprint=excluded.receipt_fingerprint,
        generation=result_settlement_jobs.generation+1,status='PENDING',attempts=0,
        due_at=clock_timestamp(),lease_token=null,lease_until=null,reason=null,updated_at=clock_timestamp()
        where result_settlement_jobs.user_id=excluded.user_id
          and result_settlement_jobs.receipt_fingerprint<>excluded.receipt_fingerprint`
      }`);
    if (changed.rowCount === 0) {
      const existing = await tx.execute(sql`select user_id from result_settlement_jobs
        where command_row_id=${command.id} and consumer=${consumer}`);
      if (existing.rows[0]?.user_id !== command.userId)
        throw new Error("SETTLEMENT_JOB_OWNERSHIP_CONFLICT");
    }
  }
}

/** This short transaction commits its lease BEFORE any consumer lock is acquired. */
export async function claimResultSettlement(scope?: {
  commandRowId: number;
  userId: number;
}) {
  return db.transaction(async (tx) => {
    const filter = scope
      ? sql`and command_row_id=${scope.commandRowId} and user_id=${scope.userId}`
      : sql``;
    // A crashed final attempt is held, never silently considered successful.
    await tx.execute(sql`with exhausted as (
      select id from result_settlement_jobs where status='LEASED' and lease_until<=clock_timestamp()
        and attempts>=${SETTLEMENT_MAX_ATTEMPTS} ${filter} order by id for update skip locked limit 16)
      update result_settlement_jobs j set status='HELD',reason='RETRY_BUDGET_EXHAUSTED',
        lease_token=null,lease_until=null,updated_at=clock_timestamp()
      from exhausted where j.id=exhausted.id`);
    const token = randomUUID();
    const result = await tx.execute(sql`with next_job as (
      select id from result_settlement_jobs where attempts<${SETTLEMENT_MAX_ATTEMPTS}
        and ((status in ('PENDING','RETRY') and due_at<=clock_timestamp())
          or (status='LEASED' and lease_until<=clock_timestamp())) ${filter}
      order by due_at,id for update skip locked limit 1)
      update result_settlement_jobs j set status='LEASED',attempts=j.attempts+1,
        lease_token=${token},lease_until=clock_timestamp()+${SETTLEMENT_LEASE_MS}*interval '1 millisecond',updated_at=clock_timestamp()
      from next_job where j.id=next_job.id returning j.*`);
    return (result.rows[0] as SettlementClaim | undefined) ?? null;
  });
}

/** Acquire last, after existing agent/position/command locks. Never wrap a
 * position-first consumer with an outer command lock. Receipt writers use the
 * same command→job suffix; lease writers never wait for a consumer lock.
 */
export async function assertSettlementClaim(
  tx: EvidenceTx,
  command: ArxLiveCommand,
  claim?: SettlementClaim,
) {
  if (!claim) return;
  if (claim.command_row_id !== command.id || claim.user_id !== command.userId)
    throw new StaleSettlementClaim();
  const job = await tx.execute(sql`select id from result_settlement_jobs
    where id=${claim.id} and command_row_id=${command.id} and user_id=${command.userId}
      and generation=${claim.generation} and receipt_fingerprint=${claim.receipt_fingerprint}
      and status='LEASED' and lease_token=${claim.lease_token} and lease_until>clock_timestamp() for update`);
  if (!job.rows.length) throw new StaleSettlementClaim();
  const receipt =
    await tx.execute(sql`select payload from execution_events where command_id=${command.id}
    and payload->>'applied'='true' and payload ? 'reportFingerprint' order by sequence_no desc limit 1`);
  const p = receipt.rows[0]?.payload as Record<string, unknown> | undefined;
  if (
    !p ||
    p.reportFingerprint !== claim.receipt_fingerprint ||
    p.settlementOutboxVersion !== 1
  )
    throw new SettlementEvidenceHeld("SETTLEMENT_ACCEPTED_RECEIPT_UNVERIFIED");
  if (!receiptMatchesCommand(p, command))
    throw new SettlementEvidenceHeld(
      claim.consumer === "MANUAL_CLOSE_POSITION"
        ? "MANUAL_CLOSE_RECEIPT_MISMATCH"
        : "SETTLEMENT_COMMAND_EVIDENCE_CHANGED",
    );
}

export async function finishResultSettlement(
  claim: SettlementClaim,
  outcome: { status: "DONE" | "HELD" | "RETRY"; reason?: string },
) {
  const exhausted =
    outcome.status === "RETRY" && claim.attempts >= SETTLEMENT_MAX_ATTEMPTS;
  const status = exhausted ? "HELD" : outcome.status;
  const delay =
    status === "RETRY"
      ? settlementRetryMs(claim.id, claim.generation, claim.attempts)
      : 0;
  const result =
    await db.execute(sql`update result_settlement_jobs set status=${status},
    reason=${exhausted ? "RETRY_BUDGET_EXHAUSTED" : (outcome.reason ?? null)},
    due_at=clock_timestamp()+${delay}*interval '1 millisecond',lease_token=null,lease_until=null,
    completed_generation=${status === "DONE" ? claim.generation : null},updated_at=clock_timestamp()
    where id=${claim.id} and generation=${claim.generation} and status='LEASED'
      and lease_token=${claim.lease_token} and lease_until>clock_timestamp() returning id`);
  return result.rows.length === 1;
}

/** Latest status and owner are checked under command→reservation locks. The
 * master/user admission locks never wait for a command while holding a row in
 * this table; reservations are inserted before final dispatch claim.
 */
async function reconcileExposure(claim: SettlementClaim) {
  const { settleReservationForStatus } =
    await import("./liveCommandPipeline.js");
  return db.transaction(async (tx) => {
    const [command] = await tx
      .select()
      .from(arxLiveCommandsTable)
      .where(
        and(
          eq(arxLiveCommandsTable.id, claim.command_row_id),
          eq(arxLiveCommandsTable.userId, claim.user_id),
        ),
      )
      .for("update");
    if (!command) return { heldReason: "SETTLEMENT_OWNER_OR_COMMAND_CHANGED" };
    await assertSettlementClaim(tx, command, claim);
    const action = settleReservationForStatus(
      command.status as Parameters<typeof settleReservationForStatus>[0],
    );
    const reservations =
      await tx.execute(sql`select id,user_id,status from arx_dispatch_exposure_reservations
      where command_id=${command.commandId} order by id for update`);
    if (reservations.rows.some((r) => r.user_id !== command.userId))
      return { heldReason: "RESERVATION_OWNER_MISMATCH" };
    if (action === "HOLD") return { heldReason: "OUTCOME_UNCONFIRMED" };
    const status = action === "FULFILL" ? "FULFILLED" : "RELEASED";
    if (
      reservations.rows.some(
        (r) => r.status !== "RESERVED" && r.status !== status,
      )
    )
      return { heldReason: "RESERVATION_SETTLEMENT_CONFLICT" };
    await tx.execute(sql`update arx_dispatch_exposure_reservations set status=${status},updated_at=clock_timestamp()
      where command_id=${command.commandId} and user_id=${command.userId} and status='RESERVED'`);
    return { heldReason: null };
  });
}

export async function runClaimedSettlement(claim: SettlementClaim) {
  try {
    if (!SETTLEMENT_CONSUMERS.includes(claim.consumer))
      throw new SettlementEvidenceHeld("SETTLEMENT_CONSUMER_NOT_ALLOWED");
    let result: { heldReason: string | null; closedRows?: unknown[] };
    if (claim.consumer === "EXPOSURE_RESERVATION")
      result = await reconcileExposure(claim);
    else {
      const [command] = await db
        .select()
        .from(arxLiveCommandsTable)
        .where(
          and(
            eq(arxLiveCommandsTable.id, claim.command_row_id),
            eq(arxLiveCommandsTable.userId, claim.user_id),
          ),
        );
      if (!command)
        result = { heldReason: "SETTLEMENT_OWNER_OR_COMMAND_CHANGED" };
      else {
        const { reconcileBoundManagementClose, reconcileManualResultPosition } =
          await import("./liveCommandPipeline.js");
        result =
          claim.consumer === "AGENT_CLOSE_POSITION"
            ? await reconcileBoundManagementClose(command, new Date(), claim)
            : await reconcileManualResultPosition(command, new Date(), claim);
      }
    }
    if (result.heldReason === "MANAGEMENT_LEDGER_READ_FAILED")
      throw new Error(result.heldReason);
    const saved = await finishResultSettlement(claim, {
      status: result.heldReason ? "HELD" : "DONE",
      reason: result.heldReason ?? undefined,
    });
    return { ...result, saved };
  } catch (error) {
    if (error instanceof StaleSettlementClaim)
      return { heldReason: "SETTLEMENT_CLAIM_SUPERSEDED", saved: false };
    if (error instanceof SettlementEvidenceHeld) {
      const saved = await finishResultSettlement(claim, {
        status: "HELD",
        reason: error.message,
      });
      return { heldReason: error.message, saved };
    }
    // Unknown failures are retryable only within the fixed budget; they never
    // imply completed settlement. Persisted reasons avoid secrets/SQL details.
    await finishResultSettlement(claim, {
      status: "RETRY",
      reason: "SETTLEMENT_PROCESSING_FAILED",
    });
    return { heldReason: "SETTLEMENT_PROCESSING_FAILED", saved: false };
  }
}

export async function settleCommandJobs(commandRowId: number, userId: number) {
  // At most the three allowlisted consumers, never an unbounded HTTP drain.
  const manualClosedRows: unknown[] = [];
  for (let i = 0; i < SETTLEMENT_CONSUMERS.length; i++) {
    const job = await claimResultSettlement({ commandRowId, userId });
    if (!job) break;
    const applied = await runClaimedSettlement(job);
    if (
      job.consumer === "MANUAL_CLOSE_POSITION" &&
      applied.saved &&
      "closedRows" in applied
    )
      manualClosedRows.push(...(applied.closedRows ?? []));
  }
  const result =
    await db.execute(sql`select consumer,status,reason,generation,completed_generation
    from result_settlement_jobs where command_row_id=${commandRowId} and user_id=${userId} order by id`);
  return {
    manualClosedRows,
    jobs: result.rows as Array<{
      consumer: SettlementConsumer;
      status: string;
      reason: string | null;
      generation: number;
      completed_generation: number | null;
    }>,
  };
}
export async function runResultSettlementPass(limit = 16) {
  const bound = Math.max(0, Math.min(16, Math.floor(limit)));
  let claimed = 0;
  for (; claimed < bound; claimed++) {
    const job = await claimResultSettlement();
    if (!job) break;
    await runClaimedSettlement(job);
  }
  return { claimed };
}
