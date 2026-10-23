// Task #649 — Trendline Truth learning loop (DB side).
//
// Records every detected trendline as an OBSERVATION, resolves it ONLY on real
// evidence (a matched closed trade or an observed decisive move past the
// confirmation / invalidation level), and rolls the recorded outcomes into the
// pure reliability aggregation (`aggregateTrendlineReliability`) that feeds Ruby's
// bounded confidence adjustment.
//
// SAFETY / honesty:
//  - Per-user isolation: EVERY read and write is scoped by userId.
//  - OBSERVATION ONLY: nothing here places, modifies, sizes or closes an order,
//    and nothing touches the MT5 bridge or the live (16-gate) pipeline.
//  - FAIL-CLOSED resolution: elapsed time alone NEVER grades a row. A row stays
//    PENDING until real evidence arrives.
//  - The "at detection" snapshot is frozen once `locked=true`; later facts are
//    appended (never an in-place rewrite of the original observation).
//  - Synthetic-market rows are aggregated SEPARATELY from forex/indices.

import { and, eq, sql } from "drizzle-orm";
import {
  db,
  trendlineOutcomesTable,
  type TrendlineOutcome,
  type NewTrendlineOutcome,
} from "@workspace/db";
import {
  aggregateTrendlineReliability,
  currentSession,
  type Session,
  type TrendlineOutcomeGrade,
  type TrendlineOutcomeSample,
  type TrendlineReliabilityReport,
} from "@workspace/domain/market";

/** Map the engine's FX session enum to the learning-loop session vocabulary. */
export function toLearningSession(session: Session): string | null {
  switch (session) {
    case "ASIA":
      return "asian";
    case "LONDON":
      return "london";
    case "NEW_YORK":
      return "newyork";
    case "OVERLAP_LONDON_NY":
      return "overlap";
    case "OFF_HOURS":
    default:
      return null;
  }
}

export interface RecordTrendlineDetectionArgs {
  userId: number;
  outcomeId: string; // stable id for this detection observation
  symbol: string;
  displayName?: string | null;
  assetClass?: string | null;
  isSynthetic?: boolean;
  timeframe: string;
  trendlineId: string;
  trendlineName: string;
  trendlineCategory?: string | null;
  bias?: string;
  statusAtDetection: string;
  qualityAtDetection?: string | null;
  confidenceAtDetection?: number;
  feedStatusAtDetection?: string;
  confirmationLevel?: number | null;
  invalidationLevel?: number | null;
  targetLevel?: number | null;
  entryPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  spreadAtDetection?: number | null;
  newsNearby?: boolean;
  newsWindowMinutes?: number | null;
  detectedAt?: Date;
  extra?: unknown;
}

/**
 * Record (or no-op upsert of) a detected-trendline observation. Idempotent on
 * (userId, outcomeId): a repeat detection of the SAME observation does NOT
 * overwrite a locked snapshot — it only refreshes the at-detection fields while
 * the row is still unlocked.
 */
export async function recordTrendlineDetection(
  args: RecordTrendlineDetectionArgs,
): Promise<TrendlineOutcome> {
  const row: NewTrendlineOutcome = {
    userId: args.userId,
    outcomeId: args.outcomeId,
    symbol: args.symbol,
    displayName: args.displayName ?? null,
    assetClass: args.assetClass ?? null,
    isSynthetic: args.isSynthetic ?? false,
    timeframe: args.timeframe,
    session: args.detectedAt
      ? toLearningSession(currentSession(args.detectedAt))
      : toLearningSession(currentSession()),
    trendlineId: args.trendlineId,
    trendlineName: args.trendlineName,
    trendlineCategory: args.trendlineCategory ?? null,
    bias: args.bias ?? "neutral",
    statusAtDetection: args.statusAtDetection,
    qualityAtDetection: args.qualityAtDetection ?? null,
    confidenceAtDetection: args.confidenceAtDetection ?? 0,
    feedStatusAtDetection: args.feedStatusAtDetection ?? "UNCONFIRMED",
    confirmationLevel: args.confirmationLevel ?? null,
    invalidationLevel: args.invalidationLevel ?? null,
    targetLevel: args.targetLevel ?? null,
    entryPrice: args.entryPrice ?? null,
    stopLoss: args.stopLoss ?? null,
    takeProfit: args.takeProfit ?? null,
    spreadAtDetection: args.spreadAtDetection ?? null,
    newsNearby: args.newsNearby ?? false,
    newsWindowMinutes: args.newsWindowMinutes ?? null,
    detectedAt: args.detectedAt ?? new Date(),
    extra: (args.extra ?? null) as NewTrendlineOutcome["extra"],
    updatedAt: new Date(),
  };

  const [inserted] = await db
    .insert(trendlineOutcomesTable)
    .values(row)
    .onConflictDoUpdate({
      target: [trendlineOutcomesTable.userId, trendlineOutcomesTable.outcomeId],
      // Only refresh at-detection fields while still UNLOCKED. Once locked, the
      // snapshot is immutable and this update is a no-op for those columns.
      set: {
        statusAtDetection: sql`CASE WHEN ${trendlineOutcomesTable.locked} THEN ${trendlineOutcomesTable.statusAtDetection} ELSE excluded.status_at_detection END`,
        qualityAtDetection: sql`CASE WHEN ${trendlineOutcomesTable.locked} THEN ${trendlineOutcomesTable.qualityAtDetection} ELSE excluded.quality_at_detection END`,
        confidenceAtDetection: sql`CASE WHEN ${trendlineOutcomesTable.locked} THEN ${trendlineOutcomesTable.confidenceAtDetection} ELSE excluded.confidence_at_detection END`,
        feedStatusAtDetection: sql`CASE WHEN ${trendlineOutcomesTable.locked} THEN ${trendlineOutcomesTable.feedStatusAtDetection} ELSE excluded.feed_status_at_detection END`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return inserted!;
}

export interface ResolveTrendlineOutcomeArgs {
  userId: number;
  outcomeId: string;
  outcome: TrendlineOutcomeGrade; // must be an evidence-graded value
  outcomeReason?: string | null;
  realizedR?: number | null;
  mfeR?: number | null;
  maeR?: number | null;
  tradeId?: number | null;
  confirmedAt?: Date | null;
  postTradeReview?: string | null;
}

/** Grades that represent real, evidence-backed resolution (not time-elapsed). */
const EVIDENCE_GRADES: ReadonlySet<TrendlineOutcomeGrade> = new Set([
  "WIN",
  "LOSS",
  "BREAKEVEN",
  "FALSE_POSITIVE",
  "INVALIDATED",
]);

/**
 * Append an evidence-resolved outcome and LOCK the snapshot. Refuses to grade a
 * row with a non-evidence value (PENDING/EXPIRED/UNRESOLVED stay un-graded —
 * fail-closed: elapsed time alone never produces a graded verdict here).
 */
export async function resolveTrendlineOutcome(
  args: ResolveTrendlineOutcomeArgs,
): Promise<TrendlineOutcome | null> {
  if (!EVIDENCE_GRADES.has(args.outcome)) {
    throw new Error(
      `resolveTrendlineOutcome: ${args.outcome} is not an evidence grade — elapsed time alone cannot grade a trendline outcome.`,
    );
  }
  const [updated] = await db
    .update(trendlineOutcomesTable)
    .set({
      outcome: args.outcome,
      outcomeReason: args.outcomeReason ?? null,
      realizedR: args.realizedR ?? null,
      maxFavorableExcursionR: args.mfeR ?? null,
      maxAdverseExcursionR: args.maeR ?? null,
      tradeId: args.tradeId ?? null,
      confirmedAt: args.confirmedAt ?? null,
      postTradeReview: args.postTradeReview ?? null,
      locked: true,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(trendlineOutcomesTable.userId, args.userId),
        eq(trendlineOutcomesTable.outcomeId, args.outcomeId),
      ),
    )
    .returning();
  return updated ?? null;
}

function toSample(row: TrendlineOutcome): TrendlineOutcomeSample {
  return {
    symbol: row.symbol,
    timeframe: row.timeframe,
    session: row.session,
    isSynthetic: row.isSynthetic,
    trendlineId: row.trendlineId,
    bias: row.bias,
    outcome: row.outcome as TrendlineOutcomeGrade,
    realizedR: row.realizedR,
    mfeR: row.maxFavorableExcursionR,
    maeR: row.maxAdverseExcursionR,
  };
}

/**
 * Load a user's recorded trendline outcomes and aggregate them into separate
 * forex/indices and synthetic reliability reports. Per-user scoped.
 */
export async function buildTrendlineReliability(userId: number): Promise<{
  forexIndices: TrendlineReliabilityReport;
  synthetic: TrendlineReliabilityReport;
}> {
  const rows = await db
    .select()
    .from(trendlineOutcomesTable)
    .where(eq(trendlineOutcomesTable.userId, userId));
  return aggregateTrendlineReliability(rows.map(toSample));
}
