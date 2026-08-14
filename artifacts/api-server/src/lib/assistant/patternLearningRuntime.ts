// ── CHART PATTERN TRUTH — LEARNING-LOOP RUNTIME (Task #617, Gap C) ────────────
//
// The ONE runtime seam that wires the Pattern Truth learning loop into a live
// request path (Ruby's structural chart read). For every detected dominant
// pattern it:
//   1. RECORDS the detection as an OBSERVATION (fire-and-forget, idempotent on a
//      stable outcomeId) so reliability statistics can accrue over time, and
//   2. reads back the user's accrued reliability and turns it into a BOUNDED,
//      per-market-class confidence ADJUSTMENT the caller may surface beside the
//      pattern read.
//
// ── SAFETY — DISPLAY / DECISION-SUPPORT ONLY (Pattern Truth hard boundary) ────
// This module is best-effort and fail-open. It can ONLY:
//   • record an observation row (no order, no MT5 bridge, no live/16-gate path),
//   • return a confidence nudge clamped to ±MAX_CONFIDENCE_ADJUSTMENT AND capped
//     at the verdict's existing display ceiling (`scannerTruthImpact
//     .confidenceCeiling`) — it can never raise display confidence above what the
//     pure contract already allowed, never produce READY_NOW, and never override
//     a feed / sufficiency / trade-health / risk gate.
// Synthetic-index reliability is aggregated SEPARATELY from forex/indices, so a
// synthetic pattern is only ever coloured by synthetic history (and vice-versa).
// Per-user isolation: a null userId means NO record and NO adjustment.
//
// Honesty on writes: the structural-read service header says "callers decide
// whether to record". This module is exactly that decision — an OBSERVATION-only
// write, fired from the read path, that never participates in execution.

import { clamp } from "../data/chart/engines/chartMath.js";
import { logger } from "../logger.js";
import {
  recordPatternDetection,
  buildPatternReliability,
} from "../data/chart/patternOutcomeService.js";
import {
  MAX_CONFIDENCE_ADJUSTMENT,
  patternMarketClass,
  resolveArxMarket,
  type DetectedPattern,
  type PatternMarketClass,
  type PatternTruthVerdict,
} from "@workspace/domain/market";

export interface PatternLearningResult {
  /** Bounded nudge actually applied (±MAX_CONFIDENCE_ADJUSTMENT, may be < 0). */
  confidenceAdjustment: number;
  /** verdict.confidence + adjustment, clamped to [0, display ceiling]. */
  adjustedConfidence: number;
  /** 0–100 reliability score backing the nudge (null below the sample floor). */
  reliabilityScore: number | null;
  /** Which reliability bucket coloured this pattern (synthetic vs forex/indices). */
  marketClass: PatternMarketClass;
  /** Resolved (evidence-graded) samples behind the score. */
  resolvedSamples: number;
}

/** Whether the symbol is a synthetic index (its history is tracked separately). */
function isSyntheticSymbol(symbol: string): boolean {
  return resolveArxMarket(symbol)?.category === "synthetic";
}

/** Round to a stable 5-dp token (engine prices are already symbol-rounded). */
function r5(n: number | null): string {
  return n == null ? "x" : (Math.round(n * 1e5) / 1e5).toString();
}

/** Tiny deterministic djb2 string hash → base-36 (keeps the outcomeId bounded). */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Order-independent GEOMETRY fingerprint of ONE detection: the role+price of
 * every keypoint, plus the pattern's confirmation/invalidation levels. Prices
 * are already engine-rounded to the symbol's decimals. This signature is
 * INDEX-INDEPENDENT — so it survives candle-array growth and a repeat read of the
 * SAME live pattern (idempotent refresh) — yet DISTINCT for a genuinely different
 * detection (different swing points / levels), so two real detections never
 * collapse into one observation row.
 */
function detectionSignature(p: DetectedPattern): string {
  const points = p.keyPoints
    .map((k) => `${k.role}@${r5(k.price)}`)
    .sort()
    .join("|");
  const levels = `c${r5(p.levels.confirmation)}|i${r5(p.levels.invalidation)}`;
  return djb2(`${points}#${levels}`);
}

/**
 * Stable, idempotent observation id for ONE pattern detection INSTANCE. Keyed on
 * the user-independent facts of the detection (symbol + timeframe + pattern id +
 * its geometry signature) so a repeat read of the SAME live pattern refreshes —
 * never duplicates — its row, while a distinct detection gets its own row.
 */
function buildOutcomeId(
  symbol: string,
  timeframe: string,
  p: DetectedPattern,
): string {
  return `pat:${symbol}:${timeframe}:${p.id}:${detectionSignature(p)}`;
}

/**
 * Record ONE detected pattern as an observation (fire-and-forget). Uses the
 * pattern's OWN status / quality / raw confidence / levels — not the display-
 * folded dominant verdict values — so reliability statistics reflect what each
 * pattern actually printed. A failure here never blocks or throws into the read.
 */
function recordOnePattern(args: {
  userId: number;
  symbol: string;
  displaySymbol?: string | null;
  isSynthetic: boolean;
  timeframe: string;
  pattern: DetectedPattern;
  feedStatusAtDetection?: string;
}): void {
  const { userId, symbol, timeframe, pattern: p } = args;
  void recordPatternDetection({
    userId,
    outcomeId: buildOutcomeId(symbol, timeframe, p),
    symbol,
    displayName: args.displaySymbol ?? symbol,
    isSynthetic: args.isSynthetic,
    timeframe,
    patternId: p.id,
    patternName: p.name,
    patternCategory: p.category,
    bias: p.bias,
    statusAtDetection: p.status,
    qualityAtDetection: p.quality,
    confidenceAtDetection: p.confidence,
    feedStatusAtDetection: args.feedStatusAtDetection,
    confirmationLevel: p.levels.confirmation,
    invalidationLevel: p.levels.invalidation,
    targetLevel: p.levels.targets[0] ?? null,
  }).catch((err) => {
    logger.warn(
      { err, userId, symbol, timeframe, patternId: p.id },
      "patternLearningRuntime: recordPatternDetection failed (observation skipped)",
    );
  });
}

/**
 * Record the detection (fire-and-forget) and return the bounded reliability
 * confidence adjustment for this user + market class. Returns `null` — meaning
 * "surface nothing extra" — when there is no user, no dominant pattern, the
 * reliability read fails, or there is not yet enough resolved history for a
 * non-zero adjustment. Never throws.
 */
export async function applyPatternLearning(args: {
  userId: number | null;
  symbol: string;
  displaySymbol?: string | null;
  timeframe: string;
  verdict: PatternTruthVerdict;
  feedStatusAtDetection?: string;
}): Promise<PatternLearningResult | null> {
  const { userId, symbol, timeframe, verdict } = args;
  const dominant = verdict.dominantPattern;
  if (userId == null || !dominant) return null;

  const isSynthetic = isSyntheticSymbol(symbol);
  const marketClass = patternMarketClass(isSynthetic);

  // 1) OBSERVATION writes — record EVERY detected pattern (not only the dominant),
  //    each on its own per-detection-instance id, so reliability statistics accrue
  //    across the full detected set. Fire-and-forget; failures never block the read.
  for (const pattern of verdict.detectedPatterns) {
    recordOnePattern({
      userId,
      symbol,
      displaySymbol: args.displaySymbol,
      isSynthetic,
      timeframe,
      pattern,
      feedStatusAtDetection: args.feedStatusAtDetection,
    });
  }

  // 2) Reliability read-back — fail-open. On any error, surface no adjustment.
  let reliability: Awaited<ReturnType<typeof buildPatternReliability>>;
  try {
    reliability = await buildPatternReliability(userId);
  } catch (err) {
    logger.warn(
      { err, userId },
      "patternLearningRuntime: buildPatternReliability failed (no confidence nudge)",
    );
    return null;
  }

  const report = isSynthetic ? reliability.synthetic : reliability.forexIndices;
  const adjustment = report.rubyConfidenceAdjustment; // already ±MAX-bounded, 0 below floor

  // No accrued edge yet → surface nothing extra (keeps the read payload stable).
  if (adjustment === 0) return null;

  // HARD CAP: the nudge can never push display confidence above the ceiling the
  // pure contract already set, and never below 0. Clamp on BOTH ends.
  const ceiling = verdict.scannerTruthImpact.confidenceCeiling;
  const boundedAdjustment = clamp(adjustment, -MAX_CONFIDENCE_ADJUSTMENT, MAX_CONFIDENCE_ADJUSTMENT);
  const adjustedConfidence = clamp(verdict.confidence + boundedAdjustment, 0, ceiling);

  return {
    confidenceAdjustment: boundedAdjustment,
    adjustedConfidence,
    reliabilityScore: report.reliabilityScore,
    marketClass,
    resolvedSamples: report.resolvedCount,
  };
}
