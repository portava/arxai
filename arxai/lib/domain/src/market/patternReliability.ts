// ── CHART PATTERN RELIABILITY — PURE AGGREGATION (Task #617, Phase 7) ─────────
//
// PURE, deterministic aggregation of recorded pattern OUTCOMES into reliability
// statistics: win rate, false-positive rate, average realized R, MFE/MAE,
// best/worst session and market, a 0–100 reliability score, and a BOUNDED Ruby
// confidence ADJUSTMENT. No IO, no DB, no clock — same inputs ⇒ same output.
//
// ── SAFETY: still subject to the Pattern Truth hard boundary ──────────────────
// The reliability score and the confidence adjustment this module produces are
// DISPLAY / DECISION-SUPPORT signals ONLY. The adjustment is clamped to a small
// symmetric band so it can colour Ruby's wording / confidence WITHIN the caller's
// existing caps — it can NEVER produce READY_NOW, override feed/sufficiency/
// trade-health/risk gates, or reach a live-execution path. Synthetic-market rows
// are aggregated SEPARATELY from forex/indices because their behaviour differs.

/** One resolved (or pending) pattern outcome, the minimal shape aggregation needs. */
export interface PatternOutcomeSample {
  symbol: string;
  timeframe: string;
  session: string | null; // asian | london | overlap | newyork | null
  isSynthetic: boolean;
  patternId: string;
  bias: string;
  /** Graded verdict — only evidence-resolved rows count toward stats. */
  outcome: PatternOutcomeGrade;
  realizedR: number | null;
  mfeR: number | null;
  maeR: number | null;
}

export type PatternOutcomeGrade =
  | "PENDING"
  | "WIN"
  | "LOSS"
  | "BREAKEVEN"
  | "FALSE_POSITIVE"
  | "INVALIDATED"
  | "EXPIRED"
  | "UNRESOLVED";

/** A row counts as RESOLVED (graded) only on real evidence. */
const RESOLVED_GRADES: ReadonlySet<PatternOutcomeGrade> = new Set([
  "WIN",
  "LOSS",
  "BREAKEVEN",
  "FALSE_POSITIVE",
  "INVALIDATED",
]);

/** Outcomes counted as a "win" for win-rate purposes. */
const WIN_GRADES: ReadonlySet<PatternOutcomeGrade> = new Set(["WIN"]);

/** Outcomes counted as a false positive (confirmed look, immediately failed). */
const FALSE_POSITIVE_GRADES: ReadonlySet<PatternOutcomeGrade> = new Set([
  "FALSE_POSITIVE",
  "INVALIDATED",
]);

export interface PatternReliabilityBucket {
  /** Group key — symbol, timeframe, session, or market for the relevant report. */
  key: string;
  resolvedCount: number;
  wins: number;
  losses: number;
  falsePositives: number;
  /** 0–1; null until at least one resolved sample. */
  winRate: number | null;
  /** 0–1; null until at least one resolved sample. */
  falsePositiveRate: number | null;
  avgRealizedR: number | null;
  avgMfeR: number | null;
  avgMaeR: number | null;
}

export interface PatternReliabilityReport {
  /** "forex_indices" (forex + indices) or "synthetic" — tracked separately. */
  market: PatternMarketClass;
  totalSamples: number;
  resolvedCount: number;
  overall: PatternReliabilityBucket;
  bySymbol: PatternReliabilityBucket[];
  byTimeframe: PatternReliabilityBucket[];
  bySession: PatternReliabilityBucket[];
  byPattern: PatternReliabilityBucket[];
  bestSession: string | null;
  worstSession: string | null;
  /** 0–100 reliability score (null until enough resolved evidence). */
  reliabilityScore: number | null;
  /** Bounded Ruby confidence adjustment, clamped to ±MAX_CONFIDENCE_ADJUSTMENT. */
  rubyConfidenceAdjustment: number;
}

export type PatternMarketClass = "forex_indices" | "synthetic";

/**
 * Hard cap on how far reliability may move Ruby's confidence. Display-only and
 * intentionally small: it COLOURS wording within existing caps and can never
 * unlock a gate. Symmetric (penalty as large as the bonus).
 */
export const MAX_CONFIDENCE_ADJUSTMENT = 8;

/** Minimum resolved samples before a reliability score / adjustment is trusted. */
export const MIN_RESOLVED_FOR_SCORE = 5;

function isResolved(g: PatternOutcomeGrade): boolean {
  return RESOLVED_GRADES.has(g);
}

function avg(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function round(value: number | null, dp: number): number | null {
  if (value === null) return null;
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

function buildBucket(key: string, samples: PatternOutcomeSample[]): PatternReliabilityBucket {
  const resolved = samples.filter((s) => isResolved(s.outcome));
  const wins = resolved.filter((s) => WIN_GRADES.has(s.outcome)).length;
  const losses = resolved.filter((s) => s.outcome === "LOSS").length;
  const falsePositives = resolved.filter((s) => FALSE_POSITIVE_GRADES.has(s.outcome)).length;
  const n = resolved.length;
  return {
    key,
    resolvedCount: n,
    wins,
    losses,
    falsePositives,
    winRate: n > 0 ? round(wins / n, 4) : null,
    falsePositiveRate: n > 0 ? round(falsePositives / n, 4) : null,
    avgRealizedR: round(
      avg(resolved.map((s) => s.realizedR)),
      3,
    ),
    avgMfeR: round(avg(resolved.map((s) => s.mfeR)), 3),
    avgMaeR: round(avg(resolved.map((s) => s.maeR)), 3),
  };
}

function groupBy(
  samples: PatternOutcomeSample[],
  keyFn: (s: PatternOutcomeSample) => string | null,
): PatternReliabilityBucket[] {
  const map = new Map<string, PatternOutcomeSample[]>();
  for (const s of samples) {
    const k = keyFn(s);
    if (k === null || k === "") continue;
    const list = map.get(k) ?? [];
    list.push(s);
    map.set(k, list);
  }
  // Deterministic order: sort keys ascending.
  return [...map.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((k) => buildBucket(k, map.get(k)!));
}

/**
 * Reliability score 0–100 blending win rate, average R and (inverse)
 * false-positive rate. Returns null until MIN_RESOLVED_FOR_SCORE resolved
 * samples — never guesses off a tiny sample.
 */
function reliabilityScore(overall: PatternReliabilityBucket): number | null {
  if (overall.resolvedCount < MIN_RESOLVED_FOR_SCORE) return null;
  const winRate = overall.winRate ?? 0; // 0–1
  const fpRate = overall.falsePositiveRate ?? 0; // 0–1
  // Map avg R (typically -1..+3) into 0..1 around a neutral 1R.
  const r = overall.avgRealizedR ?? 0;
  const rComponent = Math.max(0, Math.min(1, (r + 1) / 4));
  const raw = 0.5 * winRate + 0.3 * rComponent + 0.2 * (1 - fpRate);
  return round(Math.max(0, Math.min(1, raw)) * 100, 1);
}

/**
 * Bounded Ruby confidence adjustment from a reliability score. Centred on a
 * neutral score of 50 and clamped to ±MAX_CONFIDENCE_ADJUSTMENT. Returns 0 when
 * there is not enough resolved evidence (never a default bonus).
 */
function confidenceAdjustment(score: number | null): number {
  if (score === null) return 0;
  const centred = (score - 50) / 50; // -1..+1
  const adj = centred * MAX_CONFIDENCE_ADJUSTMENT;
  const clamped = Math.max(-MAX_CONFIDENCE_ADJUSTMENT, Math.min(MAX_CONFIDENCE_ADJUSTMENT, adj));
  return round(clamped, 2)!;
}

/** Best/worst session by win rate among sessions with resolved samples. */
function bestWorstSession(bySession: PatternReliabilityBucket[]): {
  best: string | null;
  worst: string | null;
} {
  const ranked = bySession
    .filter((b) => b.resolvedCount > 0 && b.winRate !== null)
    .sort((a, b) => (b.winRate! - a.winRate!) || a.key.localeCompare(b.key));
  if (ranked.length === 0) return { best: null, worst: null };
  return { best: ranked[0]!.key, worst: ranked[ranked.length - 1]!.key };
}

/**
 * Classify a sample's market for separate aggregation: synthetic rows on their
 * own; everything else (forex + indices) together.
 */
export function patternMarketClass(isSynthetic: boolean): PatternMarketClass {
  return isSynthetic ? "synthetic" : "forex_indices";
}

/**
 * Aggregate ONE market class's samples into a reliability report. The caller is
 * responsible for splitting synthetic from forex/indices (use
 * `aggregatePatternReliability` for both at once).
 */
export function aggregatePatternMarket(
  market: PatternMarketClass,
  samples: PatternOutcomeSample[],
): PatternReliabilityReport {
  const overall = buildBucket("overall", samples);
  const bySession = groupBy(samples, (s) => s.session);
  const { best, worst } = bestWorstSession(bySession);
  const score = reliabilityScore(overall);
  return {
    market,
    totalSamples: samples.length,
    resolvedCount: overall.resolvedCount,
    overall,
    bySymbol: groupBy(samples, (s) => s.symbol),
    byTimeframe: groupBy(samples, (s) => s.timeframe),
    bySession,
    byPattern: groupBy(samples, (s) => s.patternId),
    bestSession: best,
    worstSession: worst,
    reliabilityScore: score,
    rubyConfidenceAdjustment: confidenceAdjustment(score),
  };
}

/**
 * Aggregate a mixed set of samples into TWO separate reports — forex/indices and
 * synthetic — because synthetic-index behaviour must never be blended into the
 * real-market reliability picture.
 */
export function aggregatePatternReliability(samples: PatternOutcomeSample[]): {
  forexIndices: PatternReliabilityReport;
  synthetic: PatternReliabilityReport;
} {
  const synthetic: PatternOutcomeSample[] = [];
  const forexIndices: PatternOutcomeSample[] = [];
  for (const s of samples) {
    (s.isSynthetic ? synthetic : forexIndices).push(s);
  }
  return {
    forexIndices: aggregatePatternMarket("forex_indices", forexIndices),
    synthetic: aggregatePatternMarket("synthetic", synthetic),
  };
}
