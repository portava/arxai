// Self-Trade AI — append-only audit helper (Task #211, Foundation).
//
// Every state-changing Self-Trade operation writes a self_trade_audit_log row.
// Mutations call this INSIDE their db.transaction so the audit row commits
// atomically with the change (fail-closed: if the audit insert throws, the
// whole mutation rolls back). Rows are evidence and are never auto-deleted.

import { db, selfTradeAuditLogTable } from "@workspace/db";

// Canonical transaction handle type (matches the fund-book service convention).
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbOrTx = typeof db | Tx;

export interface SelfTradeAuditInput {
  agentId?: number | null;
  eventType: string;
  scope?: string | null;
  actorUserId?: number | null;
  actorRole?: string | null;
  severity?: "INFO" | "WARNING" | "CRITICAL";
  beforeState?: unknown;
  afterState?: unknown;
  reason?: string | null;
}

// Write one audit row using the provided db or transaction handle.
export async function writeSelfTradeAudit(
  tx: DbOrTx,
  input: SelfTradeAuditInput,
): Promise<void> {
  await tx.insert(selfTradeAuditLogTable).values({
    agentId: input.agentId ?? null,
    eventType: input.eventType,
    scope: input.scope ?? null,
    actorUserId: input.actorUserId ?? null,
    actorRole: input.actorRole ?? null,
    severity: input.severity ?? "INFO",
    beforeState: (input.beforeState ?? {}) as Record<string, unknown>,
    afterState: (input.afterState ?? {}) as Record<string, unknown>,
    reason: input.reason ?? null,
  });
}
