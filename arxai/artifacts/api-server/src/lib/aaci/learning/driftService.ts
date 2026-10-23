// AACI Learning — drift detection + regime reset (Task #232, Phase 6).
//
// Compares an entity's recent reconciled win-rate to its baseline and, on
// degradation, produces a BOUNDED, RECOMMEND-ONLY caution (watch → raise
// threshold → reduce trust). Severe drift is logged for admin attention and
// surfaced on the admin learning-health read. Drift recommendations never gate
// execution and never loosen a limit — they only ever add caution.
//
// Regime reset decays learned counts back toward the neutral prior so an entity
// relearns under a new regime without wiping its evidence. It is an AUTO,
// risk-reducing change and is audited.

import { and, eq, isNotNull } from "drizzle-orm";
import {
  db,
  selfTradeAgentExecutionsTable,
  selfTradeDecisionsTable,
  aaciTrustScoresTable,
} from "@workspace/db";
import type { AaciTrustEntityType } from "@workspace/db";
import { detectDrift, regimeReset, type DriftResult } from "@workspace/domain/aaci";
import { logger } from "../../logger.js";
import { writeLearningAudit } from "./learningAudit.js";
import { getTrustRow, rowToTrustState } from "./trustStore.js";

/** Recent window size (in resolved trades) used for the drift comparison. */
const RECENT_WINDOW = 20;

interface ResolvedOutcome {
  realizedPnl: number;
  closedAt: Date | null;
}

/** Load an entity's resolved outcomes (real closes only), oldest → newest. */
async function loadResolvedOutcomes(
  entityType: AaciTrustEntityType,
  entityKey: string,
): Promise<ResolvedOutcome[]> {
  // Drift mirrors exactly the dimensions ingestion folds from REAL evidence.
  // agent + symbol are direct columns on the execution; strategy + timeframe
  // live on the linked decision, so those require a join. Dimensions with no
  // per-trade evidence (module/signal/session) are never queried — they have no
  // real outcomes and stay at their neutral prior (insufficient evidence).
  const closed = and(
    eq(selfTradeAgentExecutionsTable.status, "CLOSED"),
    isNotNull(selfTradeAgentExecutionsTable.realizedPnl),
  );

  let rows: { realizedPnl: number | null; closedAt: Date | null }[];
  if (entityType === "strategy" || entityType === "timeframe") {
    const decCol =
      entityType === "strategy"
        ? selfTradeDecisionsTable.setupType
        : selfTradeDecisionsTable.timeframe;
    rows = await db
      .select({
        realizedPnl: selfTradeAgentExecutionsTable.realizedPnl,
        closedAt: selfTradeAgentExecutionsTable.closedAt,
      })
      .from(selfTradeAgentExecutionsTable)
      .innerJoin(
        selfTradeDecisionsTable,
        eq(selfTradeAgentExecutionsTable.decisionId, selfTradeDecisionsTable.id),
      )
      .where(and(eq(decCol, entityKey), closed));
  } else if (entityType === "agent" || entityType === "symbol") {
    const col =
      entityType === "agent"
        ? selfTradeAgentExecutionsTable.agentKey
        : selfTradeAgentExecutionsTable.symbol;
    rows = await db
      .select({
        realizedPnl: selfTradeAgentExecutionsTable.realizedPnl,
        closedAt: selfTradeAgentExecutionsTable.closedAt,
      })
      .from(selfTradeAgentExecutionsTable)
      .where(and(eq(col, entityKey), closed));
  } else {
    // module / signal / session: no real per-trade evidence column → no outcomes.
    return [];
  }

  return rows
    .filter((r): r is { realizedPnl: number; closedAt: Date | null } => r.realizedPnl != null)
    .sort((a, b) => (a.closedAt?.getTime() ?? 0) - (b.closedAt?.getTime() ?? 0));
}

function winRate(outcomes: ResolvedOutcome[]): number {
  if (outcomes.length === 0) return 0;
  const wins = outcomes.filter((o) => o.realizedPnl > 0).length;
  return wins / outcomes.length;
}

export interface EvaluateDriftInput {
  entityType: AaciTrustEntityType;
  entityKey: string;
  userId?: number;
  actorUserId?: number | null;
  actorRole?: string | null;
}

export interface EvaluateDriftResult extends DriftResult {
  evaluated: boolean;
  recommended: boolean;
}

/**
 * Evaluate drift for one entity, persist the advisory verdict on its trust row,
 * and (when drifted) record a bounded RECOMMEND-ONLY caution. Idempotent per
 * entity/severity/day so a repeated cycle won't spam recommendations.
 */
export async function evaluateEntityDrift(
  input: EvaluateDriftInput,
): Promise<EvaluateDriftResult> {
  const userId = input.userId ?? 0;
  const neutral: EvaluateDriftResult = {
    evaluated: false,
    recommended: false,
    drifted: false,
    severity: "NONE",
    drop: 0,
    recommendation: "NONE",
    driftScore: 70,
    alertAdmin: false,
    insufficientEvidence: true,
  };
  try {
    const outcomes = await loadResolvedOutcomes(input.entityType, input.entityKey);
    if (outcomes.length < RECENT_WINDOW) return neutral;

    const recent = outcomes.slice(-RECENT_WINDOW);
    const baseline = outcomes.slice(0, -RECENT_WINDOW);
    // With no prior history, baseline = full series (no false drift on cold start).
    const baselineWinRate = winRate(baseline.length ? baseline : outcomes);
    const recentWinRate = winRate(recent);

    const result = detectDrift({
      baselineWinRate,
      recentWinRate,
      recentSample: recent.length,
    });

    // Persist the advisory drift snapshot on the trust row (best-effort).
    const row = await getTrustRow(db, {
      entityType: input.entityType,
      entityKey: input.entityKey,
      userId,
    });
    if (row) {
      await db
        .update(aaciTrustScoresTable)
        .set({
          driftSeverity: result.severity,
          driftScore: result.driftScore,
          updatedAt: new Date(),
        })
        .where(eq(aaciTrustScoresTable.id, row.id));
    }

    if (result.severity === "SEVERE") {
      logger.warn(
        { entityType: input.entityType, entityKey: input.entityKey, drop: result.drop },
        "aaci.learning.drift.severe",
      );
    }

    if (!result.drifted) {
      return { ...result, evaluated: true, recommended: false };
    }

    // Idempotent per entity/severity/day so repeated cycles don't spam.
    const day = new Date().toISOString().slice(0, 10);
    const sourceRef = `drift:${input.entityType}:${input.entityKey}:${day}:${result.severity}`;
    try {
      await db.transaction(async (tx) => {
        await writeLearningAudit(tx, {
          entityType: input.entityType,
          entityKey: input.entityKey,
          userId,
          changeType: "DRIFT_RECOMMENDATION",
          permissionLevel: "RECOMMEND_ONLY",
          status: "RECOMMENDED",
          oldValue: { baselineWinRate, recentWinRate },
          newValue: {
            severity: result.severity,
            recommendation: result.recommendation,
            drop: result.drop,
            driftScore: result.driftScore,
          },
          reason: `Drift ${result.severity}: win-rate ${(baselineWinRate * 100).toFixed(
            0,
          )}% → ${(recentWinRate * 100).toFixed(0)}% over last ${RECENT_WINDOW}. Recommendation: ${result.recommendation}.`,
          evidenceCount: recent.length,
          sourceRef,
          actorUserId: input.actorUserId ?? null,
          actorRole: input.actorRole ?? null,
        });
      });
      return { ...result, evaluated: true, recommended: true };
    } catch {
      // Unique-violation = already recommended for this entity/severity/day.
      return { ...result, evaluated: true, recommended: false };
    }
  } catch (err) {
    logger.error(
      { err, entityType: input.entityType, entityKey: input.entityKey },
      "aaci.learning.drift.failed",
    );
    return neutral;
  }
}

export interface RegimeResetInput {
  entityType: AaciTrustEntityType;
  entityKey: string;
  userId?: number;
  regimeTag?: string;
  reason: string;
  actorUserId?: number | null;
  actorRole?: string | null;
}

/**
 * Decay an entity's learned counts toward the neutral prior (regime change). An
 * AUTO, risk-reducing change — audited, never loosens any limit.
 */
export async function applyRegimeReset(
  input: RegimeResetInput,
): Promise<{ applied: boolean }> {
  const userId = input.userId ?? 0;
  return db.transaction(async (tx) => {
    const row = await getTrustRow(tx, {
      entityType: input.entityType,
      entityKey: input.entityKey,
      userId,
    });
    if (!row) return { applied: false };
    const before = rowToTrustState(row);
    const after = regimeReset(before);
    await tx
      .update(aaciTrustScoresTable)
      .set({
        alpha: after.alpha,
        beta: after.beta,
        regimeTag: input.regimeTag ?? row.regimeTag,
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(aaciTrustScoresTable.id, row.id));
    await writeLearningAudit(tx, {
      entityType: input.entityType,
      entityKey: input.entityKey,
      userId,
      changeType: "REGIME_RESET",
      permissionLevel: "AUTO",
      status: "APPLIED",
      oldValue: { alpha: before.alpha, beta: before.beta },
      newValue: { alpha: after.alpha, beta: after.beta, regimeTag: input.regimeTag ?? null },
      reason: input.reason,
      actorUserId: input.actorUserId ?? null,
      actorRole: input.actorRole ?? null,
    });
    return { applied: true };
  });
}
