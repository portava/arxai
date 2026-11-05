// Task #199 — Eleanor Quality: audited tuning service.
//
// SAFETY / SCOPE:
//   - These thresholds tune OUTCOME-LEARNING classification only. They NEVER
//     feed the 16-gate live pipeline, the kill switch, or any broker dispatch.
//   - Every write is FAIL-CLOSED audited: the threshold update and its
//     admin_action_audit_log row are written inside ONE db.transaction; if the
//     audit insert fails, the update rolls back.
//   - Values are clamped by the pure domain engine before persistence.

import { desc, eq } from "drizzle-orm";
import {
  db,
  eleanorQualityThresholdsTable,
  adminActionAuditLogTable,
} from "@workspace/db";
import {
  clampThresholds,
  DEFAULT_ELEANOR_THRESHOLDS,
  TUNABLE_THRESHOLD_KEYS,
  type EleanorQualityThresholds,
} from "@workspace/domain/eleanor-quality";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const SINGLETON_ID = 1;

function rowToThresholds(r: typeof eleanorQualityThresholdsTable.$inferSelect): EleanorQualityThresholds {
  return clampThresholds({
    lateEntrySeconds: r.lateEntrySeconds,
    minConfidence: r.minConfidence,
    minEdge: r.minEdge,
    newsLockoutMinutes: r.newsLockoutMinutes,
    maxSpread: r.maxSpread,
    maxSlippage: r.maxSlippage,
    minRiskReward: r.minRiskReward,
    strongMovePct: r.strongMovePct,
    breakevenR: r.breakevenR,
    evidenceExpiryMinutes: r.evidenceExpiryMinutes,
  });
}

export interface ThresholdsState {
  thresholds: EleanorQualityThresholds;
  defaults: EleanorQualityThresholds;
  updatedByAdminId: number | null;
  updatedReason: string | null;
  updatedAt: string | null;
}

/** Read the current thresholds, falling back to defaults when unset. */
export async function getThresholdsState(): Promise<ThresholdsState> {
  const rows = await db.select().from(eleanorQualityThresholdsTable)
    .orderBy(desc(eleanorQualityThresholdsTable.id)).limit(1);
  const r = rows[0];
  return {
    thresholds: r ? rowToThresholds(r) : { ...DEFAULT_ELEANOR_THRESHOLDS },
    defaults: { ...DEFAULT_ELEANOR_THRESHOLDS },
    updatedByAdminId: r?.updatedByAdminId ?? null,
    updatedReason: r?.updatedReason ?? null,
    updatedAt: r?.updatedAt ? new Date(r.updatedAt).toISOString() : null,
  };
}

export interface ApplyThresholdsArgs {
  admin: { id: number; role: "ADMIN" | "OWNER" };
  patch: Partial<Record<keyof EleanorQualityThresholds, number>>;
  reason: string;
}

/**
 * Apply a clamped threshold patch with a fail-closed audit row in one tx.
 * Unknown keys are dropped by clampThresholds. Returns the new state.
 */
export async function applyThresholds(args: ApplyThresholdsArgs): Promise<ThresholdsState> {
  // Drop any unknown keys up front so the audit before/after is honest.
  const cleanPatch: Partial<Record<keyof EleanorQualityThresholds, number>> = {};
  for (const k of TUNABLE_THRESHOLD_KEYS) {
    if (args.patch[k] != null && Number.isFinite(args.patch[k])) cleanPatch[k] = args.patch[k];
  }

  await db.transaction(async (tx: Tx) => {
    const existing = await tx.select().from(eleanorQualityThresholdsTable)
      .where(eq(eleanorQualityThresholdsTable.id, SINGLETON_ID)).limit(1);
    const before = existing[0] ? rowToThresholds(existing[0]) : { ...DEFAULT_ELEANOR_THRESHOLDS };
    const after = clampThresholds(cleanPatch, before);
    const now = new Date();

    if (existing[0]) {
      await tx.update(eleanorQualityThresholdsTable)
        .set({ ...after, updatedByAdminId: args.admin.id, updatedReason: args.reason, updatedAt: now })
        .where(eq(eleanorQualityThresholdsTable.id, SINGLETON_ID));
    } else {
      await tx.insert(eleanorQualityThresholdsTable)
        .values({ id: SINGLETON_ID, ...after, updatedByAdminId: args.admin.id, updatedReason: args.reason, updatedAt: now });
    }

    await tx.insert(adminActionAuditLogTable).values({
      adminId: args.admin.id,
      adminRole: args.admin.role,
      action: "ELEANOR_QUALITY_THRESHOLDS_UPDATE",
      targetUserId: null,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: after as unknown as Record<string, unknown>,
      reason: args.reason,
    });
  });

  return getThresholdsState();
}
