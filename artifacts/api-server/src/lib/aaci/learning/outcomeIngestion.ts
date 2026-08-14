// AACI Learning — outcome ingestion (Task #232, Phase 6).
//
// Folds REAL reconciled trade outcomes into per-entity Bayesian trust. It reuses
// the existing real-evidence reconciliation: a CLOSED self_trade_agent_execution
// with a non-null realizedPnl is a real broker close fill (dispatch ≠ fill,
// timeout stays UNRESOLVED — never fabricated). Each execution updates the trust
// of the entities that produced it (agent, symbol, and strategy/setup when
// known). Ingestion is idempotent per (entity, source) via the audit sourceRef,
// so it is safe to call every autonomous cycle.
//
// ADVISORY ONLY. This never gates execution; on any failure it logs and returns
// a zero result rather than blocking the cycle.

import { and, eq, isNotNull } from "drizzle-orm";
import {
  db,
  selfTradeAgentExecutionsTable,
  selfTradeDecisionsTable,
} from "@workspace/db";
import type { AaciTrustEntityType } from "@workspace/db";
import { logger } from "../../logger.js";
import { applyOutcomeToTrust, type ApplyOutcomeResult } from "./trustStore.js";

/** Conservative quality when a decision can't be located (treated as low). */
const FALLBACK_DECISION_QUALITY = 50;

/** Normalise a stored quality measure to a 0..100 scale. */
function toQuality100(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return FALLBACK_DECISION_QUALITY;
  // self_trade_decisions stores confidence as 0..1 OR 0..100 historically.
  const v = raw <= 1 ? raw * 100 : raw;
  return Math.max(0, Math.min(100, v));
}

/** A distinct (entityType, entityKey) whose trust moved this ingest. */
export interface TouchedEntity {
  entityType: AaciTrustEntityType;
  entityKey: string;
}

export interface IngestOutcomesResult {
  scanned: number;
  applied: number;
  skipped: number;
  entitiesTouched: number;
  /**
   * Distinct entities whose trust was updated this ingest (for drift re-eval).
   * Spans every dimension carried by REAL evidence on the closed execution and
   * its linked decision: agent + symbol always, plus strategy (decision
   * setupType) and timeframe when the linked decision supplies them. Dimensions
   * with no per-trade evidence column (module, signal, session) are never
   * fabricated — they stay at their neutral prior until a real source exists.
   */
  touchedEntities: TouchedEntity[];
}

/**
 * Ingest all reconciled outcomes for one agent into trust. Reads CLOSED
 * executions with a real realizedPnl, derives decision quality from the linked
 * self_trade_decision, and folds each into agent / symbol / strategy trust.
 */
export async function ingestAgentOutcomes(
  agentId: number,
  actorUserId?: number | null,
): Promise<IngestOutcomesResult> {
  const result: IngestOutcomesResult = {
    scanned: 0,
    applied: 0,
    skipped: 0,
    entitiesTouched: 0,
    touchedEntities: [],
  };
  const touched = new Map<string, TouchedEntity>();
  try {
    const closed = await db
      .select()
      .from(selfTradeAgentExecutionsTable)
      .where(
        and(
          eq(selfTradeAgentExecutionsTable.agentId, agentId),
          eq(selfTradeAgentExecutionsTable.status, "CLOSED"),
          isNotNull(selfTradeAgentExecutionsTable.realizedPnl),
        ),
      );
    result.scanned = closed.length;
    if (closed.length === 0) return result;

    for (const exec of closed) {
      // Resolve decision quality + the entity dimensions the decision carries
      // (best-effort). setupType (strategy classifier) and timeframe are REAL
      // evidence on the linked decision; null/blank values are simply skipped.
      let decisionQuality = FALLBACK_DECISION_QUALITY;
      let setupType: string | null = null;
      let timeframe: string | null = null;
      if (exec.decisionId != null) {
        const dec = await db
          .select({
            confidence: selfTradeDecisionsTable.confidence,
            setupScore: selfTradeDecisionsTable.setupScore,
            setupType: selfTradeDecisionsTable.setupType,
            timeframe: selfTradeDecisionsTable.timeframe,
          })
          .from(selfTradeDecisionsTable)
          .where(eq(selfTradeDecisionsTable.id, exec.decisionId))
          .limit(1);
        if (dec[0]) {
          decisionQuality = toQuality100(dec[0].confidence || dec[0].setupScore);
          setupType = dec[0].setupType?.trim() || null;
          timeframe = dec[0].timeframe?.trim() || null;
        }
      }

      const sourceRef = `exec:${exec.id}`;
      const entities: TouchedEntity[] = [
        { entityType: "agent", entityKey: exec.agentKey },
        { entityType: "symbol", entityKey: exec.symbol },
      ];
      // Strategy + timeframe trust come ONLY from real linked-decision evidence.
      if (setupType) entities.push({ entityType: "strategy", entityKey: setupType });
      if (timeframe) entities.push({ entityType: "timeframe", entityKey: timeframe });

      // Per-execution transaction: all entity updates + audits commit together.
      try {
        const outcomes = await db.transaction(async (tx) => {
          const applied: ApplyOutcomeResult[] = [];
          for (const ent of entities) {
            applied.push(
              await applyOutcomeToTrust(tx, {
                entityType: ent.entityType,
                entityKey: ent.entityKey,
                userId: 0,
                decisionQuality,
                realizedPnl: exec.realizedPnl,
                sourceRef,
                actorUserId: actorUserId ?? null,
              }),
            );
          }
          return applied;
        });
        // `outcomes` is parallel to `entities` (same push order in the tx), so
        // a moved trust row maps back to the exact dimension that produced it.
        for (let i = 0; i < outcomes.length; i++) {
          const o = outcomes[i];
          if (o?.applied) {
            result.applied += 1;
            result.entitiesTouched += 1;
            const ent = entities[i];
            if (ent) touched.set(`${ent.entityType}|${ent.entityKey}`, ent);
          } else {
            result.skipped += 1;
          }
        }
      } catch (err) {
        // One bad execution must not abort the whole ingest (fail-open).
        logger.error(
          { err, agentId, execId: exec.id },
          "aaci.learning.ingest.execution_failed",
        );
        result.skipped += entities.length;
      }
    }
  } catch (err) {
    logger.error({ err, agentId }, "aaci.learning.ingest.failed");
  }
  result.touchedEntities = [...touched.values()];
  return result;
}
