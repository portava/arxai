// ── Shared market-data freshness module ──────────────────────────────────────
//
// ONE definition of "how fresh is this data" for every analysis/chart surface:
//   - chart truth service (chartDataService)
//   - per-timeframe candle truth engine (candleTruthEngine)
//   - the MT5 broker in-memory provider (mt5Provider)
//   - the assistant composite market provider (marketProvider)
//
// Before this module each surface kept its own private trailing-interval / TTL
// constants, so a feed could read "clean" on one surface and "stale" on
// another. Centralising the thresholds + the classification helpers means a
// 1m delayed/stale feed is surfaced identically everywhere.
//
// SAFETY SCOPE: this is ANALYSIS / DISPLAY truth only. It NEVER touches
// execution routing, fills, balance, equity, margin, broker execution price,
// the 23-gate live pipeline, the Risk Governor, AACI, or the Security
// Handshake. It also never fabricates data — it only *classifies* data that a
// provider already returned (or honestly reports the absence of data).
//
// CACHE-FRESHNESS vs AI-USABILITY: a cached response that is technically still
// within its cache TTL may STILL not be AI-usable. The cache TTLs below only
// govern "may I reuse this without re-fetching"; AI-usability is derived purely
// from the observed candle freshness/quality (aiUsable === quality "clean").

// ── Trailing-interval thresholds (candle freshness) ──────────────────────────
//
// "Trailing intervals" = how many timeframe bar-intervals the newest bar lags
// behind the current expected bar. Providers that only return CLOSED bars will
// naturally trail by 1, so trailing <= 1 is still "clean". A naive
// "latest bar != now" check would false-flag every healthy closed-bar feed.

/** Newest bar trails the current bar by AT MOST this many intervals → clean. */
export const LIVE_TRAILING_INTERVALS = 1;
/** Trailing by exactly this many intervals (but < stale) → delayed. */
export const DELAYED_TRAILING_INTERVALS = 2;
/** Trailing by >= this many intervals → stale (not safe as live truth). */
export const STALE_TRAILING_INTERVALS = 3;

// ── MT5 broker in-memory provider TTLs ───────────────────────────────────────

/** A broker candle/quote series is usable for this long after its last push. */
export const MT5_CANDLE_TTL_MS = 5 * 60_000; // 5 minutes
/** The MT5 provider counts as "connected" when something pushed this recently. */
export const MT5_FEED_FRESH_MS = 60_000; // 60s

// ── Assistant composite-provider TTLs ────────────────────────────────────────

/** A cached third-party quote is fresh (reusable) for this long. */
export const QUOTE_FRESH_TTL_MS = 15_000; // 15s

// ── Forming-tip (real-time tick) freshness (Task #496) ───────────────────────
//
// A server-synthesized forming bar (isForming) ticks from live EA ticks (~2s).
// Its liveness is governed by the AGE OF THE LAST TICK, not the trailing-
// interval gap: a forming tip pins the newest bar to the CURRENT interval, so
// trailingIntervals would read 0 and falsely report "clean" even after the tick
// stream went silent. When a fresh forming tip is present we therefore classify
// freshness off the tick age and freeze (mark stale) when ticks stop.
/** A forming tip is "live" when its last tick is no older than this. */
export const FORMING_TIP_LIVE_MS = 15_000; // 15s — mirrors the EA tick cadence budget
/**
 * Broker-time staleness threshold for the "market frozen / closed" indicator.
 * When a market is closed (weekend / holiday / broker-specific hours) the EA
 * keeps streaming the broker's LAST quote — identical bid/ask and an unchanging
 * broker timestamp. When the latest tick's BROKER time lags server-now by more
 * than this, the quote is frozen, so a still-forming bar must read as
 * closed-market rather than a broken feed. Derived purely from real per-tick
 * broker-time staleness — NOT a hardcoded calendar — so it covers holidays and
 * broker-specific hours. Set well beyond any live-market quote cadence (majors
 * update sub-second; even thin instruments quote within a minute) so it can
 * never false-flag a genuinely live feed. Display/telemetry only — it never
 * touches a gate, fill, balance, or any execution path.
 */
export const MARKET_FROZEN_BROKER_STALE_MS = 5 * 60_000; // 5 minutes
/**
 * Wall-clock freshness REQUIRED before we are allowed to call the market frozen.
 * A closed market is NOT the same as a dead feed: when the market is closed the
 * EA keeps streaming the broker's last quote, so ticks KEEP ARRIVING (wall-clock
 * fresh) while the broker timestamp stays frozen. A genuinely broken/disconnected
 * feed stops arriving entirely (wall-clock goes stale). We therefore only assert
 * "market closed" when broker time is stale AND ticks are still arriving; once
 * the wall-clock receive time ages past this, we stop claiming closed-market and
 * let the normal stale/broken-feed surfaces speak. Generous enough to ride over
 * weekend tick-throttling, short enough that a dead mid-week feed only briefly
 * lingers before degrading. Display/telemetry only — never a gate.
 */
export const MARKET_FROZEN_WALL_FRESH_MS = 2 * 60_000; // 2 minutes
/** A provider's last successful fetch older than this counts as stale. */
export const QUOTE_STALE_AFTER_MS = 5 * 60_000; // 5 minutes
/** A cached third-party candle window is reusable for this long. */
export const ASSISTANT_CANDLE_CACHE_TTL_MS = 60_000; // 60s
/** A cached news payload is reusable for this long. */
export const ASSISTANT_NEWS_CACHE_TTL_MS = 60_000; // 60s

// ── Types ────────────────────────────────────────────────────────────────────

/** Full feed-quality precedence (highest wins): unavailable > invalid >
 *  partial > stale > delayed > clean (with empty for "reachable, no bars"). */
export type FeedQuality =
  | "clean"
  | "delayed"
  | "stale"
  | "partial"
  | "invalid"
  | "empty"
  | "unavailable";

/** Pure candle-freshness verdict derived only from the trailing-interval gap. */
export type CandleFreshness = "clean" | "delayed" | "stale";

/** Quote-freshness verdict derived from the age of the last quote. */
export type QuoteFreshness = "fresh" | "delayed" | "stale" | "unknown";

// ── Candle freshness ─────────────────────────────────────────────────────────

/**
 * Classify candle freshness from the trailing-interval gap alone. Returns null
 * when the gap is unknown (no candles). A synthetic feed that has history but
 * has NOT yet confirmed a live tick is forced to at-least "delayed" so it can
 * never read "clean" while awaiting confirmation.
 */
export function classifyCandleFreshness(
  trailingIntervals: number | null,
  opts?: { syntheticAwaitingTick?: boolean },
): { freshness: CandleFreshness; stale: boolean } | null {
  if (trailingIntervals == null || !Number.isFinite(trailingIntervals)) return null;
  if (trailingIntervals >= STALE_TRAILING_INTERVALS) {
    return { freshness: "stale", stale: true };
  }
  if (
    trailingIntervals >= DELAYED_TRAILING_INTERVALS ||
    opts?.syntheticAwaitingTick === true
  ) {
    return { freshness: "delayed", stale: false };
  }
  return { freshness: "clean", stale: false };
}

// ── Quote freshness ──────────────────────────────────────────────────────────

/**
 * Classify quote freshness from the age (ms) of the last successful quote.
 * `fresh` within the cache window, `delayed` until the stale cutoff, `stale`
 * beyond it. An unknown/invalid age is treated as stale (fail-honest).
 */
export function classifyQuoteFreshness(
  ageMs: number | null,
): { freshness: QuoteFreshness; fresh: boolean; stale: boolean } {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0) {
    return { freshness: "unknown", fresh: false, stale: true };
  }
  if (ageMs <= QUOTE_FRESH_TTL_MS) return { freshness: "fresh", fresh: true, stale: false };
  if (ageMs <= QUOTE_STALE_AFTER_MS) return { freshness: "delayed", fresh: false, stale: false };
  return { freshness: "stale", fresh: false, stale: true };
}

// ── Forming-tip freshness ────────────────────────────────────────────────────

/**
 * Classify a forming tip's freshness from the age (ms) of its last tick.
 * `clean` while ticks flow within the live window, otherwise `stale` (the tip
 * has frozen — last-known values stay visible but must NOT read live). An
 * unknown/invalid age fails honest → stale.
 */
export function classifyFormingFreshness(
  tickAgeMs: number | null,
): { freshness: "clean" | "stale"; stale: boolean } {
  if (tickAgeMs == null || !Number.isFinite(tickAgeMs) || tickAgeMs < 0) {
    return { freshness: "stale", stale: true };
  }
  if (tickAgeMs <= FORMING_TIP_LIVE_MS) return { freshness: "clean", stale: false };
  return { freshness: "stale", stale: true };
}

// ── Feed-status quality precedence ───────────────────────────────────────────

export interface FeedQualityInputs {
  /** The router/provider call succeeded (a provider answered). */
  routerOk: boolean;
  /** A winning provider/source was identified. */
  hasSource: boolean;
  /** Number of candles returned after normalization/truth validation. */
  candleCount: number;
  /** Trailing-interval gap (null when there are no candles). */
  trailingIntervals: number | null;
  /** Synthetic feed with history but no confirmed live tick yet. */
  syntheticAwaitingTick?: boolean;
  /** Mock/dev data was detected in a live context. */
  mockDataDetected?: boolean;
  /** Integrity-failed bar count (high<low or O/C outside H/L). */
  invalidOhlcCount?: number;
  /** Missing bars (gaps) in the sequence. */
  missingCandleCount?: number;
  /** Duplicate buckets in the sequence. */
  duplicateCount?: number;
  /** Out-of-order bars in the sequence. */
  outOfOrderCount?: number;
  /** Honest router message to surface when the feed is empty/unavailable. */
  routerUserMessage?: string | null;
  /**
   * Session-aware completeness reason (e.g. "isolated_closure_or_gap",
   * "insufficient_history_for_session_profile") from the truth engine. Carried
   * through for transparency — it NEVER changes the quality verdict on its own.
   */
  completenessReason?: string | null;
  /**
   * Task #496 — a server-synthesized forming tip (isForming) is present on the
   * newest bar. When true, freshness is driven by `formingTickAgeMs` instead of
   * the trailing-interval gap (the tip pins the newest bar to the current
   * interval, so trailingIntervals would falsely read 0/clean).
   */
  formingTipPresent?: boolean;
  /** Age (ms) of the last tick folded into the forming tip (null when none). */
  formingTickAgeMs?: number | null;
}

export interface FeedQualityVerdict {
  quality: FeedQuality;
  stale: boolean;
  /** True ONLY when quality is "clean". Cache-availability never makes this true. */
  aiUsable: boolean;
  trailingIntervals: number | null;
  warning: string | null;
  /** Echoed session-aware completeness reason (advisory; does not affect quality). */
  completenessReason: string | null;
}

/**
 * The single quality-precedence evaluator shared by both chart endpoints.
 * Folds the pure candle-freshness verdict into the broader integrity/anomaly
 * precedence so every surface computes feed quality identically.
 */
export function buildFeedStatus(inputs: FeedQualityInputs): FeedQualityVerdict {
  const {
    routerOk,
    hasSource,
    candleCount,
    trailingIntervals,
    syntheticAwaitingTick = false,
    mockDataDetected = false,
    invalidOhlcCount = 0,
    missingCandleCount = 0,
    duplicateCount = 0,
    outOfOrderCount = 0,
    routerUserMessage = null,
    completenessReason = null,
    formingTipPresent = false,
    formingTickAgeMs = null,
  } = inputs;

  const freshness = classifyCandleFreshness(trailingIntervals, { syntheticAwaitingTick });
  // Task #496 — when a live forming tip is present, its tick age (not the
  // trailing-interval gap) governs the freshness verdict. The tip pins the
  // newest bar to the current interval, so the trailing gap would read 0/clean
  // even after ticks went silent; the forming verdict freezes it to stale.
  //
  // TRUTH GUARD: the tip may only take over when the CLOSED bars themselves
  // are within the delayed threshold. Callers pass `trailingIntervals`
  // computed on the closed bars BEFORE the tip is appended (chartDataService),
  // so a stalled closed-candle feed (trailing >= STALE_TRAILING_INTERVALS)
  // with a still-flowing tick stream keeps its honest STALE verdict — a fresh
  // tick can extend liveness, but it can never paper over a multi-interval
  // hole between the newest closed bar and the synthesized tip. A frozen tip
  // can still DOWNGRADE an otherwise-clean feed to stale (unchanged).
  const closedBarsStale = freshness?.stale === true;
  const tipGovernsFreshness = formingTipPresent && !closedBarsStale;
  const formingVerdict = tipGovernsFreshness ? classifyFormingFreshness(formingTickAgeMs) : null;
  const stale = tipGovernsFreshness ? formingVerdict?.stale === true : freshness?.stale === true;

  let quality: FeedQuality;
  let warning: string | null = null;

  if (!routerOk || candleCount === 0) {
    quality = !hasSource && !routerOk ? "unavailable" : "empty";
    warning = routerUserMessage;
  } else if (mockDataDetected) {
    quality = "invalid";
    warning = "Chart data is unavailable — feed is syncing. Please wait.";
  } else if (invalidOhlcCount > 0) {
    quality = "invalid";
    warning = `Candle integrity check failed: ${invalidOhlcCount} bar(s) with invalid OHLC. Not safe for analysis.`;
  } else if (missingCandleCount > 0 || duplicateCount > 0 || outOfOrderCount > 0) {
    quality = "partial";
    warning = `Incomplete sequence: ${missingCandleCount} missing, ${duplicateCount} duplicate, ${outOfOrderCount} out-of-order bar(s).`;
  } else if (tipGovernsFreshness) {
    // Forming-tip path takes over the freshness verdict (integrity checks above
    // still run on the closed bars first) — but ONLY when the closed bars are
    // not themselves stale (see the truth guard above).
    if (formingVerdict?.freshness === "stale") {
      quality = "stale";
      warning = "Live tick stream silent — forming bar frozen.";
    } else {
      quality = "clean";
      warning = null;
    }
  } else if (freshness?.freshness === "stale") {
    quality = "stale";
    warning = formingTipPresent
      // Fresh ticks + stalled closed candles: say exactly which half is broken.
      ? `Feed is stale — closed candles trail the current bar by ${trailingIntervals} intervals (live ticks alone cannot verify the feed).`
      : `Feed is stale — newest bar trails the current bar by ${trailingIntervals} intervals.`;
  } else if (freshness?.freshness === "delayed") {
    quality = "delayed";
    warning = syntheticAwaitingTick
      ? "Feed is awaiting a confirmed live tick — history loaded but not yet real-time."
      : "Feed is delayed — newest bar is not the current bar.";
  } else {
    quality = "clean";
    warning = null;
  }

  const aiUsable = quality === "clean";
  return { quality, stale, aiUsable, trailingIntervals, warning, completenessReason };
}
