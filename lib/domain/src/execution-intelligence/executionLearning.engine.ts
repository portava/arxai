// ═══════════════════════════════════════════════════════════════════════════
// Execution Learning
//
// Aggregates PostTradeExecutionReports into per-(symbol, session, strategy)
// buckets and surfaces the worst-offending dimensions.
//
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import {
  type PostTradeExecutionReport,
  type ExecutionLearningReport,
  type ExecutionBucketStats,
  type SymbolId, type SessionId, type StrategyId,
  clamp01,
} from "./executionIntelligence.types";
import { gradeNumeric } from "./executionQualityGrade.engine";

function key(r: PostTradeExecutionReport): string {
  return `${r.symbolId}|${r.session}|${r.strategyId}`;
}

export function buildExecutionLearningReport(
  reports: PostTradeExecutionReport[],
): ExecutionLearningReport {
  const reasons: string[] = [];
  const buckets = new Map<string, PostTradeExecutionReport[]>();
  for (const r of reports) {
    const k = key(r);
    const arr = buckets.get(k) ?? [];
    arr.push(r);
    buckets.set(k, arr);
  }

  const bucketStats: ExecutionBucketStats[] = [];
  for (const [, arr] of buckets) {
    const sample = arr.length;
    const avgShortfallPips = arr.reduce((s, r) => s + r.implementationShortfallPips, 0) / sample;
    const avgGradeNumeric  = arr.reduce((s, r) => s + gradeNumeric(r.grade), 0) / sample;
    const costly = arr.filter(r => r.verdict === "EXECUTION_COSTLY"
                                || r.verdict === "EXECUTION_UNSTABLE"
                                || r.verdict === "EXECUTION_BLOCKED").length;
    const worst3 = [...arr]
      .sort((a, b) => b.implementationShortfallPips - a.implementationShortfallPips)
      .slice(0, 3)
      .map(r => r.decisionId);
    bucketStats.push({
      key: { symbolId: arr[0].symbolId, session: arr[0].session, strategyId: arr[0].strategyId },
      sample,
      avgShortfallPips,
      avgGradeNumeric,
      costlyRate01: clamp01(costly / sample),
      worst3Decisions: worst3,
    });
  }

  // Aggregate by single dimension to find worst offenders.
  const dim = <K extends string>(get: (r: PostTradeExecutionReport) => K): Map<K, number[]> => {
    const m = new Map<K, number[]>();
    for (const r of reports) {
      const k = get(r);
      const arr = m.get(k) ?? [];
      arr.push(r.implementationShortfallPips);
      m.set(k, arr);
    }
    return m;
  };
  const meanOf = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
  const worstNFromMap = <K>(m: Map<K, number[]>, minSample = 1, n = 3): K[] =>
    [...m.entries()]
      .filter(([, xs]) => xs.length >= minSample)
      .sort((a, b) => meanOf(b[1]) - meanOf(a[1]))
      .slice(0, n)
      .map(([k]) => k);

  const worstSymbols    = worstNFromMap(dim<SymbolId>(r => r.symbolId));
  const worstSessions   = worstNFromMap(dim<SessionId>(r => r.session));
  const worstStrategies = worstNFromMap(dim<StrategyId>(r => r.strategyId));

  reasons.push(`n=${reports.length} reports across ${bucketStats.length} bucket(s)`);
  if (worstSymbols.length)    reasons.push(`worst symbols: ${worstSymbols.join(", ")}`);
  if (worstSessions.length)   reasons.push(`worst sessions: ${worstSessions.join(", ")}`);
  if (worstStrategies.length) reasons.push(`worst strategies: ${worstStrategies.join(", ")}`);

  return {
    totalSample: reports.length,
    buckets: bucketStats,
    worstSymbols, worstSessions, worstStrategies,
    reasons,
  };
}
