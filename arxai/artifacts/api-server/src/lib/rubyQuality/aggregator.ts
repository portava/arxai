// Task #199 — Ruby Quality: Part-42 metrics aggregation (read-only).
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
  rubySignalOutcomesTable,
  type RubySignalOutcomeRow,
} from "@workspace/db";
import {
  computeRubyQualityMetrics,
  computeRubyCalibration,
  type QualitySampleRow,
  type RubyQualityMetrics,
  type CalibrationSampleRow,
  type RubyCalibrationRollup,
  type SignalOutcomeStatus,
  type TimingClass,
  type ExitReason,
} from "@workspace/domain/ruby-quality";

export interface QualityFilter {
  userId?: number;
  symbol?: string;
  session?: string;
  decision?: string;
  fromMs?: number;
  toMs?: number;
  limit?: number;
}

function toSample(r: RubySignalOutcomeRow): QualitySampleRow {
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

export async function loadOutcomeRows(filter: QualityFilter): Promise<RubySignalOutcomeRow[]> {
  const conds: SQL[] = [];
  if (filter.userId != null) conds.push(eq(rubySignalOutcomesTable.userId, filter.userId));
  if (filter.symbol) conds.push(eq(rubySignalOutcomesTable.symbol, filter.symbol));
  if (filter.session) conds.push(eq(rubySignalOutcomesTable.session, filter.session));
  if (filter.decision) conds.push(eq(rubySignalOutcomesTable.decision, filter.decision));
  if (filter.fromMs != null) conds.push(gte(rubySignalOutcomesTable.createdAt, new Date(filter.fromMs)));
  if (filter.toMs != null) conds.push(lte(rubySignalOutcomesTable.createdAt, new Date(filter.toMs)));

  return db.select().from(rubySignalOutcomesTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(rubySignalOutcomesTable.createdAt))
    .limit(Math.min(filter.limit ?? 2000, 5000));
}

export async function computeQualityMetrics(filter: QualityFilter): Promise<RubyQualityMetrics> {
  const rows = await loadOutcomeRows(filter);
  return computeRubyQualityMetrics(rows.map(toSample));
}

export interface CalibrationFilter extends QualityFilter {
  minSample?: number;
}

function toCalibrationSample(r: RubySignalOutcomeRow): CalibrationSampleRow {
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
): Promise<RubyCalibrationRollup> {
  const rows = await loadOutcomeRows(filter);
  return computeRubyCalibration(rows.map(toCalibrationSample), { minSample: filter.minSample });
}
