// CHART PATTERN TRUTH — backend producer (Task #617).
//
// This is the ONE backend call site that turns raw candles + the caller's
// ALREADY-DECIDED display facts into the shared, display-only PatternTruthVerdict
// (and its downgrade-only `scannerTruthImpact`). It runs the pure detector
// (`detectChartPatterns`) and the pure domain contract (`resolvePatternTruth`) —
// neither of which imports any execution/feed/sufficiency module — and folds the
// result into Scanner Truth as a CHILD INPUT.
//
// HARD BOUNDARY (mirrors the contract): the verdict this produces can only make a
// read the SAME or MORE conservative (plus a small bounded supportive edge nudge
// when a confirmed pattern sits on a live-confirmed feed). It can NEVER produce
// READY_NOW, override feed/historical/sufficiency status, override a low-
// confidence / trade-health / risk gate, or touch live execution. Fail closed:
// any error or insufficient window returns `null` (no pattern impact at all).
import type { Candle } from "../types.js";
import { normalizeCandles } from "./candleNormalization.js";
import { isChartTimeframe, type ChartTimeframe } from "./timeframes.js";
import { detectChartPatterns } from "./engines/patternEngine.js";
import {
  resolvePatternTruth,
  type PatternBias,
  type PatternContext,
  type PatternDisplayContext,
  type PatternTruthVerdict,
  resolveConsolidationTruth,
  type ConsolidationRead,
  resolveShootingStarTruth,
  type ShootingStarRead,
  detectCandlestickReversals,
  type CandlestickSignal,
  resolveStructureBreakTruth,
  type StructureBreakRead,
  classifyTradeRead,
  type TradeReadVerdict,
  type PatternFamily,
  type PatternDetection,
  type PatternDirection,
  type PatternStatus,
  type PatternLocationQuality,
  type PatternQuality,
  classifyAssetClass,
  type PatternAssetClass,
  getAssetPatternProfile,
  type AssetPatternProfile,
  assetPatternWarnings,
  patternLibraryEntry,
  researchRefsForPattern,
  buildPatternReasoningBlock,
  type PatternReasoningBlock,
} from "@workspace/domain/market";

export interface PatternTruthServiceInput {
  symbol: string;
  displaySymbol?: string;
  timeframe: string;
  /** Raw routed candles (bar-open based); normalized + closed-bar filtered here. */
  rawCandles: Candle[];
  /** Source tag for normalization (provider name) — affects price-basis only. */
  source?: string | null;
  // ── Caller's ALREADY-DECIDED display facts (the pattern NEVER recomputes them).
  /** True only when the feed is genuinely live-confirmed (LIVE + FULL read). */
  feedConfirmed: boolean;
  /** True when the feed is delayed/stale (read uses last closed bars only). */
  feedStale: boolean;
  /** True when sufficiency already allows showing a trade setup. */
  sufficiencyAllowsSetup: boolean;
  /** True when the chart-read structural confidence is LOW. */
  chartReadConfidenceLow: boolean;
  // ── Structural context facts (advisory; used only to colour the pattern read).
  /** Higher-timeframe / structural trend bias the read already established. */
  trend: PatternBias;
  /** True when momentum agrees with the pattern bias. */
  momentumAligned: boolean;
  /** True when price is at/into a meaningful S/R level. */
  nearSupportResistance: boolean;
  /** Distance to nearest blocking S/R in ATR units (null when unknown). */
  distanceToSrAtr: number | null;
  /** ATR used for geometry normalization (null when unknown). */
  volatilityAtr: number | null;
}

/**
 * Build the shared PatternTruthVerdict from raw candles + display facts.
 * Returns `null` (no pattern impact) on any error, an unsupported timeframe, an
 * insufficient candle window, or when no pattern is detected — the caller then
 * leaves its base Scanner Truth read completely untouched.
 */
export function buildPatternTruthVerdict(
  input: PatternTruthServiceInput,
): PatternTruthVerdict | null {
  try {
    if (!isChartTimeframe(input.timeframe)) return null;
    const tf = input.timeframe as ChartTimeframe;
    if (!Array.isArray(input.rawCandles) || input.rawCandles.length === 0) {
      return null;
    }
    const { candles } = normalizeCandles(input.rawCandles, {
      symbol: input.symbol,
      displaySymbol: input.displaySymbol ?? input.symbol,
      timeframe: tf,
      source: input.source ?? null,
    });
    const detection = detectChartPatterns(candles);
    if (detection.insufficient || detection.patterns.length === 0) return null;

    const context: PatternContext = {
      trend: input.trend,
      nearSupportResistance: input.nearSupportResistance,
      distanceToSrAtr: input.distanceToSrAtr,
      momentumAligned: input.momentumAligned,
      volatilityAtr: input.volatilityAtr,
    };
    const display: PatternDisplayContext = {
      feedConfirmed: input.feedConfirmed,
      feedStale: input.feedStale,
      sufficiencyAllowsSetup: input.sufficiencyAllowsSetup,
      chartReadConfidenceLow: input.chartReadConfidenceLow,
    };
    return resolvePatternTruth(detection.patterns, context, display);
  } catch {
    return null;
  }
}

// ── PATTERN LIBRARY READ (Task #654) — additive, display-only child input ─────
//
// A SECOND, fully ADDITIVE composition over the same raw candles + the caller's
// already-decided display facts. It folds the expanded Pattern Truth foundation
// (the consolidation/continuation detector, the per-asset profile + downgrade-only
// warnings, the trade-read classifier, and Eleanor's plain-English reasoning
// block) into ONE display-only read. It is intentionally SEPARATE from
// `buildPatternTruthVerdict` and the Scanner Truth folding: it changes no existing
// verdict, shape, gate, feed, sufficiency or execution path. It carries NO
// execution-permission / ready / dispatch field — a pattern is EVIDENCE, not
// permission. Fail closed: any error, unsupported timeframe, or insufficient
// window returns `null` (no library read at all).

export interface PatternLibraryReadInput {
  symbol: string;
  displaySymbol?: string;
  timeframe: string;
  rawCandles: Candle[];
  source?: string | null;
  /** True only when the feed is genuinely live-confirmed (LIVE + FULL read). */
  feedConfirmed: boolean;
  /** True when the feed is delayed/stale (read uses last closed bars only). */
  feedStale: boolean;
  /** True when sufficiency already allows showing a trade setup. */
  sufficiencyAllowsSetup: boolean;
  // ── Already-decided situational facts (downgrade-only caveats; never a clock).
  nearHighImpactNews?: boolean;
  outsideRegularHours?: boolean;
  atOpeningRange?: boolean;
  wideSpread?: boolean;
}

export interface PatternLibraryRead {
  assetClass: PatternAssetClass;
  profile: AssetPatternProfile;
  /**
   * The consolidation-detector result (kept for back-compat + the range view).
   * `type === "none"` when no consolidation structure is present even though
   * another family (a reversal / candlestick / structure break) was detected.
   */
  consolidation: ConsolidationRead;
  /**
   * The strongest detected structure across ALL detector families
   * (consolidation, shooting star, candlestick reversals, structure break),
   * normalised into the unified, display-only taxonomy. NO execution-permission
   * field by construction.
   */
  detection: PatternDetection;
  /**
   * Every detected structure across all families, ranked strongest-first, for
   * transparency. Display-only; `detection` is `candidates[0]`.
   */
  candidates: PatternDetection[];
  /** Classified, display-only trade read (no execution-permission field). */
  read: TradeReadVerdict;
  /** Eleanor's plain-English reasoning (confirmation + invalidation, no tokens). */
  reasoning: PatternReasoningBlock;
  /** Asset-specific, downgrade-only caveats (plain sentences, never tokens). */
  warnings: string[];
}

/** Map a consolidation structure to its pattern family (display taxonomy only). */
function consolidationFamily(type: ConsolidationRead["type"]): PatternFamily {
  return type === "bull_flag" || type === "bear_flag"
    ? "continuation"
    : "consolidation";
}

/** Display-only confidence → quality grade (no execution meaning). */
function gradeQuality(confidence: number): PatternQuality {
  return confidence >= 70
    ? "high"
    : confidence >= 45
      ? "medium"
      : confidence > 0
        ? "low"
        : "none";
}

/**
 * Honest, NON-GUARANTEED reliability note. This pure builder does no IO, so it
 * cannot read resolved-outcome samples; per the reliability contract a score is
 * withheld until enough resolved evidence accrues. The note says exactly that —
 * it never promises a win rate or profitability.
 */
const RELIABILITY_NOTE =
  "Internal reliability stats are withheld until enough resolved samples accrue — this is evidence, not a probability of profit.";

/** Rank a lifecycle status for "which structure is the strongest read". */
function statusRank(status: PatternStatus): number {
  switch (status) {
    case "confirmed":
      return 4;
    case "forming":
      return 3;
    case "exhausted":
      return 2;
    case "failed":
    case "invalidated":
      return 1;
    default:
      return 0;
  }
}

/** Deterministic family tiebreak when status + confidence are equal. */
const FAMILY_RANK: Record<PatternFamily, number> = {
  structure: 6,
  reversal: 5,
  candlestick: 4,
  continuation: 3,
  consolidation: 2,
  scalp: 1,
  no_trade: 0,
};

/** Assemble a unified PatternDetection, enriching from the library + research seed. */
function toDetection(args: {
  id: string;
  name: string;
  family: PatternFamily;
  assetClass: PatternAssetClass;
  direction: PatternDirection;
  status: PatternStatus;
  confidence: number;
  locationQuality: PatternLocationQuality;
  confirmationLevel: number | null;
  invalidationLevel: number | null;
  candlesUsed: number;
  minCandles: number;
  rationale: string[];
  warnings: string[];
  contextOnly: boolean;
}): PatternDetection {
  const entry = patternLibraryEntry(args.id);
  return {
    id: args.id,
    name: args.name,
    family: args.family,
    assetClass: args.assetClass,
    direction: args.direction,
    status: args.status,
    confidence: args.confidence,
    quality: gradeQuality(args.confidence),
    locationQuality: args.locationQuality,
    confirmationLevel: args.confirmationLevel,
    invalidationLevel: args.invalidationLevel,
    // Measured-move targets need swing context this pure read does not derive;
    // stay honestly empty rather than fabricate a level.
    targets: [],
    targetRoom: "unknown",
    candlesUsed: args.candlesUsed,
    minCandles: args.minCandles,
    rationale: args.rationale,
    failureModes: entry?.failureModes ?? [],
    reliabilityNote: RELIABILITY_NOTE,
    researchRefs: researchRefsForPattern(args.id),
    warnings: args.warnings,
    contextOnly: args.contextOnly,
    freshnessRespected: true,
  };
}

/** Consolidation / continuation structure → unified detection (or null). */
function consolidationDetection(
  c: ConsolidationRead,
  assetClass: PatternAssetClass,
): PatternDetection | null {
  if (c.type === "none" || c.status === "none") return null;
  const entry = patternLibraryEntry(c.type);
  return toDetection({
    id: c.type,
    name: entry?.name ?? c.type.replace(/_/g, " "),
    family: consolidationFamily(c.type),
    assetClass,
    direction: c.direction,
    status: c.status,
    confidence: c.confidence,
    locationQuality: c.location,
    confirmationLevel:
      c.direction === "sell" ? c.lowerBreakLevel : c.upperBreakLevel,
    invalidationLevel:
      c.direction === "sell" ? c.upperBreakLevel : c.lowerBreakLevel,
    candlesUsed: c.candlesUsed,
    minCandles: c.minCandles,
    rationale: c.reasons,
    warnings: c.warnings,
    contextOnly: c.contextOnly,
  });
}

/** Shooting-star (bearish pin) read → unified detection (or null). */
function shootingStarDetection(
  s: ShootingStarRead,
  assetClass: PatternAssetClass,
): PatternDetection | null {
  if (!s.detected || s.status === "none") return null;
  return toDetection({
    id: "bearish_pin_bar",
    name: "Shooting Star",
    family: "candlestick",
    assetClass,
    direction: s.direction,
    status: s.status,
    confidence: s.confidence,
    locationQuality: s.locationQuality,
    confirmationLevel: s.confirmationLevel,
    invalidationLevel: s.invalidationLevel,
    candlesUsed: s.candlesUsed,
    minCandles: s.minCandles,
    rationale: s.reasons,
    warnings: s.warnings,
    contextOnly: s.contextOnly,
  });
}

/** Map a candlestick-detector id to its library id (for enrichment lookup). */
function candlestickLibraryId(id: CandlestickSignal["id"]): string {
  return id === "hammer" ? "bullish_pin_bar" : id;
}

/** Candlestick-reversal signal → unified detection. */
function candlestickDetection(
  sig: CandlestickSignal,
  assetClass: PatternAssetClass,
  contextOnly: boolean,
): PatternDetection {
  return toDetection({
    id: candlestickLibraryId(sig.id),
    name: sig.name,
    family: "candlestick",
    assetClass,
    direction: sig.direction,
    status: sig.status,
    confidence: sig.confidence,
    locationQuality: "unknown",
    confirmationLevel: sig.confirmationLevel,
    invalidationLevel: sig.invalidationLevel,
    candlesUsed: sig.candlesUsed,
    minCandles: sig.minCandles,
    rationale: sig.reasons,
    warnings: [],
    contextOnly,
  });
}

/** Structure-break read → unified detection (or null). */
function structureBreakDetection(
  b: StructureBreakRead,
  assetClass: PatternAssetClass,
): PatternDetection | null {
  if (b.type === "none" || b.status === "none") return null;
  const entry = patternLibraryEntry(b.type);
  return toDetection({
    id: b.type,
    name: entry?.name ?? b.type.replace(/_/g, " "),
    family: "structure",
    assetClass,
    direction: b.direction,
    status: b.status,
    confidence: b.confidence,
    locationQuality: b.location,
    confirmationLevel: b.confirmationLevel,
    invalidationLevel: b.invalidationLevel,
    candlesUsed: b.candlesUsed,
    minCandles: b.minCandles,
    rationale: b.reasons,
    warnings: b.warnings,
    contextOnly: b.contextOnly,
  });
}

/**
 * Rank detected structures strongest-first: confirmed beats forming beats
 * failed; then higher geometric confidence; then a deterministic family tiebreak.
 * Pure ordering — it colours which structure leads the read, never permission.
 */
function rankDetections(a: PatternDetection, b: PatternDetection): number {
  const byStatus = statusRank(b.status) - statusRank(a.status);
  if (byStatus !== 0) return byStatus;
  const byConfidence = b.confidence - a.confidence;
  if (byConfidence !== 0) return byConfidence;
  const byFamily = FAMILY_RANK[b.family] - FAMILY_RANK[a.family];
  if (byFamily !== 0) return byFamily;
  return a.id.localeCompare(b.id);
}

/**
 * Build the additive, display-only PatternLibraryRead by composing EVERY pattern
 * detector family — consolidation, shooting star, candlestick reversals, and
 * structure breaks — into one ranked, classified read. Returns `null` (no library
 * read) on any error, an unsupported timeframe, an empty/insufficient candle
 * window, or when NO family detects a structure — the caller then surfaces
 * nothing extra. NEVER produces an actionable read on a non-live feed: the
 * classifier collapses any structure to context-only when the feed is not
 * live-confirmed or sufficiency does not yet allow a setup.
 */
export function buildPatternLibraryRead(
  input: PatternLibraryReadInput,
): PatternLibraryRead | null {
  try {
    if (!isChartTimeframe(input.timeframe)) return null;
    const tf = input.timeframe as ChartTimeframe;
    if (!Array.isArray(input.rawCandles) || input.rawCandles.length === 0) {
      return null;
    }
    const { candles } = normalizeCandles(input.rawCandles, {
      symbol: input.symbol,
      displaySymbol: input.displaySymbol ?? input.symbol,
      timeframe: tf,
      source: input.source ?? null,
    });

    const ohlc = candles.map((c) => ({
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    const feedFacts = {
      feedConfirmed: input.feedConfirmed,
      feedStale: input.feedStale,
    };
    const contextOnlyFeed = !input.feedConfirmed || input.feedStale;

    const assetClass = classifyAssetClass(input.displaySymbol ?? input.symbol);
    const profile = getAssetPatternProfile(assetClass);
    const warnings = assetPatternWarnings({
      assetClass,
      nearHighImpactNews: input.nearHighImpactNews,
      outsideRegularHours: input.outsideRegularHours,
      atOpeningRange: input.atOpeningRange,
      wideSpread: input.wideSpread,
    });

    // ── Run EVERY detector family over the closed-bar window ──────────────────
    const consolidation = resolveConsolidationTruth({ candles: ohlc, ...feedFacts });
    const shootingStar = resolveShootingStarTruth({ candles: ohlc, ...feedFacts });
    const candlesticks = detectCandlestickReversals({ candles: ohlc, ...feedFacts });
    const structureBreak = resolveStructureBreakTruth({ candles: ohlc, ...feedFacts });

    // ── Normalise each fired structure into the unified taxonomy ──────────────
    const candidates: PatternDetection[] = [];
    const consDet = consolidationDetection(consolidation, assetClass);
    if (consDet) candidates.push(consDet);
    const starDet = shootingStarDetection(shootingStar, assetClass);
    if (starDet) candidates.push(starDet);
    for (const sig of candlesticks) {
      candidates.push(candlestickDetection(sig, assetClass, contextOnlyFeed));
    }
    const breakDet = structureBreakDetection(structureBreak, assetClass);
    if (breakDet) candidates.push(breakDet);

    // No family detected a structure → no library read at all.
    if (candidates.length === 0) return null;

    candidates.sort(rankDetections);
    const detection = candidates[0]!;

    const read = classifyTradeRead({
      family: detection.family,
      direction: detection.direction,
      status: detection.status,
      feedConfirmed: input.feedConfirmed,
      feedStale: input.feedStale,
      sufficiencyAllowsSetup: input.sufficiencyAllowsSetup,
      // Scalp timing / spread facts only matter to the scalp branch, which these
      // families never take — pass the permissive default.
      scalpTimingOk: true,
      spreadAcceptable: true,
    });

    const reasoning = buildPatternReasoningBlock({
      symbol: input.displaySymbol ?? input.symbol,
      read,
      detection,
      extraWarnings: warnings,
    });

    return {
      assetClass,
      profile,
      consolidation,
      detection,
      candidates,
      read,
      reasoning,
      warnings,
    };
  } catch {
    return null;
  }
}
