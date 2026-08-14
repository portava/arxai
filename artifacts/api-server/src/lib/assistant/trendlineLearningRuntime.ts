// ── TRENDLINE TRUTH — LEARNING-LOOP RUNTIME (Task #649) ──────────────────────
//
// The ONE runtime seam that wires the Trendline Truth learning loop into a live
// request path (Ruby's structural chart read). For every detected dominant
// trendline it:
//   1. RECORDS the detection as an OBSERVATION (fire-and-forget, idempotent on a
//      stable outcomeId) so reliability statistics can accrue over time, and
//   2. reads back the user's accrued reliability and turns it into a BOUNDED,
//      per-market-class confidence ADJUSTMENT the caller may surface beside the
//      trendline read.
//
// ── SAFETY — DISPLAY / DECISION-SUPPORT ONLY (Trendline Truth hard boundary) ──
// This module is best-effort and fail-open. It can ONLY:
//   • record an observation row (no order, no MT5 bridge, no live/16-gate path),
//   • return a confidence nudge clamped to ±TRENDLINE_MAX_CONFIDENCE_ADJUSTMENT
//     AND capped at the verdict's existing display ceiling (`scannerTruthImpact
//     .confidenceCeiling`) — it can never raise display confidence above what the
//     pure contract already allowed, never produce READY_NOW, and never override
//     a feed / sufficiency / trade-health / risk gate.
// Synthetic-index reliability is aggregated SEPARATELY from forex/indices, so a
// synthetic trendline is only ever coloured by synthetic history (and vice-versa).
// Per-user isolation: a null userId means NO record and NO adjustment.

import { clamp } from "../data/chart/engines/chartMath.js";
import { logger } from "../logger.js";
import {
  recordTrendlineDetection,
  buildTrendlineReliability,
} from "../data/chart/trendlineOutcomeService.js";
import {
  TRENDLINE_MAX_CONFIDENCE_ADJUSTMENT,
  trendlineMarketClass,
  resolveArxMarket,
  type ActiveTrendline,
  type TrendlineMarketClass,
  type TrendlineTruthVerdict,
} from "@workspace/domain/market";

export interface TrendlineLearningResult {
  /** Bounded nudge actually applied (±TRENDLINE_MAX_CONFIDENCE_ADJUSTMENT, may be < 0). */
  confidenceAdjustment: number;
  /** verdict.confidence + adjustment, clamped to [0, display ceiling]. */
  adjustedConfidence: number;
  /** 0–100 reliability score backing the nudge (null below the sample floor). */
  reliabilityScore: number | null;
  /** Which reliability bucket coloured this trendline (synthetic vs forex/indices). */
  marketClass: TrendlineMarketClass;
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
 * every keypoint, plus the trendline's confirmation/invalidation levels. Prices
 * are already engine-rounded to the symbol's decimals. This signature is
 * INDEX-INDEPENDENT — so it survives candle-array growth and a repeat read of the
 * SAME live trendline (idempotent refresh) — yet DISTINCT for a genuinely
 * different detection (different swing points / levels), so two real detections
 * never collapse into one observation row.
 */
function detectionSignature(t: ActiveTrendline): string {
  const points = t.keyPoints
    .map((k) => `${k.role}@${r5(k.price)}`)
    .sort()
    .join("|");
  const levels = `c${r5(t.levels.confirmation)}|i${r5(t.levels.invalidation)}`;
  return djb2(`${points}#${levels}`);
}

/**
 * Stable, idempotent observation id for ONE trendline detection INSTANCE. Keyed
 * on the user-independent facts of the detection (symbol + timeframe + trendline
 * id + its geometry signature) so a repeat read of the SAME live trendline
 * refreshes — never duplicates — its row, while a distinct detection gets its own.
 */
function buildOutcomeId(symbol: string, timeframe: string, t: ActiveTrendline): string {
  return `tl:${symbol}:${timeframe}:${t.id}:${detectionSignature(t)}`;
}

/**
 * Record ONE detected trendline as an observation (fire-and-forget). Uses the
 * trendline's OWN status / quality / raw confidence / levels — not the display-
 * folded dominant verdict values — so reliability statistics reflect what each
 * trendline actually printed. A failure here never blocks or throws into the read.
 */
function recordOneTrendline(args: {
  userId: number;
  symbol: string;
  displaySymbol?: string | null;
  isSynthetic: boolean;
  timeframe: string;
  trendline: ActiveTrendline;
  feedStatusAtDetection?: string;
}): void {
  const { userId, symbol, timeframe, trendline: t } = args;
  void recordTrendlineDetection({
    userId,
    outcomeId: buildOutcomeId(symbol, timeframe, t),
    symbol,
    displayName: args.displaySymbol ?? symbol,
    isSynthetic: args.isSynthetic,
    timeframe,
    trendlineId: t.id,
    trendlineName: t.name,
    trendlineCategory: t.category,
    bias: t.bias,
    statusAtDetection: t.status,
    qualityAtDetection: t.quality,
    confidenceAtDetection: t.confidence,
    feedStatusAtDetection: args.feedStatusAtDetection,
    confirmationLevel: t.levels.confirmation,
    invalidationLevel: t.levels.invalidation,
    targetLevel: t.levels.targets[0] ?? null,
  }).catch((err) => {
    logger.warn(
      { err, userId, symbol, timeframe, trendlineId: t.id },
      "trendlineLearningRuntime: recordTrendlineDetection failed (observation skipped)",
    );
  });
}

/**
 * Record the detection (fire-and-forget) and return the bounded reliability
 * confidence adjustment for this user + market class. Returns `null` — meaning
 * "surface nothing extra" — when there is no user, no dominant trendline, the
 * reliability read fails, or there is not yet enough resolved history for a
 * non-zero adjustment. Never throws.
 */
export async function applyTrendlineLearning(args: {
  userId: number | null;
  symbol: string;
  displaySymbol?: string | null;
  timeframe: string;
  verdict: TrendlineTruthVerdict;
  feedStatusAtDetection?: string;
}): Promise<TrendlineLearningResult | null> {
  const { userId, symbol, timeframe, verdict } = args;
  const dominant = verdict.dominantTrendline;
  if (userId == null || !dominant) return null;

  const isSynthetic = isSyntheticSymbol(symbol);
  const marketClass = trendlineMarketClass(isSynthetic);

  // 1) OBSERVATION writes — record EVERY detected trendline (not only the
  //    dominant), each on its own per-detection-instance id, so reliability
  //    statistics accrue across the full detected set. Fire-and-forget; failures
  //    never block the read.
  for (const trendline of verdict.activeTrendlines) {
    recordOneTrendline({
      userId,
      symbol,
      displaySymbol: args.displaySymbol,
      isSynthetic,
      timeframe,
      trendline,
      feedStatusAtDetection: args.feedStatusAtDetection,
    });
  }

  // 2) Reliability read-back — fail-open. On any error, surface no adjustment.
  let reliability: Awaited<ReturnType<typeof buildTrendlineReliability>>;
  try {
    reliability = await buildTrendlineReliability(userId);
  } catch (err) {
    logger.warn(
      { err, userId },
      "trendlineLearningRuntime: buildTrendlineReliability failed (no confidence nudge)",
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
  const boundedAdjustment = clamp(
    adjustment,
    -TRENDLINE_MAX_CONFIDENCE_ADJUSTMENT,
    TRENDLINE_MAX_CONFIDENCE_ADJUSTMENT,
  );
  const adjustedConfidence = clamp(verdict.confidence + boundedAdjustment, 0, ceiling);

  return {
    confidenceAdjustment: boundedAdjustment,
    adjustedConfidence,
    reliabilityScore: report.reliabilityScore,
    marketClass,
    resolvedSamples: report.resolvedCount,
  };
}
