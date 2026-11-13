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
// the 18-gate live pipeline, the Risk Governor, AACI, or the Security
// Handshake. It also never fabricates data — it only *classifies* data that a
// provider already returned (or honestly reports the absence of data).
//
// CACHE-FRESHNESS vs AI-USABILITY: a cached response that is technically still
// within its cache TTL may STILL not be AI-usable. The cache TTLs below only
// govern "may I reuse this without re-fetching"; AI-usability is derived purely
// from observed candle freshness/quality and explicit provider delay (aiUsable === quality "clean").

// ── Trailing-interval thresholds (candle freshness) ──────────────────────────
//
// "Trailing intervals" = how many timeframe bar-intervals the newest bar lags
// behind the current expected bar. Providers that only return CLOSED bars will
// naturally trail by 1, so trailing <= 1 is still "clean". A naive
// "latest bar != now" check would false-flag every healthy closed-bar feed.

// The thresholds and classification are the ONE domain rule
// (@workspace/domain/market candleFreshnessRule) the dashboard scanner truth
// uses too, so no board can call a series Live while another calls it Stale.
import {
  LIVE_TRAILING_INTERVALS,
  DELAYED_TRAILING_INTERVALS,
  STALE_TRAILING_INTERVALS,
  classifyTrailingIntervals,
} from "@workspace/domain/market";
/** clean <= LIVE (1) · delayed = DELAYED (2) · stale >= STALE (3) intervals. */
export { LIVE_TRAILING_INTERVALS, DELAYED_TRAILING_INTERVALS, STALE_TRAILING_INTERVALS };
/**
 * Absolute clock-skew allowance (ms) between a producer's clock and this
 * server's clock. A newest bar may OPEN at most this far after `now`: a bar
 * cannot open before its first tick, so anything further ahead is a
 * mis-stamped series (e.g. broker server time read as UTC) whose freshness
 * cannot be confirmed. The allowance is absolute, not "one interval", so a
 * +2h/+3h offset is caught on every timeframe (H2/H4/D1 included). Same value
 * as the Truth evidence tick-time allowance (`TRUTH_EVIDENCE_TICK_SKEW_MS`,
 * lib/domain truth/evidenceClass.ts); a test pins the two together.
 */
export const MAX_FUTURE_CLOCK_SKEW_MS = 5_000;

/**
 * Router/provider note: the producing series was OBSERVED stamped ahead of its
 * own receipt time (newest bar opened after the server received it, beyond
 * MAX_FUTURE_CLOCK_SKEW_MS). Sticky for the life of the stored series, so a
 * mis-stamped series that later stalls (and whose offset then hides the stall)
 * cannot read current.
 */
export const FUTURE_STAMPED_SERIES_NOTE = "FUTURE_STAMPED_SERIES";

/** newestOpenMs − now (ms). Positive = the newest bar opens in the future.
 *  null/non-finite inputs → null (unknown). */
export function newestBarLeadMs(newestOpenMs: number | null | undefined, now: number): number | null {
  if (newestOpenMs == null || !Number.isFinite(newestOpenMs) || !Number.isFinite(now)) return null;
  return newestOpenMs - now;
}

/** Largest broker-clock offset accepted as a measurement (UTC−12 … UTC+14,
 *  plus slack). A larger "offset" is a broken clock, not a time zone. */
export const MAX_BROKER_CLOCK_OFFSET_MS = 15 * 60 * 60_000;

/** A finite offset within MAX_BROKER_CLOCK_OFFSET_MS, else null. */
export function plausibleBrokerClockOffsetMs(offsetMs: unknown): number | null {
  return typeof offsetMs === "number" && Number.isFinite(offsetMs) && Math.abs(offsetMs) <= MAX_BROKER_CLOCK_OFFSET_MS
    ? offsetMs
    : null;
}

/**
 * The measured broker-clock offset (broker epoch ms minus EA UTC epoch ms) an
 * MT5 bar carries on its time-basis evidence (audit H7: basis BROKER_SERVER
 * with `brokerClockOffsetMs`, measured from the pushing bridge's own ticks), or
 * null when it carries none or an implausible one. Used only so the
 * future-stamp checks compare a broker-stamped bar on the UTC clock; it never
 * rewrites a bar time and is never a historical UTC claim.
 */
export function observedBrokerClockMeasurement(evidence: unknown): { offsetMs: number; measuredAtMs: number } | null {
  if (!evidence || typeof evidence !== "object") return null;
  const e = evidence as { brokerClockOffsetMs?: unknown; brokerClockOffsetMeasuredAt?: unknown };
  const offsetMs = plausibleBrokerClockOffsetMs(e.brokerClockOffsetMs);
  const stamp = e.brokerClockOffsetMeasuredAt;
  // A zone-less date depends on the server timezone. An absent date must
  // never become Date.now(): that would manufacture measurement freshness.
  if (offsetMs == null || typeof stamp !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(stamp)) return null;
  const measuredAtMs = Date.parse(stamp);
  return Number.isFinite(measuredAtMs) && measuredAtMs > 0 ? { offsetMs, measuredAtMs } : null;
}

export function measuredBrokerClockOffsetMs(evidence: unknown): number | null {
  const measurement = observedBrokerClockMeasurement(evidence);
  if (!measurement) return null;
  const e = evidence as { basis?: unknown; convertedAtIngest?: unknown };
  // Converted to UTC at ingest: the offset was already removed from the bar
  // time, so nothing remains to subtract (0), and no writer offset applies.
  if (e.basis === "UTC" && e.convertedAtIngest === true) return 0;
  if (e.basis !== "BROKER_SERVER") return null;
  return measurement.offsetMs;
}

/**
 * A bar's open time on the UTC clock for the future-stamp checks: bar time
 * minus a MEASURED broker-clock offset when one is known, else the raw bar
 * time. With no measured offset nothing is converted, so an unconverted broker
 * clock ahead of UTC still reads future-stamped (fail closed).
 */
export function barOpenUtcMs(openMs: number, brokerClockOffsetMs: number | null | undefined): number {
  return brokerClockOffsetMs != null && Number.isFinite(brokerClockOffsetMs) ? openMs - brokerClockOffsetMs : openMs;
}

/**
 * True when the newest bar's recency cannot be confirmed: unknown gap, a
 * newest bar opening more than MAX_FUTURE_CLOCK_SKEW_MS after `now`, or a
 * series the producer observed future-stamped. When the caller does not
 * supply `newestOpenLeadMs`, a negative gap alone cannot separate clock skew
 * from a mis-stamped series, so it fails closed.
 */
export function feedTimestampsUnconfirmed(inputs: {
  trailingIntervals: number | null;
  newestOpenLeadMs?: number | null;
  futureStampObserved?: boolean;
}): boolean {
  const { trailingIntervals, newestOpenLeadMs, futureStampObserved = false } = inputs;
  if (trailingIntervals == null || !Number.isFinite(trailingIntervals)) return true;
  if (futureStampObserved) return true;
  if (newestOpenLeadMs === undefined) return trailingIntervals < 0;
  return newestOpenLeadMs == null || !Number.isFinite(newestOpenLeadMs) || newestOpenLeadMs > MAX_FUTURE_CLOCK_SKEW_MS;
}

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
/**
 * The session fields the scheduled-closure check reads (structurally the
 * chart SymbolProfile.session shape; kept local so this module stays leaf).
 */
export interface WeekendSessionShape {
  alwaysOpen: boolean;
  closedOnWeekends: boolean;
  openHourUtc: number | null;
  closeHourUtc: number | null;
}

/** A scheduled weekend closure window, in epoch ms. */
export interface ScheduledClosure {
  /** Friday close (UTC) the window started at. */
  closedAtMs: number;
  /** Monday open (UTC) the window ends at (the market may reopen earlier — callers must accept observed trading over the schedule). */
  reopensAtMs: number;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * The scheduled weekend closure that contains `nowMs`, or null when the
 * instrument trades 24/7, has no weekend closure, or `nowMs` is outside the
 * window [Fri closeHourUtc, Mon openHourUtc). Approximate by design (session
 * hours are static UTC estimates), so callers use it ONLY to withhold a
 * "live" claim for a series whose newest bar predates the close and that
 * shows no observed trading — never to promote anything.
 */
export function scheduledWeekendClosure(session: WeekendSessionShape, nowMs: number): ScheduledClosure | null {
  if (session.alwaysOpen || !session.closedOnWeekends || !Number.isFinite(nowMs)) return null;
  const closeHour = session.closeHourUtc ?? 22;
  const openHour = session.openHourUtc ?? 0;
  const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const daysSinceFriday = (new Date(dayStart).getUTCDay() - 5 + 7) % 7;
  let fridayStart = dayStart - daysSinceFriday * DAY_MS;
  if (fridayStart + closeHour * HOUR_MS > nowMs) fridayStart -= 7 * DAY_MS;
  const closedAtMs = fridayStart + closeHour * HOUR_MS;
  const reopensAtMs = fridayStart + 3 * DAY_MS + openHour * HOUR_MS;
  return nowMs < reopensAtMs ? { closedAtMs, reopensAtMs } : null;
}

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
  const shared = classifyTrailingIntervals(trailingIntervals);
  if (shared == null) return null;
  if (shared === "stale") {
    return { freshness: "stale", stale: true };
  }
  if (shared === "delayed" || opts?.syntheticAwaitingTick === true) {
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
  /** Explicit original provider delay/unverified real-time entitlement. Recent bar times cannot remove it. */
  providerDelayed?: boolean;
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
  /**
   * Newest PROVIDER bar's open time minus `now` (ms; see newestBarLeadMs).
   * Bounded by the absolute MAX_FUTURE_CLOCK_SKEW_MS. Omitted → a negative
   * trailing gap fails closed (see feedTimestampsUnconfirmed).
   */
  newestOpenLeadMs?: number | null;
  /** The producer observed this series stamped ahead of its receipt time. */
  futureStampObserved?: boolean;
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
 * Wording for a source that reported its history as delayed or not
 * confirmed real-time (the provider-delay floor below). Exported so callers
 * that re-word a lagging series (e.g. a scheduled market close) keep the
 * delay disclosure next to their own wording.
 */
export const PROVIDER_DELAYED_WARNING =
  "Provider history is delayed or not confirmed real-time; recent bar times do not establish live entitlement.";

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
    providerDelayed = false,
    mockDataDetected = false,
    invalidOhlcCount = 0,
    missingCandleCount = 0,
    duplicateCount = 0,
    outOfOrderCount = 0,
    routerUserMessage = null,
    completenessReason = null,
    formingTipPresent = false,
    formingTickAgeMs = null,
    newestOpenLeadMs,
    futureStampObserved = false,
  } = inputs;

  const freshness = classifyCandleFreshness(trailingIntervals, { syntheticAwaitingTick });
  // Evaluate historical intervals and display ticks independently. A fresh
  // tip cannot fill missing closed bars; a silent tip cannot look current
  // merely because its bucket still belongs to the current interval.
  const formingVerdict = formingTipPresent ? classifyFormingFreshness(formingTickAgeMs) : null;
  const stale = freshness?.stale === true || formingVerdict?.stale === true;

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
  } else if (feedTimestampsUnconfirmed({ trailingIntervals, newestOpenLeadMs, futureStampObserved })) {
    // Candles exist but their recency is unknown, the newest bar opens after
    // now (beyond the absolute clock-skew allowance), or the producer saw the
    // series stamped ahead of receipt. Unverifiable recency is never "clean".
    quality = "invalid";
    warning = "Candle timestamps could not be confirmed (newest bar is missing a usable time or is stamped in the future). Not safe for analysis.";
  } else if (freshness?.freshness === "stale" || freshness?.freshness === "delayed") {
    // A fresh display tip cannot supply missing closed intervals. Preserve
    // the historical series' age floor so display and analysis agree.
    quality = formingVerdict?.stale === true ? "stale" : freshness.freshness;
    warning = freshness.freshness === "stale"
      ? `Feed is stale — newest bar trails the current bar by ${trailingIntervals} intervals.`
      : syntheticAwaitingTick
        ? "Feed is awaiting a confirmed live tick — history loaded but not yet real-time."
        : "Feed is delayed — newest bar is not the current bar.";
  } else if (formingTipPresent) {
    // A silent display tip can worsen a current historical series; it cannot
    // improve an old one (handled above).
    if (formingVerdict?.freshness === "stale") {
      quality = "stale";
      warning = "Live tick stream silent — forming bar frozen.";
    } else {
      quality = "clean";
      warning = null;
    }
  } else {
    quality = "clean";
    warning = null;
  }

  // Keep the established integrity/stale precedence. Known source delay is a
  // floor only for an otherwise-clean observation, including a fresh tip.
  if (quality === "clean" && providerDelayed) {
    quality = "delayed";
    warning = PROVIDER_DELAYED_WARNING;
  }
  const aiUsable = quality === "clean";
  return { quality, stale, aiUsable, trailingIntervals, warning, completenessReason };
}
