// AACI Learning — append-only audit helper (Task #232, Phase 6).
//
// Every learning change (trust update, drift recommendation, quarantine, weight
// update, approval, rollback) writes an aaci_learning_audit row. Mutations call
// this INSIDE their db.transaction so the audit row commits atomically with the
// change — fail-closed: if the audit insert throws, the whole change rolls back.
// Rows are evidence and are never auto-deleted.

import { and, desc, eq, sql } from "drizzle-orm";
import { db, aaciLearningAuditTable } from "@workspace/db";
import type {
  AaciLearningAuditRow,
  AaciLearningChangeType,
  AaciLearningStatus,
  AaciTrustEntityType,
} from "@workspace/db";
import type { ChangePermission } from "@workspace/domain/aaci";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbOrTx = typeof db | Tx;

export interface LearningAuditInput {
  entityType: AaciTrustEntityType | string;
  entityKey: string;
  userId?: number; // 0 = global/system scope
  changeType: AaciLearningChangeType;
  permissionLevel: ChangePermission;
  status: AaciLearningStatus;
  oldValue?: unknown;
  newValue?: unknown;
  reason: string;
  evidenceCount?: number;
  confidence?: number; // 0..1
  sourceRef?: string | null; // idempotency key (e.g. "exec:1234")
  rollbackOfId?: number | null;
  actorUserId?: number | null;
  actorRole?: string | null;
  approvedByUserId?: number | null;
}

/** Write one learning-audit row using the provided db or transaction handle. */
export async function writeLearningAudit(
  tx: DbOrTx,
  input: LearningAuditInput,
): Promise<number | null> {
  const rows = await tx
    .insert(aaciLearningAuditTable)
    .values({
      entityType: input.entityType,
      entityKey: input.entityKey,
      userId: input.userId ?? 0,
      changeType: input.changeType,
      permissionLevel: input.permissionLevel,
      status: input.status,
      oldValue: (input.oldValue ?? {}) as Record<string, unknown>,
      newValue: (input.newValue ?? {}) as Record<string, unknown>,
      reason: input.reason,
      evidenceCount: input.evidenceCount ?? 0,
      confidence: input.confidence ?? 0,
      sourceRef: input.sourceRef ?? null,
      rollbackOfId: input.rollbackOfId ?? null,
      actorUserId: input.actorUserId ?? null,
      actorRole: input.actorRole ?? null,
      approvedByUserId: input.approvedByUserId ?? null,
      approvedAt: input.approvedByUserId != null ? new Date() : null,
    })
    .returning({ id: aaciLearningAuditTable.id });
  return rows[0]?.id ?? null;
}

export interface LearningChangeFilter {
  entityType?: string;
  entityKey?: string;
  status?: AaciLearningStatus;
  changeType?: AaciLearningChangeType;
  userId?: number;
  limit?: number;
}

/** Admin read: list audit/change rows, newest first. */
export async function listLearningChanges(
  filter: LearningChangeFilter = {},
): Promise<AaciLearningAuditRow[]> {
  const conds = [] as ReturnType<typeof eq>[];
  if (filter.entityType) conds.push(eq(aaciLearningAuditTable.entityType, filter.entityType));
  if (filter.entityKey) conds.push(eq(aaciLearningAuditTable.entityKey, filter.entityKey));
  if (filter.status) conds.push(eq(aaciLearningAuditTable.status, filter.status));
  if (filter.changeType) conds.push(eq(aaciLearningAuditTable.changeType, filter.changeType));
  if (filter.userId != null) conds.push(eq(aaciLearningAuditTable.userId, filter.userId));
  return db
    .select()
    .from(aaciLearningAuditTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(aaciLearningAuditTable.id))
    .limit(Math.min(filter.limit ?? 200, 500));
}

/** Admin read: exact count of audit/change rows matching a filter (no row cap). */
export async function countLearningChanges(
  filter: LearningChangeFilter = {},
): Promise<number> {
  const conds = [] as ReturnType<typeof eq>[];
  if (filter.entityType) conds.push(eq(aaciLearningAuditTable.entityType, filter.entityType));
  if (filter.entityKey) conds.push(eq(aaciLearningAuditTable.entityKey, filter.entityKey));
  if (filter.status) conds.push(eq(aaciLearningAuditTable.status, filter.status));
  if (filter.changeType) conds.push(eq(aaciLearningAuditTable.changeType, filter.changeType));
  if (filter.userId != null) conds.push(eq(aaciLearningAuditTable.userId, filter.userId));
  const [agg] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(aaciLearningAuditTable)
    .where(conds.length ? and(...conds) : undefined);
  return agg?.n ?? 0;
}

/** Read one audit/change row by id. */
export async function getLearningChange(
  exec: DbOrTx,
  id: number,
): Promise<AaciLearningAuditRow | null> {
  const rows = await exec
    .select()
    .from(aaciLearningAuditTable)
    .where(eq(aaciLearningAuditTable.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Transition a recommendation row's lifecycle status (RECOMMENDED →
 * APPROVED/REJECTED/ROLLED_BACK), via CAS on the expected current status so two
 * admins can't both action the same recommendation. Returns the updated row or
 * null when the CAS matched nothing.
 */
export async function transitionChangeStatus(
  tx: DbOrTx,
  id: number,
  expected: AaciLearningStatus,
  next: AaciLearningStatus,
  approver?: { userId?: number | null },
): Promise<AaciLearningAuditRow | null> {
  const rows = await tx
    .update(aaciLearningAuditTable)
    .set({
      status: next,
      approvedByUserId: approver?.userId ?? null,
      approvedAt: new Date(),
    })
    .where(
      and(
        eq(aaciLearningAuditTable.id, id),
        eq(aaciLearningAuditTable.status, expected),
      ),
    )
    .returning();
  return rows[0] ?? null;
}
