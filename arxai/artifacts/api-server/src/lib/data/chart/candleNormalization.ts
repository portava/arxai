// ARX Native Chart — Level 1: candle normalization + sequence validation.
// Phase 1 extension: VerifiedCandle shape, quality flags, outlier detection.
//
// Pure, side-effect-free helpers that turn raw router candles
// (`lib/data/types.ts` Candle = {time, open, high, low, close, volume?}) into
// the normalized chart-candle shape and inspect the sequence for integrity
// problems. This module NEVER fabricates a bar — it only sorts, de-duplicates,
// and reports anomalies (missing / duplicate / out-of-order / invalid OHLC /
// outliers). Outlier flags are advisory only; flagged bars are never dropped.
//
// ── SourceMode ──────────────────────────────────────────────────────────────
//   "live"    — real market data from a configured live provider
//   "demo"    — data from a demo/paper trading context (same price, different
//               account mode; applies to MT5 demo bridge when recognized)
//   "mock"    — synthetic/simulated data from mockProvider or the TwelveData
//               shim (twelveData_mock_shim). Never safe as tradable truth.
//   "dev"     — developer test data (explicit dev/test source label)
//   "unknown" — provider not recognized; treat conservatively
//
// ── PriceBasis ──────────────────────────────────────────────────────────────
//   "BID"       — MT5 broker OHLC bars are built from bid-side prices
//   "MID"       — composite midpoint (TwelveData forex/metals)
//   "LAST"      — last-trade price (indices, stocks, crypto)
//   "SYNTHETIC" — Deriv volatility algorithm (no real underlying)
//   "UNKNOWN"   — provider not identified or mapping unclear
//
// ── QualityFlag (per-candle advisory flags) ─────────────────────────────────
// Flags are additive and non-exclusive. Multiple flags may appear on one bar.
//   OHLC_INVALID           — high < low, or O/C outside H/L range
//   TIMESTAMP_INVALID       — bar timestamp unparseable or negative
//   OUTLIER_SPIKE          — single-bar close-to-close move far beyond neighbors
//   OUTLIER_WICK           — wick-to-range ratio extreme for this asset class
//   ZERO_VOLUME_GHOST       — zero volume on a non-synthetic bar (data gap signal)
//   HISTORICAL_PERIOD_SHIFT — bar's price is from a significantly different
//                             price epoch (e.g. XAUUSD 2023 ~$2000 bars in a
//                             chart currently priced at ~$4300). Real history;
//                             NOT a bad tick. Flag helps chart layer auto-scale.
//   FORMING_BAR            — bar's close time is in the future (still open)
//   MOCK_DATA              — bar originated from a mock/simulation provider
//   DUPLICATE_BUCKET        — another bar at this openTime exists (collapsed)
//   STALE_FROM_PREV_TF     — bar appears to be a stale carry-over from a
//                            different timeframe (gap >> 2x expected interval)
//
// ── Timestamp convention ────────────────────────────────────────────────────
//   - Deriv / MT5 candle `time` is the bar OPEN epoch → openTime = time,
//     closeTime = openTime + interval.
//   - Assistant-real candle `time` is the bar CLOSE timestamp → closeTime =
//     time, openTime = closeTime - interval.
//   - Unknown defaults to open-based.
// In all cases closeTime - openTime === one timeframe interval.

import type { Candle } from "../types.js";
import { timeframeMs, type ChartTimeframe } from "./timeframes.js";
import { isSlotExpected, type WeeklyPresenceProfile } from "./sessionProfile.js";

/** Isolated one-off single-slot closures tolerated before counting as missing. */
const ISOLATED_CLOSURE_TOLERANCE = 2;

// ── Public type exports ──────────────────────────────────────────────────────

export type SourceMode = "live" | "demo" | "mock" | "dev" | "unknown";

export type PriceBasis = "BID" | "MID" | "LAST" | "SYNTHETIC" | "UNKNOWN";

export type QualityFlag =
  | "OHLC_INVALID"
  | "TIMESTAMP_INVALID"
  | "OUTLIER_SPIKE"
  | "OUTLIER_WICK"
  | "ZERO_VOLUME_GHOST"
  | "HISTORICAL_PERIOD_SHIFT"
  | "FORMING_BAR"
  | "MOCK_DATA"
  | "DUPLICATE_BUCKET"
  | "STALE_FROM_PREV_TF";

// ── NormalizedChartCandle (= VerifiedCandle contract) ────────────────────────
// Every field produced by normalizeCandles is always present (never undefined).

export interface NormalizedChartCandle {
  // ── Core identity ──────────────────────────────────────────────────────
  symbol: string;
  displaySymbol: string;
  timeframe: ChartTimeframe;

  // ── Time bounds ────────────────────────────────────────────────────────
  openTime: string;   // ISO 8601 — bar open (always bar-open-based)
  closeTime: string;  // ISO 8601 — bar close (openTime + one interval)

  // ── OHLCV ──────────────────────────────────────────────────────────────
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;         // 0 when provider does not supply volume
  tickVolume: number | null; // verified tick count or null

  // ── Source & mode ──────────────────────────────────────────────────────
  source: string;          // provider id (e.g. "deriv", "assistant_real:twelve_data")
  sourceMode: SourceMode;  // live / mock / demo / dev / unknown
  priceBasis: PriceBasis;  // BID / MID / LAST / SYNTHETIC / UNKNOWN
  providerSymbol: string | null; // provider's own symbol string (e.g. "EUR/USD")
  brokerSymbol: string | null;   // MT5 broker symbol when source is mt5_broker; null otherwise

  // ── Completion status ──────────────────────────────────────────────────
  isComplete: boolean;  // false for the still-forming most-recent bar
  isFinal: boolean;     // alias for isComplete (VerifiedCandle contract name)
  // True ONLY for a server-synthesized real-time tip composed from live ticks
  // (Task #496). Distinct from isComplete: a closed provider bar is
  // isComplete=true/isForming=false; the live tick tip is
  // isComplete=false/isForming=true. Analysis/Ruby/chart-intelligence MUST
  // exclude isForming bars (closed-bars-only). Never persisted.
  isForming: boolean;
  receivedAt: string;   // ISO 8601 — when this batch was fetched from the provider

  // ── Quality ────────────────────────────────────────────────────────────
  qualityFlags: QualityFlag[]; // advisory flags; never causes bar to be dropped
}

export interface SequenceAnomalies {
  missingCandleCount: number;
  duplicateCount: number;
  outOfOrderCount: number;
  /** Bars whose timestamp was unparseable (dropped from output) or whose OHLC is internally inconsistent. */
  invalidOhlcCount: number;
  outlierSpikeCount: number;
  outlierWickCount: number;
  zeroVolumeGhostCount: number;
  historicalPeriodShiftCount: number;
  /**
   * Bars whose price decimal-place count is inconsistent with the symbol's
   * stated pricePrecision (from SymbolProfile). 0 when pricePrecision is not
   * supplied to normalizeCandles. Non-zero indicates a provider returning data
   * at the wrong scale (e.g. integer pips instead of decimal prices).
   */
  precisionViolationCount: number;
  /**
   * Skipped slots classified as market-closed by the session presence profile
   * (weekend / off-hours). EXCLUDED from missingCandleCount. 0 when no profile
   * was applied (synthetics / 24-7 / insufficient history).
   */
  marketClosedSlotCount: number;
  /**
   * Isolated single-slot absences in normally-traded weekly slots (e.g. a
   * holiday or a one-off illiquid print / DST edge). Tolerated up to an internal
   * threshold before they begin contributing to missingCandleCount.
   */
  isolatedClosureCount: number;
  /** True when a session presence profile with sufficient history drove the gap classification. */
  sessionProfileApplied: boolean;
  /**
   * Distinct completeness reason for non-naive paths:
   *   "isolated_closure_or_gap"                 — only isolated one-off closures seen
   *   "insufficient_history_for_session_profile" — session instrument but no trustworthy profile
   * null when none applies.
   */
  qualityReason: string | null;
}

// ── OHLC validity ────────────────────────────────────────────────────────────

/** True when a single bar's OHLC values are internally consistent and finite. */
export function isValidOhlc(c: Pick<Candle, "open" | "high" | "low" | "close">): boolean {
  const { open, high, low, close } = c;
  for (const v of [open, high, low, close]) {
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
    if (v < 0) return false;
  }
  if (high < low) return false;
  if (high < Math.max(open, close)) return false;
  if (low > Math.min(open, close)) return false;
  return true;
}

// ── Source → mode / price basis mapping ─────────────────────────────────────

/** Derive the SourceMode from a provider id string. */
export function sourceModeFromProvider(source: string | null): SourceMode {
  if (!source) return "unknown";
  // Explicit mock/shim sources — NEVER safe as tradable truth
  if (source === "mock" || source === "twelveData_mock_shim" || source.includes("mock_shim")) return "mock";
  if (source === "dev" || source.includes("_dev") || source.includes("_test")) return "dev";
  // Demo / live MT5 — actual account mode determines this; conservatively "live"
  // (the account mode is managed by the trading-mode layer, not the data layer)
  if (source === "mt5_broker") return "live";
  // Deriv and real REST adapters are live data
  if (source === "deriv") return "live";
  if (source.startsWith("assistant_real:")) return "live";
  return "unknown";
}

/** Derive the PriceBasis from a provider id string. */
export function priceBasisFromProvider(source: string | null): PriceBasis {
  if (!source) return "UNKNOWN";
  if (source === "mt5_broker") return "BID"; // MT5 OHLC bars are bid-based
  if (source === "deriv") return "SYNTHETIC";
  // TwelveData, Polygon: forex/metals → MID; indices/stocks/crypto → LAST
  // We don't have asset-class context here — caller should override if known.
  if (source.startsWith("assistant_real:")) return "MID";
  if (source.includes("mock") || source.includes("shim")) return "UNKNOWN";
  return "UNKNOWN";
}

/** Derive the provider's own symbol string from source + symbol. */
function providerSymbolFrom(source: string | null, symbol: string): string | null {
  if (!source) return null;
  // TwelveData maps EURUSD → EUR/USD etc — this is the most common case.
  // We keep it simple: return the ARX symbol; the symbolNormalizer layer applies
  // the actual mapping before the provider call, so by the time we see the
  // candles, the source already fetched the right symbol.
  if (source.startsWith("assistant_real:")) return null; // not tracked at this layer
  if (source === "deriv") return null; // derivProvider resolves internally
  if (source === "mt5_broker") return symbol; // broker symbol = ARX symbol for MT5
  return null;
}

/** Whether the raw router `time` should be read as the bar open or close. */
function timeBasis(source: string | null): "open" | "close" {
  if (!source) return "open";
  if (source.startsWith("assistant_real")) return "close";
  return "open"; // deriv / mt5_broker / unknown → epoch is bar open
}

// ── Outlier / quality flag detection ─────────────────────────────────────────
//
// All detection is done in a SECOND PASS over the already-normalized array
// so that each bar is evaluated in context of its neighbors (spike detection)
// and the recent price cluster (historical period shift).
//
// Rules:
//   OUTLIER_SPIKE: |close[i] - close[i-1]| > spikeAtrMultiple * ATR(10)
//     where ATR(10) = mean(high-low) over the preceding 10 bars.
//     Only flagged when >= 5 prior bars exist for ATR calculation.
//
//   OUTLIER_WICK: For D1 and H4 bars —
//     upper_wick = high - max(open, close)
//     lower_wick = min(open, close) - low
//     max_wick = max(upper_wick, lower_wick)
//     body = abs(close - open)
//     range = high - low
//     flagged when range > 0 AND body > 0 AND
//       max_wick / range > wickRatioThreshold AND max_wick > body * 3
//
//   ZERO_VOLUME_GHOST: volume === 0 for a non-synthetic bar (source !== "deriv").
//     Synthetics always have volume=0 (no traded volume); this is expected.
//
//   HISTORICAL_PERIOD_SHIFT: A bar's median of (open+close)/2 is more than
//     historicalShiftThreshold below or above the median of the LAST 30 bars.
//     Applied only when >= 30 candles exist in the dataset.
//     This flag identifies legitimate old-epoch history (not bad ticks).

interface OutlierOpts {
  spikeAtrMultiple: number;
  wickRatioThreshold: number;
  historicalShiftThreshold: number;
  isSyntheticSource: boolean;
  timeframe: ChartTimeframe;
}

const DEFAULT_OUTLIER_OPTS: OutlierOpts = {
  spikeAtrMultiple: 6,
  wickRatioThreshold: 0.8,
  historicalShiftThreshold: 0.4,
  isSyntheticSource: false,
  timeframe: "M5",
};

interface IntermediateCandle extends Pick<NormalizedChartCandle, "open" | "high" | "low" | "close" | "volume" | "isComplete"> {
  openTime: string;
}

/**
 * Count the meaningful decimal places in a number, stripping trailing zeros
 * that are artefacts of floating-point representation.
 * Examples: 1.07330 → 4, 1.0 → 0, 1234.56789012 → 11, 3000 → 0
 */
function decimalPlaces(v: number): number {
  const s = String(v);
  const dot = s.indexOf(".");
  if (dot < 0) return 0;
  // Remove trailing zeros (float representation noise)
  return s.slice(dot + 1).replace(/0+$/, "").length;
}

function computeOutlierFlags(
  candles: IntermediateCandle[],
  opts: OutlierOpts,
): QualityFlag[][] {
  const n = candles.length;
  const flags: QualityFlag[][] = Array.from({ length: n }, () => []);

  // Compute median of mid-price for recent 30 bars (from the tail of the array)
  const recentWindow = 30;
  let recentMedian: number | null = null;
  if (n >= recentWindow) {
    const midPrices = candles.slice(n - recentWindow).map((c) => (c.open + c.close) / 2);
    const sorted = [...midPrices].sort((a, b) => a - b);
    recentMedian = sorted[Math.floor(recentWindow / 2)]!;
  }

  for (let i = 0; i < n; i++) {
    const c = candles[i]!;
    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const maxWick = Math.max(upperWick, lowerWick);

    // OUTLIER_SPIKE — requires at least 5 prior bars for ATR
    if (i >= 5) {
      const window = candles.slice(Math.max(0, i - 10), i);
      const meanRange = window.reduce((s, w) => s + (w.high - w.low), 0) / window.length;
      if (meanRange > 0) {
        const prevClose = candles[i - 1]!.close;
        const closeMove = Math.abs(c.close - prevClose);
        if (closeMove > opts.spikeAtrMultiple * meanRange) {
          flags[i]!.push("OUTLIER_SPIKE");
        }
      }
    }

    // OUTLIER_WICK — D1 and H4 only (where multi-day wicks are meaningful)
    if (opts.timeframe === "D1" || opts.timeframe === "H4") {
      if (range > 0 && body > 0 && maxWick / range > opts.wickRatioThreshold && maxWick > body * 3) {
        flags[i]!.push("OUTLIER_WICK");
      }
    }

    // ZERO_VOLUME_GHOST — skip for synthetics (deriv always has volume=0)
    if (!opts.isSyntheticSource && c.volume === 0) {
      flags[i]!.push("ZERO_VOLUME_GHOST");
    }

    // HISTORICAL_PERIOD_SHIFT — only when we have a reliable recent median
    if (recentMedian != null && recentMedian > 0) {
      const midPrice = (c.open + c.close) / 2;
      const deviation = Math.abs(midPrice - recentMedian) / recentMedian;
      if (deviation > opts.historicalShiftThreshold) {
        flags[i]!.push("HISTORICAL_PERIOD_SHIFT");
      }
    }
  }

  return flags;
}

// ── Main normalization ────────────────────────────────────────────────────────

export interface NormalizeOptions {
  symbol: string;
  displaySymbol: string;
  timeframe: ChartTimeframe;
  source: string | null;
  now?: number;
  receivedAt?: string;
  priceBasisOverride?: PriceBasis;
  // Outlier thresholds — callers should supply from SymbolProfile when available
  spikeAtrMultiple?: number;
  wickRatioThreshold?: number;
  historicalShiftThreshold?: number;
  /**
   * Expected decimal-place count for prices in this symbol, from SymbolProfile.
   * When supplied, bars with inconsistent precision are counted in
   * SequenceAnomalies.precisionViolationCount.
   */
  pricePrecision?: number;
  /**
   * True when this instrument has a market session (NOT 24/7) — forex, metals,
   * indices, stocks. Enables session-aware gap classification. False/undefined
   * for synthetics and crypto, which keep the naive "every skipped slot is
   * missing" count.
   */
  sessionExpected?: boolean;
  /**
   * Weekly presence profile (pure data, learned from observed broker history)
   * used to exclude weekend/off-hours slots from the missing-bar count. When
   * absent (or with insufficient history) for a session instrument, missing
   * bars are NOT asserted — the calc fails honest rather than over-counting.
   */
  sessionProfile?: WeeklyPresenceProfile | null;
}

/**
 * Normalize raw router candles into chart candles, sorted ascending by open
 * time, with duplicates collapsed (latest wins) and the trailing bar flagged
 * incomplete when it is still forming. Returns the normalized list plus the
 * anomaly counts observed BEFORE de-duplication/sorting (so we report the
 * truth about what the provider returned).
 *
 * Phase 1 extension: every returned candle now carries the full VerifiedCandle
 * shape (sourceMode, priceBasis, isFinal, receivedAt, providerSymbol,
 * brokerSymbol, qualityFlags). Outlier detection (OUTLIER_SPIKE, OUTLIER_WICK,
 * ZERO_VOLUME_GHOST, HISTORICAL_PERIOD_SHIFT) runs in a second pass.
 */
export function normalizeCandles(
  raw: Candle[],
  opts: NormalizeOptions,
): { candles: NormalizedChartCandle[]; anomalies: SequenceAnomalies } {
  const { symbol, displaySymbol, timeframe, source } = opts;
  const now = opts.now ?? Date.now();
  const receivedAt = opts.receivedAt ?? new Date(now).toISOString();
  const intervalMs = timeframeMs(timeframe);
  const basis = timeBasis(source);
  const sourceLabel = source ?? "unknown";

  const sourceMode = sourceModeFromProvider(source);
  const priceBasis = opts.priceBasisOverride ?? priceBasisFromProvider(source);
  const isSyntheticSource = source === "deriv";
  const providerSym = providerSymbolFrom(source, symbol);
  const brokerSym = source === "mt5_broker" ? symbol : null;
  const isMockSource = sourceMode === "mock";

  let invalidOhlcCount = 0;
  let outOfOrderCount = 0;
  let duplicateCount = 0;
  let missingCandleCount = 0;

  // 1) Map raw → intermediate with open/close times.
  //    Timestamp-invalid bars are DROPPED here (counted in invalidOhlcCount but
  //    never pushed to intermediate). This upholds the API contract that every
  //    emitted candle has valid ISO openTime/closeTime strings. OHLC-invalid bars
  //    with valid timestamps are kept — they are flagged and quality is downgraded
  //    but they represent real provider-returned bars.
  const intermediate: (IntermediateCandle & { rawIndex: number })[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    const t = Date.parse(c.time);
    const tsInvalid = !Number.isFinite(t) || t < 0;
    if (tsInvalid) {
      invalidOhlcCount++; // counted but never emitted — ISO contract must be upheld
      continue;
    }
    const openMs = basis === "open" ? t : t - intervalMs;
    const closeMs = openMs + intervalMs;
    if (!isValidOhlc(c)) invalidOhlcCount++;
    intermediate.push({
      rawIndex: i,
      open: c.open, high: c.high, low: c.low, close: c.close,
      volume: typeof c.volume === "number" && Number.isFinite(c.volume) ? c.volume : 0,
      isComplete: closeMs <= now,
      openTime: new Date(openMs).toISOString(),
    });
  }

  // 2) Detect out-of-order in provider-supplied order.
  //    All bars in intermediate have valid timestamps (tsInvalid were dropped above).
  for (let i = 1; i < intermediate.length; i++) {
    const curr = intermediate[i]!;
    const prev = intermediate[i - 1]!;
    if (Date.parse(curr.openTime) < Date.parse(prev.openTime)) outOfOrderCount++;
  }

  // 3) Sort ascending by open time.
  const sorted = [...intermediate].sort((a, b) =>
    Date.parse(a.openTime) - Date.parse(b.openTime),
  );

  // 4) Collapse duplicates (same open time) — latest wins — and count them.
  //    The SURVIVING candle (the one that replaces the earlier duplicate) is
  //    marked with DUPLICATE_BUCKET so per-candle traceability is preserved:
  //    the flag signals "this bar won a dedup collision at this open time".
  //    This matches the contract description: "another bar at this openTime
  //    exists (collapsed)".
  const deduped: (typeof sorted[number] & { isDupWinner?: boolean })[] = [];
  for (const c of sorted) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.openTime === c.openTime) {
      duplicateCount++;
      // Replace previous with the later (winning) bar and mark it
      deduped[deduped.length - 1] = { ...c, isDupWinner: true };
      continue;
    }
    deduped.push(c);
  }

  // 5) Count missing bars (gaps > 1 interval) between consecutive open times.
  //    We count gaps > 2 intervals as "stale from previous timeframe" candidates.
  //
  //    Session-aware completeness: a naive 24/7 calendar mistakes weekend and
  //    off-hours closures for missing bars on session instruments (forex,
  //    stocks, indices) — e.g. EURUSD H1 shows ~96 "missing" bars across one
  //    weekend, falsely downgrading a complete feed to PARTIAL. When the caller
  //    supplies a weekly presence profile with sufficient history, skipped slots
  //    that fall in never-traded weekly positions are MARKET-CLOSED and excluded.
  //    A maximal run of >=2 consecutive absent EXPECTED slots is a genuine data
  //    gap; an isolated single absent expected slot is a one-off closure
  //    (holiday / illiquid print / DST edge), tolerated up to a small threshold.
  //    Synthetics / 24-7 instruments keep the naive count, unchanged.
  const stalePrevTfSet = new Set<number>(); // indices in deduped that are suspect
  let marketClosedSlotCount = 0;
  let isolatedClosureCount = 0;
  let sessionProfileApplied = false;
  let qualityReason: string | null = null;

  const sessionProfile = opts.sessionProfile ?? null;
  const sessionAware =
    opts.sessionExpected === true &&
    sessionProfile != null &&
    sessionProfile.sufficientHistory;

  if (sessionAware && sessionProfile) {
    sessionProfileApplied = true;
    const runs: number[] = []; // lengths of maximal consecutive absent-EXPECTED slot runs
    for (let i = 1; i < deduped.length; i++) {
      const prevOpen = Date.parse(deduped[i - 1]!.openTime);
      const currOpen = Date.parse(deduped[i]!.openTime);
      const steps = Math.round((currOpen - prevOpen) / intervalMs);
      if (steps > 2) stalePrevTfSet.add(i);
      if (steps <= 1) continue;
      // Walk each skipped slot strictly between prev and curr.
      let run = 0;
      for (let s = 1; s < steps; s++) {
        const slotOpen = prevOpen + s * intervalMs;
        if (isSlotExpected(sessionProfile, slotOpen)) {
          run++;
        } else {
          marketClosedSlotCount++;
          if (run > 0) {
            runs.push(run);
            run = 0;
          }
        }
      }
      if (run > 0) runs.push(run);
    }
    let genuineMissing = 0;
    for (const r of runs) {
      if (r >= 2) genuineMissing += r;
      else isolatedClosureCount++; // r === 1
    }
    const isolatedOverflow = Math.max(0, isolatedClosureCount - ISOLATED_CLOSURE_TOLERANCE);
    missingCandleCount = genuineMissing + isolatedOverflow;
    if (genuineMissing === 0 && isolatedClosureCount > 0) {
      qualityReason = "isolated_closure_or_gap";
    }
  } else if (opts.sessionExpected === true) {
    // Session instrument but no trustworthy presence profile (missing /
    // insufficient history). We cannot honestly tell weekend/closed slots from
    // genuine gaps, so we do NOT assert missing bars — fail honest. Still flag
    // large gaps as stale-prev-TF candidates (advisory only).
    qualityReason = "insufficient_history_for_session_profile";
    for (let i = 1; i < deduped.length; i++) {
      const prevOpen = Date.parse(deduped[i - 1]!.openTime);
      const currOpen = Date.parse(deduped[i]!.openTime);
      const steps = Math.round((currOpen - prevOpen) / intervalMs);
      if (steps > 2) stalePrevTfSet.add(i);
    }
  } else {
    // 24-7 / synthetic / unknown — naive count (unchanged legacy behavior).
    for (let i = 1; i < deduped.length; i++) {
      const prevOpen = Date.parse(deduped[i - 1]!.openTime);
      const currOpen = Date.parse(deduped[i]!.openTime);
      const steps = Math.round((currOpen - prevOpen) / intervalMs);
      if (steps > 1) missingCandleCount += steps - 1;
      if (steps > 2) stalePrevTfSet.add(i);
    }
  }

  // 6) Run outlier detection over deduped.
  const outlierFlags = computeOutlierFlags(deduped, {
    spikeAtrMultiple: opts.spikeAtrMultiple ?? DEFAULT_OUTLIER_OPTS.spikeAtrMultiple,
    wickRatioThreshold: opts.wickRatioThreshold ?? DEFAULT_OUTLIER_OPTS.wickRatioThreshold,
    historicalShiftThreshold: opts.historicalShiftThreshold ?? DEFAULT_OUTLIER_OPTS.historicalShiftThreshold,
    isSyntheticSource,
    timeframe,
  });

  // Build index: openTime → outlier flags, for merging with deduped
  const outlierByOpen = new Map<string, QualityFlag[]>();
  for (let i = 0; i < deduped.length; i++) {
    outlierByOpen.set(deduped[i]!.openTime, outlierFlags[i] ?? []);
  }

  // Precision violation check — count bars whose price decimal places deviate
  // significantly from the symbol's expected pricePrecision. Two cases:
  //   (a) prices have MORE than pricePrecision+2 decimal places → provider
  //       returning spurious float noise or wrong scale.
  //   (b) ALL prices are integers when pricePrecision >= 3 → provider returning
  //       integer pips/points instead of decimal prices (scale bug).
  // We only count bars that aren't already flagged OHLC_INVALID to avoid
  // double-penalising malformed data.
  let precisionViolationCount = 0;
  if (opts.pricePrecision != null) {
    const maxDP = opts.pricePrecision + 2; // tolerance for float representation noise
    const minExpectedDP = opts.pricePrecision >= 3 ? 1 : 0; // 0 = no "all-integer" check
    for (const c of deduped) {
      if (!isValidOhlc(c)) continue; // OHLC_INVALID bars already counted above
      const prices = [c.open, c.high, c.low, c.close];
      const dps = prices.map(decimalPlaces);
      const anyExcess = dps.some(d => d > maxDP);
      const allIntegers = minExpectedDP > 0 && dps.every(d => d === 0);
      if (anyExcess || allIntegers) precisionViolationCount++;
    }
  }

  // 7) Build final NormalizedChartCandle array.
  let outlierSpikeCount = 0;
  let outlierWickCount = 0;
  let zeroVolumeGhostCount = 0;
  let historicalPeriodShiftCount = 0;

  const candles: NormalizedChartCandle[] = deduped.map((c, idx) => {
    const flags: QualityFlag[] = [];

    // Per-bar OHLC validity check (timestamp is always valid — tsInvalid bars dropped in step 1)
    if (!isValidOhlc(c)) flags.push("OHLC_INVALID");

    // Mock source flag
    if (isMockSource) flags.push("MOCK_DATA");

    // Forming bar
    if (!c.isComplete) flags.push("FORMING_BAR");

    // Outlier flags from second pass
    const oFlags = outlierByOpen.get(c.openTime) ?? [];
    for (const f of oFlags) {
      flags.push(f);
      if (f === "OUTLIER_SPIKE") outlierSpikeCount++;
      if (f === "OUTLIER_WICK") outlierWickCount++;
      if (f === "ZERO_VOLUME_GHOST") zeroVolumeGhostCount++;
      if (f === "HISTORICAL_PERIOD_SHIFT") historicalPeriodShiftCount++;
    }

    // Duplicate-bucket winner: this bar replaced an earlier bar at the same openTime
    if ("isDupWinner" in c && c.isDupWinner) flags.push("DUPLICATE_BUCKET");

    // Stale-from-previous-TF heuristic (large gap before this bar)
    if (stalePrevTfSet.has(idx)) flags.push("STALE_FROM_PREV_TF");

    const openMs = Date.parse(c.openTime); // always valid — tsInvalid dropped in step 1
    const closeMs = openMs + intervalMs;

    return {
      symbol,
      displaySymbol,
      timeframe,
      openTime: c.openTime,
      closeTime: new Date(closeMs).toISOString(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      tickVolume: null,
      source: sourceLabel,
      sourceMode,
      priceBasis,
      providerSymbol: providerSym,
      brokerSymbol: brokerSym,
      isComplete: c.isComplete,
      isFinal: c.isComplete,
      // Provider bars are never the synthesized live tip; the forming-bar
      // composer is the ONLY producer that sets isForming=true.
      isForming: false,
      receivedAt,
      qualityFlags: flags,
    };
  });

  return {
    candles,
    anomalies: {
      missingCandleCount,
      duplicateCount,
      outOfOrderCount,
      invalidOhlcCount,
      outlierSpikeCount,
      outlierWickCount,
      zeroVolumeGhostCount,
      historicalPeriodShiftCount,
      precisionViolationCount,
      marketClosedSlotCount,
      isolatedClosureCount,
      sessionProfileApplied,
      qualityReason,
    },
  };
}

/**
 * How many timeframe intervals the most-recent bar trails the current expected
 * bar by. 0/1 means the feed is current (providers that only return CLOSED
 * bars will naturally trail by 1). Larger values mean the feed is lagging.
 * Returns null when there are no candles.
 */
export function trailingIntervalGap(
  candles: NormalizedChartCandle[],
  timeframe: ChartTimeframe,
  now = Date.now(),
): number | null {
  if (candles.length === 0) return null;
  const intervalMs = timeframeMs(timeframe);
  const lastOpen = Date.parse(candles[candles.length - 1]!.openTime);
  const expectedLatestOpen = Math.floor(now / intervalMs) * intervalMs;
  return Math.round((expectedLatestOpen - lastOpen) / intervalMs);
}

/**
 * Trailing-interval gap computed directly from RAW router candles, applying the
 * SAME open-time basis (`timeBasis`) + interval math `normalizeCandles` uses —
 * WITHOUT a full normalization/truth pass. This lets non-chart analysis surfaces
 * (e.g. the market scanner) classify feed freshness with the identical
 * trailing-interval rule the chart feed-status contract uses, so a fast
 * timeframe the chart calls `stale`/`delayed` can never be reported `live`
 * elsewhere. Returns null when no candle has a parseable timestamp.
 *
 * Equivalence to the chart path: `normalizeCandles` sorts ascending and derives
 * each `openTime` from the raw `time` via `timeBasis(source)`, then
 * `trailingIntervalGap` reads the LAST (latest) bar. Taking the MAX open-ms over
 * the raw bars here yields the same latest-bar open, so the gap matches by
 * construction. (The forming-tip display path is intentionally NOT applied — the
 * scanner is a closed-bar analysis surface and mirrors the chart's analysis,
 * `includeFormingTip=false`, freshness.)
 */
export function rawTrailingIntervalGap(
  raw: Candle[],
  source: string | null,
  timeframe: ChartTimeframe,
  now = Date.now(),
): number | null {
  if (raw.length === 0) return null;
  const intervalMs = timeframeMs(timeframe);
  const basis = timeBasis(source);
  let latestOpenMs: number | null = null;
  for (const c of raw) {
    const t = Date.parse(c.time);
    if (!Number.isFinite(t)) continue;
    const openMs = basis === "open" ? t : t - intervalMs;
    if (latestOpenMs == null || openMs > latestOpenMs) latestOpenMs = openMs;
  }
  if (latestOpenMs == null) return null;
  const expectedLatestOpen = Math.floor(now / intervalMs) * intervalMs;
  return Math.round((expectedLatestOpen - latestOpenMs) / intervalMs);
}
