// AACI Learning — adaptive weights + permission levels + versioning (Task #232).
//
// Adaptive weights are clamped to [W_MIN, W_MAX] and updated with the asymmetric
// η/λ rule (a safety event lowers a weight more than any reward can raise it).
// Permission is decided by the pure classifier: MAJOR (expanding / risk-
// increasing) changes are ALWAYS recommend-only; MINOR changes auto-apply only
// with sufficient evidence, otherwise they queue as recommend-only. Recommended
// changes are applied only after admin approval. Every change is audited and
// versioned; an applied change can be rolled back.
//
// Weights shape AACI advisory scoring. They never override a hard gate, the Risk
// Governor, allocation, or the kill switch.

import { and, eq } from "drizzle-orm";
import { db, aaciAdaptiveWeightsTable } from "@workspace/db";
import type { AaciAdaptiveWeightRow } from "@workspace/db";
import {
  type LearningChangeType,
  classifyChangePermission,
  computeWeightUpdate,
  clampWeight,
  AACI_WEIGHT_NEUTRAL,
} from "@workspace/domain/aaci";
import {
  writeLearningAudit,
  getLearningChange,
  transitionChangeStatus,
  type Tx,
  type DbOrTx,
} from "./learningAudit.js";

export interface WeightScopeKey {
  weightKey: string;
  userId?: number; // 0 = global/system scope (default)
}

/** Read an active weight value, defaulting to the neutral 1.0 (fail-open). */
export async function getActiveWeight(key: WeightScopeKey): Promise<number> {
  try {
    const rows = await db
      .select({ value: aaciAdaptiveWeightsTable.value })
      .from(aaciAdaptiveWeightsTable)
      .where(
        and(
          eq(aaciAdaptiveWeightsTable.weightKey, key.weightKey),
          eq(aaciAdaptiveWeightsTable.userId, key.userId ?? 0),
          eq(aaciAdaptiveWeightsTable.isActive, true),
        ),
      )
      .limit(1);
    return rows[0]?.value ?? AACI_WEIGHT_NEUTRAL;
  } catch {
    return AACI_WEIGHT_NEUTRAL;
  }
}

async function getWeightRow(
  exec: DbOrTx,
  key: WeightScopeKey,
): Promise<AaciAdaptiveWeightRow | null> {
  const rows = await exec
    .select()
    .from(aaciAdaptiveWeightsTable)
    .where(
      and(
        eq(aaciAdaptiveWeightsTable.weightKey, key.weightKey),
        eq(aaciAdaptiveWeightsTable.userId, key.userId ?? 0),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function ensureWeightRow(
  tx: Tx,
  key: WeightScopeKey,
): Promise<AaciAdaptiveWeightRow> {
  const existing = await getWeightRow(tx, key);
  if (existing) return existing;
  const inserted = await tx
    .insert(aaciAdaptiveWeightsTable)
    .values({
      weightKey: key.weightKey,
      userId: key.userId ?? 0,
      value: AACI_WEIGHT_NEUTRAL,
      baseValue: AACI_WEIGHT_NEUTRAL,
    })
    .onConflictDoNothing({
      target: [aaciAdaptiveWeightsTable.weightKey, aaciAdaptiveWeightsTable.userId],
    })
    .returning();
  return inserted[0] ?? (await getWeightRow(tx, key))!;
}

export interface ProposeWeightInput extends WeightScopeKey {
  changeType: LearningChangeType;
  /** Evidence count backing the change (gates auto-apply via min-evidence). */
  evidence: number;
  reward?: number;
  penalty?: number;
  safetyViolation?: boolean;
  confidence?: number;
  reason: string;
  actorUserId?: number | null;
  actorRole?: string | null;
}

export type ProposeWeightResult =
  | { applied: true; newValue: number; version: number; auditId: number | null }
  | { applied: false; recommended: true; proposedValue: number; auditId: number | null };

/**
 * Propose a weight change. MINOR changes with enough evidence auto-apply
 * (clamped). MAJOR changes, or minor changes without enough evidence, are queued
 * RECOMMEND_ONLY for admin approval (not applied). Audited either way.
 */
export async function proposeWeightChange(
  input: ProposeWeightInput,
): Promise<ProposeWeightResult> {
  const userId = input.userId ?? 0;
  const permission = classifyChangePermission(input.changeType, input.evidence);

  return db.transaction(async (tx) => {
    const row = await ensureWeightRow(tx, { weightKey: input.weightKey, userId });
    const current = row.value;
    const proposed = computeWeightUpdate({
      currentWeight: current,
      reward: input.reward,
      penalty: input.penalty,
      safetyViolation: input.safetyViolation,
    });

    if (permission === "AUTO") {
      const next = clampWeight(proposed);
      const updated = await tx
        .update(aaciAdaptiveWeightsTable)
        .set({ value: next, version: row.version + 1, isActive: true, updatedAt: new Date() })
        .where(eq(aaciAdaptiveWeightsTable.id, row.id))
        .returning();
      const auditId = await writeLearningAudit(tx, {
        entityType: "module",
        entityKey: input.weightKey,
        userId,
        changeType: "WEIGHT_UPDATE",
        permissionLevel: "AUTO",
        status: "APPLIED",
        oldValue: { value: current, version: row.version },
        newValue: { value: next, version: row.version + 1, via: input.changeType },
        reason: input.reason,
        evidenceCount: input.evidence,
        confidence: input.confidence ?? 0,
        actorUserId: input.actorUserId ?? null,
        actorRole: input.actorRole ?? null,
      });
      return { applied: true, newValue: next, version: updated[0]?.version ?? row.version + 1, auditId };
    }

    // RECOMMEND_ONLY — record the proposal, do NOT apply it.
    const auditId = await writeLearningAudit(tx, {
      entityType: "module",
      entityKey: input.weightKey,
      userId,
      changeType: input.changeType,
      permissionLevel: "RECOMMEND_ONLY",
      status: "RECOMMENDED",
      oldValue: { value: current, version: row.version },
      newValue: { value: clampWeight(proposed) },
      reason: input.reason,
      evidenceCount: input.evidence,
      confidence: input.confidence ?? 0,
      actorUserId: input.actorUserId ?? null,
      actorRole: input.actorRole ?? null,
    });
    return { applied: false, recommended: true, proposedValue: clampWeight(proposed), auditId };
  });
}

export interface AdminActionInput {
  changeId: number;
  adminUserId: number;
  adminRole: string;
  reason: string;
}

export type AdminActionResult =
  | { ok: true; status: "APPROVED" | "REJECTED" | "ROLLED_BACK"; appliedValue?: number }
  | { ok: false; reason: "NOT_FOUND" | "NOT_PENDING" | "NOT_APPLIED" | "NO_TARGET" };

/**
 * Approve a recommended weight change: apply its proposed value to the weight,
 * version-bump, and transition the recommendation to APPROVED. CAS-guarded so
 * two admins can't both approve. An APPLIED effect audit row is written.
 */
export async function approveWeightChange(
  input: AdminActionInput,
): Promise<AdminActionResult> {
  return db.transaction(async (tx) => {
    const change = await getLearningChange(tx, input.changeId);
    if (!change) return { ok: false, reason: "NOT_FOUND" };
    if (change.status !== "RECOMMENDED") return { ok: false, reason: "NOT_PENDING" };

    const proposedValue = (change.newValue as { value?: number })?.value;
    if (proposedValue == null) return { ok: false, reason: "NO_TARGET" };

    // CAS-claim the recommendation FIRST. On a lost race this updates 0 rows and
    // returns null; we then plain-return the conflict with NO side effects
    // written (the weight mutation below only runs after a successful claim).
    const transitioned = await transitionChangeStatus(
      tx,
      input.changeId,
      "RECOMMENDED",
      "APPROVED",
      { userId: input.adminUserId },
    );
    if (!transitioned) return { ok: false, reason: "NOT_PENDING" };

    const row = await ensureWeightRow(tx, {
      weightKey: change.entityKey,
      userId: change.userId,
    });
    const next = clampWeight(proposedValue);
    await tx
      .update(aaciAdaptiveWeightsTable)
      .set({ value: next, version: row.version + 1, isActive: true, updatedAt: new Date() })
      .where(eq(aaciAdaptiveWeightsTable.id, row.id));

    await writeLearningAudit(tx, {
      entityType: "module",
      entityKey: change.entityKey,
      userId: change.userId,
      changeType: "WEIGHT_UPDATE",
      permissionLevel: "AUTO",
      status: "APPLIED",
      oldValue: { value: row.value, version: row.version },
      newValue: { value: next, version: row.version + 1, approvedChangeId: input.changeId },
      reason: `Approved change #${input.changeId}: ${input.reason}`,
      rollbackOfId: null,
      actorUserId: input.adminUserId,
      actorRole: input.adminRole,
      approvedByUserId: input.adminUserId,
    });
    return { ok: true, status: "APPROVED", appliedValue: next };
  });
}

/** Reject a recommended change (no weight change). CAS-guarded. */
export async function rejectWeightChange(
  input: AdminActionInput,
): Promise<AdminActionResult> {
  return db.transaction(async (tx) => {
    const change = await getLearningChange(tx, input.changeId);
    if (!change) return { ok: false, reason: "NOT_FOUND" };
    if (change.status !== "RECOMMENDED") return { ok: false, reason: "NOT_PENDING" };
    const transitioned = await transitionChangeStatus(
      tx,
      input.changeId,
      "RECOMMENDED",
      "REJECTED",
      { userId: input.adminUserId },
    );
    if (!transitioned) return { ok: false, reason: "NOT_PENDING" };
    await writeLearningAudit(tx, {
      entityType: "module",
      entityKey: change.entityKey,
      userId: change.userId,
      changeType: change.changeType as LearningChangeType,
      permissionLevel: "RECOMMEND_ONLY",
      status: "REJECTED",
      oldValue: change.newValue as Record<string, unknown>,
      newValue: {},
      reason: `Rejected change #${input.changeId}: ${input.reason}`,
      actorUserId: input.adminUserId,
      actorRole: input.adminRole,
      approvedByUserId: input.adminUserId,
    });
    return { ok: true, status: "REJECTED" };
  });
}

/**
 * Roll back a previously APPLIED weight change, restoring the weight to the
 * change's recorded oldValue. Writes a ROLLBACK row pointing at the reverted
 * change and marks that change ROLLED_BACK.
 */
export async function rollbackWeightChange(
  input: AdminActionInput,
): Promise<AdminActionResult> {
  return db.transaction(async (tx) => {
    const change = await getLearningChange(tx, input.changeId);
    if (!change) return { ok: false, reason: "NOT_FOUND" };
    if (change.status !== "APPLIED") return { ok: false, reason: "NOT_APPLIED" };

    const restoreValue = (change.oldValue as { value?: number })?.value;
    if (restoreValue == null) return { ok: false, reason: "NO_TARGET" };

    // CAS-claim the APPLIED change FIRST so a lost race writes no side effects;
    // the weight restore below only runs after a successful claim.
    const transitioned = await transitionChangeStatus(
      tx,
      input.changeId,
      "APPLIED",
      "ROLLED_BACK",
      { userId: input.adminUserId },
    );
    if (!transitioned) return { ok: false, reason: "NOT_APPLIED" };

    const row = await ensureWeightRow(tx, {
      weightKey: change.entityKey,
      userId: change.userId,
    });
    const restored = clampWeight(restoreValue);
    await tx
      .update(aaciAdaptiveWeightsTable)
      .set({ value: restored, version: row.version + 1, updatedAt: new Date() })
      .where(eq(aaciAdaptiveWeightsTable.id, row.id));

    await writeLearningAudit(tx, {
      entityType: "module",
      entityKey: change.entityKey,
      userId: change.userId,
      changeType: "ROLLBACK",
      permissionLevel: "AUTO",
      status: "ROLLED_BACK",
      oldValue: { value: row.value, version: row.version },
      newValue: { value: restored, version: row.version + 1 },
      reason: `Rollback of change #${input.changeId}: ${input.reason}`,
      rollbackOfId: input.changeId,
      actorUserId: input.adminUserId,
      actorRole: input.adminRole,
      approvedByUserId: input.adminUserId,
    });
    return { ok: true, status: "ROLLED_BACK", appliedValue: restored };
  });
}

/** Admin read: list weight rows. */
export async function listWeights(userId?: number): Promise<AaciAdaptiveWeightRow[]> {
  const q = db.select().from(aaciAdaptiveWeightsTable);
  if (userId != null) {
    return q.where(eq(aaciAdaptiveWeightsTable.userId, userId));
  }
  return q;
}
