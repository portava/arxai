// Agent Ecosystem — Layer 2: outcome resolution + truth-review scoring (wiring).
//
// Fetches LOCKED, not-yet-resolved predictions, resolves each against honest,
// already-recorded evidence (a matched closed trade and/or expiry), grades the
// resolvable ones with the PURE domain engine, appends an immutable review row,
// and nudges the agent's rolling 0-100 aggregates.
//
// SAFETY / SCOPE:
//   - OBSERVATION ONLY. Nothing here places, modifies, or closes a trade and no
//     path touches the 16-gate live pipeline. Scoring runs off the hot path.
//   - Per-user isolation: a prediction's matched trade is read ONLY for that
//     prediction's own userId. No row from user A informs user B.
//   - No fabrication: an outcome is resolved ONLY on real evidence — a matched
//     closed trade, or real observed candle movement. Elapsed time alone NEVER
//     resolves anything; with no evidence a prediction stays PENDING
//     (resolvable=false) rather than inventing an outcome. (This wiring does not
//     yet supply candle-move evidence, so no-trade calls remain PENDING until a
//     later layer feeds real market movement — honest, never assumed-correct.)
//     R-multiple is derived only from the trade's OWN recorded SL/TP levels and
//     labelled `estimated_from_levels` in the evidence blob.

import {
  db, agentPredictionsTable, agentPredictionReviewsTable, agentsTable, tradesTable,
} from "@workspace/db";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  resolvePredictionOutcome, scoreTradeReview, nextAggregates,
  type OutcomeEvidence, type ReviewablePrediction, type ReviewRealizedOutcome,
} from "@workspace/domain/agent-system";

const DEFAULT_EXPIRY_MS = 4 * 60 * 60 * 1000; // 4h horizon for resolution

export interface ResolveScoreResult {
  scanned: number;
  resolved: number;
  scored: number;
  pendingLeft: number;
}

type PredictionRow = typeof agentPredictionsTable.$inferSelect;

// Estimate the realized R-multiple from the trade's OWN recorded levels. This
// is a documented heuristic over the trade's own data, NOT market fabrication.
function estimateRFromLevels(t: typeof tradesTable.$inferSelect): number | null {
  const entry = t.entryPrice, stop = t.stopLoss, tp = t.takeProfit, pnl = t.pnl;
  if (pnl == null) return null;
  if (entry != null && stop != null && Math.abs(entry - stop) > 0) {
    const risk = Math.abs(entry - stop);
    if (pnl > 0 && tp != null) return +(Math.abs(tp - entry) / risk).toFixed(3); // assume TP fill
    if (pnl < 0) return -1;                                                       // assume stop fill
    return 0;
  }
  return null;
}

async function gatherEvidence(p: PredictionRow, now: Date): Promise<OutcomeEvidence> {
  const ageMs = now.getTime() - new Date(p.timestampCreated).getTime();
  const ev: OutcomeEvidence = { ageMs, expiryMs: DEFAULT_EXPIRY_MS };
  if (p.tradeId != null && p.userId != null) {
    // Per-user isolation: only this prediction's own user's trade.
    const [trade] = await db.select().from(tradesTable)
      .where(and(eq(tradesTable.id, p.tradeId), eq(tradesTable.userId, p.userId)))
      .limit(1);
    if (trade && trade.status === "closed") {
      ev.closedTradeExists = true;
      ev.closedTradePnlR = estimateRFromLevels(trade);
    }
  }
  return ev;
}

function toReviewablePrediction(p: PredictionRow): ReviewablePrediction {
  return {
    predictionId: p.predictionId,
    agentId: p.agentId,
    decision: p.decision,
    direction: p.direction,
    confidenceScore: p.confidenceScore ?? 0,
    slSuggestion: p.slSuggestion,
    tpSuggestion: p.tpSuggestion,
    entryZone: p.entryZone,
    invalidationZone: p.invalidationZone,
    reasoningSummary: p.reasoningSummary,
  };
}

/**
 * Resolve + score a batch of pending predictions. Idempotent per prediction:
 * once `outcomeStatus` leaves PENDING it is never re-scored.
 */
export async function resolveAndScorePending(opts: { limit?: number } = {}): Promise<ResolveScoreResult> {
  const limit = opts.limit ?? 100;
  const now = new Date();

  const pending = await db.select().from(agentPredictionsTable)
    .where(and(
      eq(agentPredictionsTable.locked, true),
      or(isNull(agentPredictionsTable.outcomeStatus), eq(agentPredictionsTable.outcomeStatus, "PENDING")),
    ))
    .orderBy(asc(agentPredictionsTable.id))
    .limit(limit);

  let resolved = 0, scored = 0;

  for (const p of pending) {
    const ev = await gatherEvidence(p, now);
    const resolution = resolvePredictionOutcome({ decision: p.decision, direction: p.direction }, ev);
    if (!resolution.resolvable) continue;

    // Mark the prediction resolved (the locked body stays immutable — only the
    // append-only outcome columns are written; truth-lock permits this).
    await db.update(agentPredictionsTable)
      .set({ outcomeStatus: resolution.status, outcomeReviewedAt: now })
      .where(eq(agentPredictionsTable.id, p.id));
    resolved++;

    // Score it (no prior calibration history wired yet -> neutral calibration).
    const review = scoreTradeReview({
      prediction: toReviewablePrediction(p),
      outcome: {
        realizedOutcome: resolution.status as ReviewRealizedOutcome,
        realizedPnlR: resolution.pnlR,
      },
      calibrationHistory: [],
      now,
    });

    await db.insert(agentPredictionReviewsTable).values({
      reviewId: randomUUID(),
      predictionId: p.predictionId,
      agentId: p.agentId,
      reviewType: "OUTCOME",
      decisionQuality: review.decisionQuality,
      outcomeScore: review.outcomeScore,
      protectionScore: review.protectionScore,
      speedScore: review.speedScore,
      usefulnessScore: review.usefulnessScore,
      calibrationScore: review.calibrationScore,
      scoreDelta: review.scoreDelta,
      grade: review.grade,
      rewardTags: JSON.stringify(review.rewardTags),
      penaltyTags: JSON.stringify(review.penaltyTags),
      realizedOutcome: review.realizedOutcome,
      realizedPnlR: review.realizedPnlR,
      rationale: review.rationale,
      evidence: JSON.stringify({ ...ev, resolutionReason: resolution.reason, rEstimate: "estimated_from_levels" }),
    });
    scored++;

    // Nudge the agent's rolling aggregates (advisory scores only).
    const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, p.agentId)).limit(1);
    if (agent) {
      const agg = nextAggregates({
        current: {
          qualityScore: agent.qualityScore ?? 50,
          speedScore: agent.speedScore ?? 50,
          protectionScore: agent.protectionScore ?? 50,
          usefulnessScore: agent.usefulnessScore ?? 50,
          calibrationScore: agent.calibrationScore ?? 50,
          trustScore: agent.trustScore ?? 50,
        },
        review,
      });
      await db.update(agentsTable)
        .set({ ...agg, updatedAt: now })
        .where(eq(agentsTable.id, p.agentId));
    }
  }

  const stillPending = await db.select({ id: agentPredictionsTable.id }).from(agentPredictionsTable)
    .where(and(
      eq(agentPredictionsTable.locked, true),
      or(isNull(agentPredictionsTable.outcomeStatus), eq(agentPredictionsTable.outcomeStatus, "PENDING")),
    ));

  return { scanned: pending.length, resolved, scored, pendingLeft: stillPending.length };
}
