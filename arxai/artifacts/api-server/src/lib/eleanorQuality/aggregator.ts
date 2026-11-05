// Task #199 — Eleanor Quality: Part-42 metrics aggregation (read-only).
//
// SAFETY / SCOPE:
//   - READ-ONLY. Loads outcome rows and runs the pure Part-42 metrics engine.
//   - Per-user isolation: `forUser` scopes to one userId. The admin variant
//     reads across users for the operator dashboard ONLY (mounted behind the
//     admin gate). No admin-only detail is ever returned by the user path.

import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  db,
  eleanorSignalOutcomesTable,
  type EleanorSignalOutcomeRow,
} from "@workspace/db";
import {
  computeEleanorQualityMetrics,
  computeEleanorCalibration,
  type QualitySampleRow,
  type EleanorQualityMetrics,
  type CalibrationSampleRow,
  type EleanorCalibrationRollup,
  type SignalOutcomeStatus,
  type TimingClass,
  type ExitReason,
} from "@workspace/domain/eleanor-quality";

export interface QualityFilter {
  userId?: number;
  symbol?: string;
  session?: string;
  decision?: string;
  fromMs?: number;
  toMs?: number;
  limit?: number;
}

function toSample(r: EleanorSignalOutcomeRow): QualitySampleRow {
  return {
    symbol: r.symbol,
    session: r.session,
    decision: r.decision,
    direction: r.direction,
    outcomeStatus: r.outcomeStatus as SignalOutcomeStatus,
    pnlR: r.pnlR,
    timingClass: (r.timingClass as TimingClass | null) ?? null,
    exitReason: (r.exitReason as ExitReason | null) ?? null,
    newsNearby: r.newsNearby,
    userEntered: r.userEntered,
    explanationUsed: r.explanationUsed,
    noTradeCredited: r.noTradeCredited,
    confidenceScore: r.confidenceScore,
    edgeScore: r.edgeScore,
    spreadAtSignal: r.spreadAtSignal,
    expectedSlippage: r.expectedSlippage,
    actualSlippage: r.actualSlippage,
    expectedStartDrawdown: r.expectedStartDrawdown,
    actualStartDrawdown: r.actualStartDrawdown,
    maxFavorableExcursion: r.maxFavorableExcursion,
    maxAdverseExcursion: r.maxAdverseExcursion,
  };
}

export async function loadOutcomeRows(filter: QualityFilter): Promise<EleanorSignalOutcomeRow[]> {
  const conds: SQL[] = [];
  if (filter.userId != null) conds.push(eq(eleanorSignalOutcomesTable.userId, filter.userId));
  if (filter.symbol) conds.push(eq(eleanorSignalOutcomesTable.symbol, filter.symbol));
  if (filter.session) conds.push(eq(eleanorSignalOutcomesTable.session, filter.session));
  if (filter.decision) conds.push(eq(eleanorSignalOutcomesTable.decision, filter.decision));
  if (filter.fromMs != null) conds.push(gte(eleanorSignalOutcomesTable.createdAt, new Date(filter.fromMs)));
  if (filter.toMs != null) conds.push(lte(eleanorSignalOutcomesTable.createdAt, new Date(filter.toMs)));

  return db.select().from(eleanorSignalOutcomesTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(eleanorSignalOutcomesTable.createdAt))
    .limit(Math.min(filter.limit ?? 2000, 5000));
}

export async function computeQualityMetrics(filter: QualityFilter): Promise<EleanorQualityMetrics> {
  const rows = await loadOutcomeRows(filter);
  return computeEleanorQualityMetrics(rows.map(toSample));
}

export interface CalibrationFilter extends QualityFilter {
  minSample?: number;
}

function toCalibrationSample(r: EleanorSignalOutcomeRow): CalibrationSampleRow {
  return {
    timeframe: r.timeframe,
    confidenceScore: r.confidenceScore,
    outcomeStatus: r.outcomeStatus as SignalOutcomeStatus,
  };
}

// Read-only calibration roll-up over EXISTING resolved outcomes. Reuses the same
// per-user-scoped loader as the metrics path; the pure engine does all grouping.
export async function computeCalibrationRollup(
  filter: CalibrationFilter,
): Promise<EleanorCalibrationRollup> {
  const rows = await loadOutcomeRows(filter);
  return computeEleanorCalibration(rows.map(toCalibrationSample), { minSample: filter.minSample });
}
