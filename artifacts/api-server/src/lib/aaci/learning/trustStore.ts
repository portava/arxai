// AACI Learning — trust store service (Task #232, Phase 6).
//
// Persistence + composition layer over the pure Bayesian-trust math in
// @workspace/domain/aaci. All decision rules (luck filter, classification,
// quarantine, evidence) live in the domain; this file only reads/writes rows and
// writes a fail-closed audit row INSIDE the same transaction as every change.
//
// Learning is ADVISORY: it shapes the AACI learnedTrust (L) sub-score. It never
// overrides a hard gate, the Risk Governor, allocation, or the kill switch. On
// any read failure callers fail-open to the neutral prior (mean 0.50).

import { and, desc, eq } from "drizzle-orm";
import {
  db,
  aaciTrustScoresTable,
  aaciLearningAuditTable,
} from "@workspace/db";
import type { AaciTrustEntityType, AaciTrustScoreRow } from "@workspace/db";
import {
  type TrustState,
  classifyDecisionOutcome,
  luckFilteredUpdate,
  applyTrustUpdate,
  evaluateQuarantine,
  effectiveLearnedTrust,
  trustMean,
  neutralTrust,
} from "@workspace/domain/aaci";
import { writeLearningAudit, type DbOrTx, type Tx } from "./learningAudit.js";

/** Pull the Bayesian state out of a persisted row. */
export function rowToTrustState(row: AaciTrustScoreRow): TrustState {
  return { alpha: row.alpha, beta: row.beta };
}

export interface TrustScopeKey {
  entityType: AaciTrustEntityType;
  entityKey: string;
  userId?: number; // 0 = global/system scope (default)
}

/** Read a trust row, or null when the entity has never been observed. */
export async function getTrustRow(
  exec: DbOrTx,
  key: TrustScopeKey,
): Promise<AaciTrustScoreRow | null> {
  const rows = await exec
    .select()
    .from(aaciTrustScoresTable)
    .where(
      and(
        eq(aaciTrustScoresTable.entityType, key.entityType),
        eq(aaciTrustScoresTable.entityKey, key.entityKey),
        eq(aaciTrustScoresTable.userId, key.userId ?? 0),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The learned-trust sub-score (0..100) AACI should consume for a decision,
 * honouring the quarantine exclusion. Fail-open: any error or missing row
 * returns the neutral prior (50) and excluded=false, never fabricated trust.
 */
export async function getEffectiveLearnedTrust(
  key: TrustScopeKey,
): Promise<{ score: number; excluded: boolean; quarantined: boolean }> {
  try {
    const row = await getTrustRow(db, key);
    if (!row) return { score: 50, excluded: false, quarantined: false };
    const eff = effectiveLearnedTrust(rowToTrustState(row), row.quarantined);
    return { ...eff, quarantined: row.quarantined };
  } catch {
    return { score: 50, excluded: false, quarantined: false };
  }
}

/**
 * One-shot read for the decision path: the learned-trust (L) and drift (D)
 * sub-scores AACI should consume for an entity, from a single indexed row.
 * Fail-open: missing row or any error returns the scoring engine's neutral
 * defaults (L=50, D=70) and excluded=false — learning never blocks a decision.
 */
export async function getLearnedTrustForDecision(
  key: TrustScopeKey,
): Promise<{ learnedTrustScore: number; driftScore: number; excluded: boolean }> {
  try {
    const row = await getTrustRow(db, key);
    if (!row) return { learnedTrustScore: 50, driftScore: 70, excluded: false };
    const eff = effectiveLearnedTrust(rowToTrustState(row), row.quarantined);
    return {
      learnedTrustScore: eff.score,
      driftScore: row.driftScore ?? 70,
      excluded: eff.excluded,
    };
  } catch {
    return { learnedTrustScore: 50, driftScore: 70, excluded: false };
  }
}

/**
 * Uncertainty-channel evidence for a decision's trust scopes:
 *   - minEvidenceCount: reconciled outcomes backing the MOST data-poor scope
 *     (the honest bound on sample history);
 *   - newestOutcomeAtMs: the most recent learning outcome across the scopes.
 * FAIL-CLOSED: no scopes, no rows, or any read error → nulls, which upstream
 * turns into the channels' FULL penalties, never silent confidence.
 */
export async function getUncertaintySampleEvidence(
  keys: TrustScopeKey[],
): Promise<{ minEvidenceCount: number | null; newestOutcomeAtMs: number | null }> {
  if (keys.length === 0) return { minEvidenceCount: null, newestOutcomeAtMs: null };
  try {
    const rows = await Promise.all(keys.map((k) => getTrustRow(db, k)));
    let minEvidence: number | null = null;
    let newestOutcomeAtMs: number | null = null;
    for (const row of rows) {
      const evidence = row?.evidenceCount ?? 0; // never-observed scope = 0 samples
      minEvidence = minEvidence == null ? evidence : Math.min(minEvidence, evidence);
      const at = row?.lastOutcomeAt?.getTime();
      if (at != null && Number.isFinite(at)) {
        newestOutcomeAtMs = newestOutcomeAtMs == null ? at : Math.max(newestOutcomeAtMs, at);
      }
    }
    return { minEvidenceCount: minEvidence, newestOutcomeAtMs };
  } catch {
    return { minEvidenceCount: null, newestOutcomeAtMs: null };
  }
}

/** Insert a neutral-prior row if none exists, returning the current row. */
async function ensureTrustRow(tx: Tx, key: TrustScopeKey): Promise<AaciTrustScoreRow> {
  const existing = await getTrustRow(tx, key);
  if (existing) return existing;
  const prior = neutralTrust();
  const inserted = await tx
    .insert(aaciTrustScoresTable)
    .values({
      entityType: key.entityType,
      entityKey: key.entityKey,
      userId: key.userId ?? 0,
      alpha: prior.alpha,
      beta: prior.beta,
      evidenceCount: 0,
    })
    .onConflictDoNothing({
      target: [
        aaciTrustScoresTable.entityType,
        aaciTrustScoresTable.entityKey,
        aaciTrustScoresTable.userId,
      ],
    })
    .returning();
  // onConflictDoNothing returns [] on a race — re-read the winner's row.
  return inserted[0] ?? (await getTrustRow(tx, key))!;
}

export interface ApplyOutcomeInput extends TrustScopeKey {
  /** AACI/decision-quality score at decision time, 0..100. */
  decisionQuality: number;
  /** REAL realized P/L (null = unresolved → NEUTRAL, never fabricated). */
  realizedPnl: number | null;
  /** A hard safety rule was breached → strong λ penalty, never a reward. */
  safetyViolation?: boolean;
  /** Idempotency key for the real-evidence source, e.g. "exec:1234". */
  sourceRef: string;
  actorUserId?: number | null;
  actorRole?: string | null;
}

export type ApplyOutcomeResult =
  | { applied: false; reason: "ALREADY_INGESTED" | "NO_EVIDENCE" }
  | {
      applied: true;
      classification: string;
      rewarded: boolean;
      meanBefore: number;
      meanAfter: number;
      quarantined: boolean;
    };

/**
 * Fold ONE reconciled outcome into an entity's trust, idempotently. Must run
 * inside a db.transaction so the trust update + audit row commit atomically. A
 * repeat call with the same sourceRef is a no-op (ALREADY_INGESTED). A null /
 * flat P/L produces no update (NO_EVIDENCE) — elapsed time never moves trust.
 */
export async function applyOutcomeToTrust(
  tx: Tx,
  input: ApplyOutcomeInput,
): Promise<ApplyOutcomeResult> {
  const userId = input.userId ?? 0;

  // Idempotency: this (entity, scope, source) was already folded in.
  const dupe = await tx
    .select({ id: aaciLearningAuditTable.id })
    .from(aaciLearningAuditTable)
    .where(
      and(
        eq(aaciLearningAuditTable.entityType, input.entityType),
        eq(aaciLearningAuditTable.entityKey, input.entityKey),
        eq(aaciLearningAuditTable.userId, userId),
        eq(aaciLearningAuditTable.sourceRef, input.sourceRef),
      ),
    )
    .limit(1);
  if (dupe.length > 0) return { applied: false, reason: "ALREADY_INGESTED" };

  const classification = classifyDecisionOutcome({
    decisionQuality: input.decisionQuality,
    realizedPnl: input.realizedPnl,
    safetyViolation: input.safetyViolation,
  });
  if (classification === "NEUTRAL") return { applied: false, reason: "NO_EVIDENCE" };

  const row = await ensureTrustRow(tx, input);
  const before = rowToTrustState(row);
  const update = luckFilteredUpdate(classification, {
    safetyViolation: input.safetyViolation,
  });
  const after = applyTrustUpdate(before, update);
  const verdict = evaluateQuarantine(after, row.quarantined);

  const updated = await tx
    .update(aaciTrustScoresTable)
    .set({
      alpha: after.alpha,
      beta: after.beta,
      evidenceCount: row.evidenceCount + 1,
      quarantined: verdict.quarantined,
      quarantineReason: verdict.reason,
      version: row.version + 1,
      lastOutcomeAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(aaciTrustScoresTable.id, row.id))
    .returning();

  await writeLearningAudit(tx, {
    entityType: input.entityType,
    entityKey: input.entityKey,
    userId,
    changeType: "TRUST_UPDATE",
    permissionLevel: "AUTO",
    status: "APPLIED",
    oldValue: {
      alpha: before.alpha,
      beta: before.beta,
      mean: trustMean(before),
      quarantined: row.quarantined,
    },
    newValue: {
      alpha: after.alpha,
      beta: after.beta,
      mean: trustMean(after),
      quarantined: verdict.quarantined,
      rewarded: update.rewarded,
    },
    reason: `Outcome ${classification} folded into trust (${input.sourceRef}).`,
    evidenceCount: updated[0]?.evidenceCount ?? row.evidenceCount + 1,
    confidence: 0,
    sourceRef: input.sourceRef,
    actorUserId: input.actorUserId ?? null,
    actorRole: input.actorRole ?? null,
  });

  // If quarantine state flipped, record it as its own lifecycle change too.
  if (verdict.quarantined !== row.quarantined) {
    await writeLearningAudit(tx, {
      entityType: input.entityType,
      entityKey: input.entityKey,
      userId,
      changeType: verdict.quarantined ? "QUARANTINE" : "UNQUARANTINE",
      permissionLevel: "AUTO",
      status: "APPLIED",
      oldValue: { quarantined: row.quarantined },
      newValue: { quarantined: verdict.quarantined, reason: verdict.reason },
      reason:
        verdict.reason ??
        (verdict.quarantined ? "Entity quarantined." : "Entity recovered from quarantine."),
      evidenceCount: updated[0]?.evidenceCount ?? row.evidenceCount + 1,
      sourceRef: `${input.sourceRef}:quarantine`,
      actorUserId: input.actorUserId ?? null,
      actorRole: input.actorRole ?? null,
    });
  }

  return {
    applied: true,
    classification,
    rewarded: update.rewarded,
    meanBefore: trustMean(before),
    meanAfter: trustMean(after),
    quarantined: verdict.quarantined,
  };
}

export interface TrustListFilter {
  entityType?: AaciTrustEntityType;
  quarantinedOnly?: boolean;
  userId?: number;
  limit?: number;
}

/** Admin read: list trust rows (most-recently-updated first). */
export async function listTrustScores(
  filter: TrustListFilter = {},
): Promise<AaciTrustScoreRow[]> {
  const conds = [] as ReturnType<typeof eq>[];
  if (filter.entityType) conds.push(eq(aaciTrustScoresTable.entityType, filter.entityType));
  if (filter.quarantinedOnly) conds.push(eq(aaciTrustScoresTable.quarantined, true));
  if (filter.userId != null) conds.push(eq(aaciTrustScoresTable.userId, filter.userId));
  const q = db
    .select()
    .from(aaciTrustScoresTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(aaciTrustScoresTable.updatedAt))
    .limit(Math.min(filter.limit ?? 200, 500));
  return q;
}
