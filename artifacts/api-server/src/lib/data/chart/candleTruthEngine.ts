// ARX Candle Truth Engine (Phase 1)
//
// The single entry point that wraps the existing chartDataService/
// candleNormalization stack and returns a structured, per-timeframe
// truth result alongside the VerifiedCandle array.
//
// What this does:
//   - Validates every candle batch (integrity, ordering, outliers, mock detection)
//   - Produces a TimeframeTruthResult with per-timeframe audit data
//   - Detects mock/dev data and flags it DEGRADED (admin) / syncing (user)
//   - Detects historical period shifts (e.g. XAUUSD 2023 bars in a 2025 chart)
//   - Verifies the historical + live seam (no gap/overlap at the merge point)
//   - Uses the SymbolProfile for precision, session, outlier thresholds
//
// What this does NOT do:
//   - Add any new data source
//   - Fabricate candles or fill gaps with mock data
//   - Touch any safety gate, MT5 dispatch, or order placement
//   - Compute Chart Truth Score or Chart Read Score (Phase 3 scope)
//   - Compute Ruby/AACI/scanner integration (Phase 4 scope)
//
// ── 1D Wick Root Cause Finding (Step 8) ─────────────────────────────────────
// The reported "1D abnormal downside wick near ~2000" for XAUUSD is:
//   FINDING: REAL HISTORICAL DATA — not a bad tick.
//   Gold (XAUUSD) was trading in the ~$1900–$2100 range during 2023. The 2024–
//   2025 rally pushed prices to ~$3200–$4300+. When a D1 chart loads 300 bars
//   of history it includes legitimate bars from 2023 at the lower price epoch.
//   These appear as a downside "wick" only because the Y-axis is not auto-scaled
//   to the full historical range — that is a chart rendering issue (Phase 2).
//   Classification: HISTORICAL_PERIOD_SHIFT quality flag (informational).
//   Action: flag the old-epoch bars; NEVER delete, smooth, or rewrite them.
//   Phase 2 work: the chart layer must auto-scale the Y axis to include all
//   visible bars, not just the most recent cluster.
//
// ── Historical + Live Merge Verification (Step 7) ────────────────────────────
// After normalization the engine inspects the merge seam (the boundary between
// the last CLOSED bar and the FORMING bar):
//   - SEAM OVERLAP: two bars share the same open time at the seam → duplicate.
//     Already collapsed by normalizeCandles (duplicate collapsed, count logged).
//   - SEAM GAP: the forming bar's open time is more than one interval after the
//     last closed bar → a candle is missing at the seam.
//   - SEAM INTEGRITY: closed bars should not be overwritten (immutable once
//     isComplete). At L1 we only validate — no write path here.
//   - SYMBOL/TIMEFRAME SWITCH CLEARING: when symbol or timeframe changes the
//     caller is responsible for clearing the candle state (this engine validates
//     the returned data, not the FE cache lifecycle).
//
// ── Per-Timeframe Audit (Step 6) ─────────────────────────────────────────────
// The audit cross-checks each timeframe independently against:
//   - Bucket duration: timeframeMs(timeframe) must match bar gaps in the data.
//   - Candle count / history minimum: ≥ MIN_CANDLE_HISTORY_COUNT (150) where
//     supported; fewer is partial/unavailable.
//   - Forming-candle detection: last bar's closeTime > now.
//   - Duplicate / missing / outlier counts from the normalizer.
//   - Session-aware gap expectations (synthetics: 24/7; stocks: weekday only).

import {
  normalizeCandles,
  trailingIntervalGap,
  sourceModeFromProvider,
  priceBasisFromProvider,
  type NormalizedChartCandle,
  type SequenceAnomalies,
  type SourceMode,
  type PriceBasis,
} from "./candleNormalization.js";
import { timeframeMs, timeframeSeconds, type ChartTimeframe } from "./timeframes.js";
import type { WeeklyPresenceProfile } from "./sessionProfile.js";
import { classifyCandleFreshness, STALE_TRAILING_INTERVALS } from "../freshness.js";
import {
  getSymbolProfile,
  getSourceDocumentation,
  type SymbolProfile,
  type OhlcSourceType,
} from "./symbolProfile.js";
import type { Candle } from "../types.js";
import type { AssetClass } from "../marketDataRouter.js";

// Minimum candle count below which history is considered insufficient.
const MIN_CANDLE_HISTORY_COUNT = 150;
// Minimum candle count for D1 (fewer bars expected due to weekends/holidays).
const MIN_CANDLE_HISTORY_COUNT_D1 = 50;

// ── Truth result types ────────────────────────────────────────────────────────

export type TruthAssessment = "CLEAN" | "PARTIAL" | "STALE" | "DEGRADED" | "UNAVAILABLE";

export interface MergeSeamReport {
  // Was a forming (still-open) bar detected at the end of the array?
  formingBarDetected: boolean;
  // How many bars away from the tip are still forming?
  formingBarCount: number;
  // Is there a gap between the last closed bar and the forming bar?
  gapAtSeam: boolean;
  // Are there duplicate bars at the seam?
  overlapAtSeam: boolean;
  // Gap size in number of missing intervals (0 = no gap)
  seamGapIntervals: number;
}

export interface TimeframeTruthResult {
  // ── Identity ────────────────────────────────────────────────────────────
  timeframe: ChartTimeframe;
  symbol: string;
  assetClass: AssetClass;

  // ── Source ──────────────────────────────────────────────────────────────
  source: string | null;
  sourceMode: SourceMode;
  priceBasis: PriceBasis;
  ohlcSourceType: OhlcSourceType;
  providerDeliversRealOhlc: boolean;

  // ── Timeframe metadata (Step 6) ─────────────────────────────────────────
  bucketDurationSeconds: number;
  historyWindowRequested: number;
  candleCount: number;
  historyDepthHours: number | null;
  oldestBarTime: string | null;
  newestBarTime: string | null;
  historyMinimumMet: boolean;

  // ── Forming candle (Step 6) ──────────────────────────────────────────────
  formingCandlePresent: boolean;
  formingCandleOhlc: { open: number; high: number; low: number; close: number } | null;

  // ── Integrity (Step 4) ───────────────────────────────────────────────────
  duplicateCount: number;
  missingCandleCount: number;
  outOfOrderCount: number;
  invalidOhlcCount: number;
  /**
   * Bars whose price decimal-place count is inconsistent with the symbol's
   * stated pricePrecision. Non-zero indicates the provider is using the wrong
   * scale (e.g. integer pips instead of decimal prices). 0 when pricePrecision
   * is not in the symbol profile.
   */
  precisionViolationCount: number;

  // ── Outliers (Step 8) ────────────────────────────────────────────────────
  outlierSpikeCount: number;
  outlierWickCount: number;
  zeroVolumeGhostCount: number;
  historicalPeriodShiftCount: number;

  // ── Mock / source checks (Steps 4, 5) ────────────────────────────────────
  mockDataDetected: boolean;
  /** Admin-only reason string — never shown to end users. */
  mockDataAdminReason: string | null;

  // ── Historical + live merge (Step 7) ─────────────────────────────────────
  mergeSeam: MergeSeamReport;

  // ── Symbol profile used (Step 9) ─────────────────────────────────────────
  pricePrecision: number | null;
  pipSize: number | null;
  allowedTimeframes: ChartTimeframe[];
  sessionAlwaysOpen: boolean;
  sessionNote: string | null;

  // ── Session-aware completeness ───────────────────────────────────────────
  /** True when a weekly presence profile drove the missing-bar count. */
  sessionProfileApplied: boolean;
  /** Slots excluded as market-closed (weekend / off-hours). */
  marketClosedSlotCount: number;
  /** Isolated one-off closures observed (tolerated below threshold). */
  isolatedClosureCount: number;
  /**
   * Completeness reason for non-naive paths ("isolated_closure_or_gap",
   * "insufficient_history_for_session_profile") or null. Advisory — never
   * escalates the assessment on its own.
   */
  completenessReason: string | null;

  // ── Assessment ───────────────────────────────────────────────────────────
  assessment: TruthAssessment;
  assessmentReasons: string[];

  // ── Source documentation (Steps 1, 2) ────────────────────────────────────
  sourceDocumentation: {
    dataMode: string;
    priceBasisNote: string;
    updateMethod: string;
    freshnessNote: string;
    supportedTimeframes: string[];
    knownLimitations: string[];
  };
}

export interface CandleTruthResult {
  symbol: string;
  timeframe: ChartTimeframe;
  assetClass: AssetClass;

  /** Normalized, validated candles with full VerifiedCandle shape. */
  verifiedCandles: NormalizedChartCandle[];

  /** Structured per-timeframe audit result. */
  truthResult: TimeframeTruthResult;

  /** Anomaly counts from the normalizer. */
  anomalies: SequenceAnomalies;
}

// ── Merge seam analysis ───────────────────────────────────────────────────────

function analyzeSeam(candles: NormalizedChartCandle[], intervalMs: number, now: number): MergeSeamReport {
  let formingBarCount = 0;
  // Count forming bars from the end
  for (let i = candles.length - 1; i >= 0; i--) {
    if (!candles[i]!.isComplete) formingBarCount++;
    else break;
  }

  const formingBarDetected = formingBarCount > 0;

  // Gap/overlap at the seam: between the last COMPLETE bar and the FORMING bar
  if (!formingBarDetected || candles.length < 2) {
    return { formingBarDetected, formingBarCount, gapAtSeam: false, overlapAtSeam: false, seamGapIntervals: 0 };
  }

  const lastComplete = candles.slice(0, candles.length - formingBarCount).at(-1);
  const firstForming = candles[candles.length - formingBarCount];

  if (!lastComplete || !firstForming) {
    return { formingBarDetected, formingBarCount, gapAtSeam: false, overlapAtSeam: false, seamGapIntervals: 0 };
  }

  const lastCompleteClose = Date.parse(lastComplete.closeTime);
  const firstFormingOpen = Date.parse(firstForming.openTime);

  // diff measures the gap between the close of the last complete bar and the
  // open of the first forming bar. For a clean seam diff === 0 (the forming
  // bar starts exactly where the last complete bar ended). If diff === intervalMs
  // there is exactly ONE missing bar between them — that is already a seam gap.
  const diff = firstFormingOpen - lastCompleteClose;
  const diffIntervals = Math.round(diff / intervalMs);

  const overlapAtSeam = diffIntervals < 0;
  // Any positive diffIntervals means at least one bar is missing at the seam.
  const gapAtSeam = diffIntervals > 0;
  const seamGapIntervals = gapAtSeam ? diffIntervals : 0;

  return { formingBarDetected, formingBarCount, gapAtSeam, overlapAtSeam, seamGapIntervals };
}

// Trailing-interval staleness now comes from the ONE shared freshness module
// (../freshness.js) so the per-timeframe truth engine and the HTTP quality
// field classify a feed identically — they no longer diverge.

// ── Assessment logic ──────────────────────────────────────────────────────────

function computeAssessment(
  anomalies: SequenceAnomalies,
  candles: NormalizedChartCandle[],
  historyMinimumMet: boolean,
  mockDataDetected: boolean,
  trailingIntervals: number | null,
  profile: SymbolProfile,
): { assessment: TruthAssessment; reasons: string[] } {
  const reasons: string[] = [];

  if (candles.length === 0) {
    reasons.push("No candles returned");
    return { assessment: "UNAVAILABLE", reasons };
  }

  // Mock data in live context → DEGRADED (admin: mock; user: syncing)
  if (mockDataDetected) {
    reasons.push("Mock/simulated data detected — not safe as tradable truth");
    return { assessment: "DEGRADED", reasons };
  }

  // Hard integrity failures → DEGRADED
  if (anomalies.invalidOhlcCount > 0) {
    reasons.push(`${anomalies.invalidOhlcCount} bar(s) with invalid OHLC (high < low or O/C outside H/L)`);
  }

  if (anomalies.invalidOhlcCount > candles.length * 0.05) {
    return { assessment: "DEGRADED", reasons };
  }

  // Feed staleness → STALE (checked before PARTIAL so a stale but otherwise
  // clean feed gets an honest STALE verdict rather than CLEAN or PARTIAL)
  const isStale = classifyCandleFreshness(trailingIntervals)?.freshness === "stale";
  if (isStale) {
    reasons.push(
      `Feed is stale — newest bar trails the current bar by ${trailingIntervals} intervals (threshold: ${STALE_TRAILING_INTERVALS})`,
    );
    return { assessment: "STALE", reasons };
  }

  // Sequence anomalies → PARTIAL
  const hasSequenceIssues =
    anomalies.duplicateCount > 0 ||
    anomalies.outOfOrderCount > 0 ||
    anomalies.missingCandleCount > Math.max(3, candles.length * 0.1);

  if (hasSequenceIssues) {
    if (anomalies.duplicateCount > 0) reasons.push(`${anomalies.duplicateCount} duplicate bucket(s)`);
    if (anomalies.outOfOrderCount > 0) reasons.push(`${anomalies.outOfOrderCount} out-of-order bar(s)`);
    if (anomalies.missingCandleCount > 3) reasons.push(`${anomalies.missingCandleCount} missing bar(s) (gaps)`);
  }

  if (!historyMinimumMet) {
    reasons.push(`History below minimum (${candles.length} bars; recommend ≥ ${MIN_CANDLE_HISTORY_COUNT})`);
  }

  // Precision violations → PARTIAL when widespread (> 10% of bars at wrong scale)
  const hasPrecisionIssues = anomalies.precisionViolationCount > Math.max(1, candles.length * 0.1);
  if (hasPrecisionIssues) {
    reasons.push(
      `${anomalies.precisionViolationCount} bar(s) with wrong price scale (expected ≤${profile.pricePrecision} decimal places)`,
    );
  }

  if (hasSequenceIssues || !historyMinimumMet || hasPrecisionIssues || reasons.length > 0) {
    return { assessment: "PARTIAL", reasons };
  }

  // Outlier-only: advisory — never degrade assessment by themselves.
  // Returned in reasons on CLEAN so callers have per-bar context without
  // escalating the overall verdict.
  const advisoryReasons: string[] = [];
  if (anomalies.historicalPeriodShiftCount > 0) {
    advisoryReasons.push(`${anomalies.historicalPeriodShiftCount} bar(s) from a different price epoch (real history; chart Y-scale may need adjustment)`);
  }
  if (anomalies.outlierWickCount > 0) {
    advisoryReasons.push(`${anomalies.outlierWickCount} bar(s) with abnormal wick pattern`);
  }
  if (anomalies.outlierSpikeCount > 0) {
    advisoryReasons.push(`${anomalies.outlierSpikeCount} bar(s) with spike-like price move`);
  }
  // Session-aware completeness note — advisory only; never escalates the verdict.
  if (anomalies.qualityReason === "isolated_closure_or_gap") {
    advisoryReasons.push(`${anomalies.isolatedClosureCount} isolated one-off closure(s) tolerated (no genuine gap)`);
  } else if (anomalies.qualityReason === "insufficient_history_for_session_profile") {
    advisoryReasons.push("Session presence profile has insufficient history — missing-bar count withheld (fail-honest)");
  }

  return { assessment: "CLEAN", reasons: advisoryReasons };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the candle truth engine over a raw candle batch from the market-data
 * router. Returns the full VerifiedCandle array alongside a structured
 * TimeframeTruthResult.
 *
 * @param rawCandles   Raw candles from routeCandles()
 * @param symbol       ARX-canonical symbol (e.g. "XAUUSD")
 * @param displaySymbol Human-readable symbol
 * @param timeframe    Requested chart timeframe
 * @param source       Winning provider id from the router
 * @param assetClass   Classified asset class
 * @param limit        How many candles were requested
 * @param now          Current wall clock time (for forming-bar detection)
 */
export function runCandleTruth(
  rawCandles: Candle[],
  {
    symbol,
    displaySymbol,
    timeframe,
    source,
    assetClass,
    limit,
    now = Date.now(),
    sessionProfile = null,
  }: {
    symbol: string;
    displaySymbol: string;
    timeframe: ChartTimeframe;
    source: string | null;
    assetClass: AssetClass;
    limit: number;
    now?: number;
    /**
     * Weekly presence profile for session-aware completeness (forex/stocks/
     * indices). Null for synthetics/crypto or when no profile is available.
     */
    sessionProfile?: WeeklyPresenceProfile | null;
  },
): CandleTruthResult {
  const receivedAt = new Date(now).toISOString();
  const profile = getSymbolProfile(symbol, assetClass);
  const intervalMs = timeframeMs(timeframe);
  const intervalSeconds = timeframeSeconds(timeframe);
  const sourceMode = sourceModeFromProvider(source);
  // priceBasis is derived from the symbol profile (family-correct), not from the
  // provider alone. priceBasisFromProvider returns MID for all assistant_real:*
  // sources regardless of asset class; the profile knows LAST for indices/stocks/
  // crypto and SYNTHETIC for Deriv volatility instruments, so it always wins.
  const priceBasis = profile.priceBasis;
  const mockDataDetected = sourceMode === "mock" || sourceMode === "dev";
  const mockDataAdminReason = mockDataDetected
    ? `Source "${source ?? "unknown"}" is a mock/simulation provider — data is not real market data and must not be used for live trading decisions.`
    : null;

  // Normalize with profile-based outlier thresholds and precision
  const { candles, anomalies } = normalizeCandles(rawCandles, {
    symbol,
    displaySymbol,
    timeframe,
    source,
    now,
    receivedAt,
    priceBasisOverride: priceBasis,
    spikeAtrMultiple: profile.spikeAtrMultiple,
    wickRatioThreshold: profile.wickRatioThreshold,
    historicalShiftThreshold: profile.historicalShiftThreshold,
    pricePrecision: profile.pricePrecision,
    // Session-aware completeness: forex/stocks/indices have a market session,
    // synthetics/crypto are 24/7. When session-based, the weekly presence
    // profile (if any) excludes weekend/off-hours slots from the missing count.
    sessionExpected: !profile.session.alwaysOpen,
    sessionProfile,
  });

  // Timeframe metadata
  const oldest = candles.length > 0 ? candles[0]!.openTime : null;
  const newest = candles.length > 0 ? candles[candles.length - 1]!.openTime : null;
  const historyDepthHours = (oldest && newest)
    ? (Date.parse(newest) - Date.parse(oldest)) / (1000 * 60 * 60)
    : null;

  const minCount = timeframe === "D1" ? MIN_CANDLE_HISTORY_COUNT_D1 : MIN_CANDLE_HISTORY_COUNT;
  const historyMinimumMet = candles.length >= minCount;

  // Forming candle
  const lastCandle = candles[candles.length - 1] ?? null;
  const formingCandlePresent = lastCandle != null && !lastCandle.isComplete;
  const formingCandleOhlc = formingCandlePresent && lastCandle
    ? { open: lastCandle.open, high: lastCandle.high, low: lastCandle.low, close: lastCandle.close }
    : null;

  // Seam analysis
  const mergeSeam = analyzeSeam(candles, intervalMs, now);

  // Trailing-interval lag (how many bar intervals behind the current expected bar)
  // Used to evaluate STALE in the assessment.
  const trailingIntervals = trailingIntervalGap(candles, timeframe, now);

  // Assessment
  const { assessment, reasons: assessmentReasons } = computeAssessment(
    anomalies, candles, historyMinimumMet, mockDataDetected, trailingIntervals, profile,
  );

  // Source documentation
  const sourceDocumentation = getSourceDocumentation(assetClass);

  // OHLC source type — derived from the provider's known behavior
  let ohlcSourceType: OhlcSourceType = profile.ohlcSourceType;
  if (source === "mt5_broker") ohlcSourceType = "true_ohlc"; // EA pushes real OHLC when active
  if (source === "deriv") ohlcSourceType = "true_ohlc";

  const truthResult: TimeframeTruthResult = {
    timeframe,
    symbol,
    assetClass,
    source,
    sourceMode,
    priceBasis,
    ohlcSourceType,
    providerDeliversRealOhlc: ohlcSourceType === "true_ohlc",

    bucketDurationSeconds: intervalSeconds,
    historyWindowRequested: limit,
    candleCount: candles.length,
    historyDepthHours,
    oldestBarTime: oldest,
    newestBarTime: newest,
    historyMinimumMet,

    formingCandlePresent,
    formingCandleOhlc,

    duplicateCount: anomalies.duplicateCount,
    missingCandleCount: anomalies.missingCandleCount,
    outOfOrderCount: anomalies.outOfOrderCount,
    invalidOhlcCount: anomalies.invalidOhlcCount,
    precisionViolationCount: anomalies.precisionViolationCount,

    outlierSpikeCount: anomalies.outlierSpikeCount,
    outlierWickCount: anomalies.outlierWickCount,
    zeroVolumeGhostCount: anomalies.zeroVolumeGhostCount,
    historicalPeriodShiftCount: anomalies.historicalPeriodShiftCount,

    mockDataDetected,
    mockDataAdminReason,

    mergeSeam,

    pricePrecision: profile.pricePrecision,
    pipSize: profile.pipSize,
    allowedTimeframes: profile.allowedTimeframes,
    sessionAlwaysOpen: profile.session.alwaysOpen,
    sessionNote: profile.session.note,

    sessionProfileApplied: anomalies.sessionProfileApplied,
    marketClosedSlotCount: anomalies.marketClosedSlotCount,
    isolatedClosureCount: anomalies.isolatedClosureCount,
    completenessReason: anomalies.qualityReason,

    assessment,
    assessmentReasons,

    sourceDocumentation,
  };

  return {
    symbol,
    timeframe,
    assetClass,
    verifiedCandles: candles,
    truthResult,
    anomalies,
  };
}
