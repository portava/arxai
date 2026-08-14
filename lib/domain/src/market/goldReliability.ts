// ── GOLD RELIABILITY STATS — PURE (Task #657) ───────────────────────────────
//
// PURE aggregation of gold setup OUTCOMES into reliability stats by session and
// setup type: win / false-break / wick-failure / sweep-success / breakout-retest
// / news-window rates, plus "too-late avoided" counts. Mirrors the evidence
// discipline of patternReliability — only rows resolved on REAL evidence count,
// and a score/adjustment needs a minimum resolved sample.
//
// ── SAFETY ──────────────────────────────────────────────────────────────────
// DISPLAY / DECISION-SUPPORT only. Stats COLOUR confidence within the existing
// caps (bounded ±MAX_CONFIDENCE_ADJUSTMENT) and can never unlock a gate. No IO,
// no clock. Insufficient evidence ⇒ null rates / null score (never a fabricated
// "reliable" reading).

import {
  MAX_CONFIDENCE_ADJUSTMENT,
  MIN_RESOLVED_FOR_SCORE,
  type PatternOutcomeGrade,
} from "./patternReliability";
import type { GoldSession } from "./goldSessionContract";
import type { GoldTactic } from "./goldTacticsContract";

/** Whether the SETUP played out — only evidence-resolved rows count. */
export type GoldSetupOutcome =
  | "PENDING"
  | "WIN"
  | "LOSS"
  | "FALSE_BREAK"
  | "WICK_FAILURE"
  | "SWEEP_SUCCESS"
  | "BREAKOUT_RETEST_HELD"
  | "NEWS_WINDOW_BLOCKED"
  | "TOO_LATE_AVOIDED"
  | "UNRESOLVED";

export interface GoldOutcomeSample {
  symbol: string;
  timeframe: string;
  session: GoldSession | null;
  setupType: GoldTactic;
  outcome: GoldSetupOutcome;
  realizedR: number | null;
}

const RESOLVED: ReadonlySet<GoldSetupOutcome> = new Set([
  "WIN",
  "LOSS",
  "FALSE_BREAK",
  "WICK_FAILURE",
  "SWEEP_SUCCESS",
  "BREAKOUT_RETEST_HELD",
]);

export interface GoldReliabilityBucket {
  key: string;
  resolvedCount: number;
  wins: number;
  /** 0–1; null until at least one resolved sample. */
  winRate: number | null;
  falseBreakRate: number | null;
  wickFailureRate: number | null;
  sweepSuccessRate: number | null;
  breakoutRetestRate: number | null;
  avgRealizedR: number | null;
}

export interface GoldReliabilityReport {
  totalSamples: number;
  resolvedCount: number;
  /** Defensive (non-graded) observations, tracked separately, never as losses. */
  newsWindowBlocked: number;
  tooLateAvoided: number;
  overall: GoldReliabilityBucket;
  bySession: GoldReliabilityBucket[];
  bySetupType: GoldReliabilityBucket[];
  bestSession: string | null;
  worstSession: string | null;
  /** 0–100; null until enough resolved evidence. */
  reliabilityScore: number | null;
  /** Bounded ±MAX_CONFIDENCE_ADJUSTMENT confidence nudge. */
  confidenceAdjustment: number;
}

function rate(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}

function avg(xs: number[]): number | null {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function buildBucket(key: string, rows: GoldOutcomeSample[]): GoldReliabilityBucket {
  const resolved = rows.filter((r) => RESOLVED.has(r.outcome));
  const d = resolved.length;
  const wins = resolved.filter((r) => r.outcome === "WIN" || r.outcome === "SWEEP_SUCCESS" || r.outcome === "BREAKOUT_RETEST_HELD").length;
  const realizedRs = resolved
    .map((r) => r.realizedR)
    .filter((x): x is number => x != null && Number.isFinite(x));
  return {
    key,
    resolvedCount: d,
    wins,
    winRate: rate(wins, d),
    falseBreakRate: rate(resolved.filter((r) => r.outcome === "FALSE_BREAK").length, d),
    wickFailureRate: rate(resolved.filter((r) => r.outcome === "WICK_FAILURE").length, d),
    sweepSuccessRate: rate(resolved.filter((r) => r.outcome === "SWEEP_SUCCESS").length, d),
    breakoutRetestRate: rate(resolved.filter((r) => r.outcome === "BREAKOUT_RETEST_HELD").length, d),
    avgRealizedR: avg(realizedRs),
  };
}

function groupBy<K extends string>(
  rows: GoldOutcomeSample[],
  keyFn: (r: GoldOutcomeSample) => K | null,
): GoldReliabilityBucket[] {
  const map = new Map<string, GoldOutcomeSample[]>();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    const arr = map.get(k) ?? [];
    arr.push(r);
    map.set(k, arr);
  }
  return [...map.entries()].map(([k, rs]) => buildBucket(k, rs));
}

/**
 * Aggregate gold outcome samples into a reliability report. Pure. Only resolved
 * rows feed rates; news-window-blocked and too-late-avoided are tracked as
 * DEFENSIVE observations (never counted as losses). The confidence adjustment is
 * clamped to ±MAX_CONFIDENCE_ADJUSTMENT and stays 0 until MIN_RESOLVED_FOR_SCORE.
 */
export function aggregateGoldReliability(samples: GoldOutcomeSample[]): GoldReliabilityReport {
  const overall = buildBucket("overall", samples);
  const bySession = groupBy(samples, (r) => r.session);
  const bySetupType = groupBy(samples, (r) => r.setupType);

  const ranked = bySession
    .filter((b) => b.winRate != null)
    .sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0));
  const bestSession = ranked.length > 0 ? ranked[0].key : null;
  const worstSession = ranked.length > 0 ? ranked[ranked.length - 1].key : null;

  let reliabilityScore: number | null = null;
  let confidenceAdjustment = 0;
  if (overall.resolvedCount >= MIN_RESOLVED_FOR_SCORE && overall.winRate != null) {
    reliabilityScore = Math.round(overall.winRate * 100);
    // Map win-rate distance from 50% onto ±MAX_CONFIDENCE_ADJUSTMENT.
    const raw = Math.round((overall.winRate - 0.5) * 2 * MAX_CONFIDENCE_ADJUSTMENT);
    confidenceAdjustment = Math.max(-MAX_CONFIDENCE_ADJUSTMENT, Math.min(MAX_CONFIDENCE_ADJUSTMENT, raw));
  }

  return {
    totalSamples: samples.length,
    resolvedCount: overall.resolvedCount,
    newsWindowBlocked: samples.filter((r) => r.outcome === "NEWS_WINDOW_BLOCKED").length,
    tooLateAvoided: samples.filter((r) => r.outcome === "TOO_LATE_AVOIDED").length,
    overall,
    bySession,
    bySetupType,
    bestSession,
    worstSession,
    reliabilityScore,
    confidenceAdjustment,
  };
}

/** Re-exported for callers that align gold grading with pattern grading. */
export type { PatternOutcomeGrade };
