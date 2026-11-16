// One strict append path. Command row locks serialize per-command evidence;
// a sequence number is a persisted observation order, never broker event order.
import { db, arxLiveCommandsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
export type EvidenceTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Shaped row for one execution_events insert (see lib/db executionEvents.ts). */
export interface ExecutionEventRow {
  commandRowId: number;
  source: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

/**
 * PURE shaping/validation of an execution-event row. Refuses (with a reason,
 * never a throw) rather than fabricating an anchor or a type:
 *   - commandRowId must be a positive integer (the arx_live_commands PK);
 *   - source and eventType must be non-empty after trimming;
 *   - a missing occurredAt falls back to `now` (the caller's clock) — the
 *     received_at column is stamped by the DB independently.
 */
export function buildExecutionEventRow(input: {
  commandRowId: number | null | undefined;
  source: string | null | undefined;
  eventType: string | null | undefined;
  payload?: Record<string, unknown> | null;
  occurredAt?: Date | null;
  now?: Date;
}): { ok: true; row: ExecutionEventRow } | { ok: false; reason: string } {
  const id = input.commandRowId;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    return { ok: false, reason: "EVENT_COMMAND_ROW_ID_INVALID" };
  }
  const source = (input.source ?? "").trim();
  if (source === "") return { ok: false, reason: "EVENT_SOURCE_EMPTY" };
  const eventType = (input.eventType ?? "").trim();
  if (eventType === "") return { ok: false, reason: "EVENT_TYPE_EMPTY" };
  return {
    ok: true,
    row: {
      commandRowId: id,
      source,
      eventType,
      payload: input.payload ?? {},
      occurredAt: input.occurredAt ?? input.now ?? new Date(),
    },
  };
}

export interface ExecutionEvidenceInput {
  commandRowId: number | null | undefined;
  source: string;
  eventType: string;
  payload?: Record<string, unknown> | null;
  occurredAt?: Date | null;
}
// Strict canonical JSON: never replace an unserializable report with a sentinel.
function canonical(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime()))
      throw new Error("EVIDENCE_TIME_INVALID");
    return JSON.stringify(value.toISOString());
  }
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("EVIDENCE_NUMBER_INVALID");
  if (typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("EVIDENCE_VALUE_INVALID");
    return encoded;
  }
  if (Array.isArray(value))
    return `[${value.map((v) => (v === undefined ? "null" : canonical(v))).join(",")}]`;
  return `{${Object.keys(value as object)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}
export function executionReportFingerprint(
  report: Record<string, unknown>,
): string {
  return createHash("sha256").update(canonical(report)).digest("hex");
}
export async function appendExecutionEvidence(
  input: ExecutionEvidenceInput,
  transaction?: EvidenceTx,
): Promise<void> {
  const shaped = buildExecutionEventRow(input);
  if (!shaped.ok) throw new Error(shaped.reason);
  const row = shaped.row;
  if (!Number.isFinite(row.occurredAt.getTime()))
    throw new Error("EVENT_TIME_INVALID");
  const payloadJson = canonical(row.payload);
  const append = async (tx: EvidenceTx): Promise<void> => {
    const [anchor] = await tx
      .select({ id: arxLiveCommandsTable.id })
      .from(arxLiveCommandsTable)
      .where(eq(arxLiveCommandsTable.id, row.commandRowId))
      .for("update");
    if (!anchor) throw new Error("EVENT_COMMAND_NOT_FOUND");
    // Separate statement after acquiring the lock: READ COMMITTED observes the
    // previous writer's committed event. Every execution-event writer uses this lock.
    await tx.execute(sql`
      insert into execution_events (command_id,source,event_type,payload,occurred_at,sequence_no)
      values (${row.commandRowId},${row.source},${row.eventType},${payloadJson}::jsonb,${row.occurredAt},
        (select coalesce(max(sequence_no),0)+1 from execution_events where command_id=${row.commandRowId}))
    `);
  };
  if (transaction) await append(transaction);
  else await db.transaction(append);
}
