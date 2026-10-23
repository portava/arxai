// ── Scanner truth contract (single shared source) ───────────────────────────
//
// Task #391. ONE normalized object every scanner surface consumes so the header,
// chart panel, timeframe buttons, Ruby Chart Read, Ruby Market Read, Timing
// Intelligence, overlay validator, trade buttons, permission banners, tabs and
// the mobile status strip can never disagree about feed state, freshness,
// permissions, or whether a read is actionable.
//
// HONESTY: this resolver never invents data and never upgrades the backend's own
// verdict. It is driven by the ONE honest market source — the feedStatus +
// candles embedded in GET /api/chart/candles — plus the user's account-mode
// permissions. The simulator quote endpoint (executionEnvironment="SIMULATOR")
// is deliberately NOT a source here: feeding it caused the header≈1.08 vs
// chart≈1.15 mismatch (finding #1). The displayed price is the real candle close.
//
// Pure + deterministic so it can be unit-tested without the network.

import {
  type ChartFeedStatus,
} from "@workspace/api-client-react";
import {
  resolveDisplayStatus,
  applyHeaderCap,
  type FeedStatus,
  type ChartDisplayStatus,
} from "./chart-display-status";
import { providerInfo, type FeedProviderTier } from "./feed-confidence";
import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";
import {
  resolveScannerActionability,
  type ConsolidatedTruth,
  type PublicQuoteStatus,
  type PublicCandleStatus,
  type ChartIntelligenceStatus,
  type RubyReadStatus,
  type TradingStatus,
  type SkippedSymbol,
} from "./scannerActionability";
import {
  evaluateTradeHealthReadiness,
  type TradeHealthReadinessVerdict,
  type TradeReadLayer,
} from "@workspace/domain/market";

// ── Stable read-ID generator (display-only, no execution semantics) ──────────
// Derived deterministically from the input's identity fields: same symbol +
// timeframe + candle window → SAME readId on every call. This guarantees that
// the header strip, chart CTA, and Eleanor panel carry an identical readId for
// the same market snapshot, enabling reliable cross-surface mismatch tracing.
// A new candle (different lastTime or candleCount) produces a different readId,
// naturally advancing the cycle identity without any random component.
function genReadId(input: ScannerTruthInputs): string {
  const key = `${input.symbolInternal}|${input.timeframe}|${input.lastTime ?? ""}|${String(input.candleCount)}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
  }
  return `${input.symbolInternal}_${input.timeframe}_${Math.abs(h).toString(36)}`;
}

// ── Per-timeframe freshness + minimum-candle thresholds (spec section C) ──────
//
// quoteMaxAgeMs is reserved for when a real (non-simulator) quote feed is wired;
// candleMaxAgeMs / minCandles gate the chart + every downstream read.
export interface TimeframeThresholds {
  quoteMaxAgeMs: number;
  candleMaxAgeMs: number;
  minCandles: number;
}

const SEC = 1000;
const MIN = 60 * SEC;

// Keyed by the canonical lowercase timeframe tokens the chart panel uses. Covers
// the full 21 MT5 set (1m,2m,3m,4m,5m,6m,10m,12m,15m,20m,30m,1h,2h,3h,4h,6h,8h,
// 12h,1d,1w,1mo). The month token is "1mo" (never "1m", which is one minute).
// candleMaxAgeMs ≈ 1.2–1.5× the interval (one missed bar + margin); minCandles
// eases as the interval coarsens (1d mirrors the backend D1 floor of 50). Every
// timeframe the chart can select MUST have an entry — an unknown token falls back
// to the strict 1m budget and would wrongly downgrade valid coarse-timeframe data.
export const TIMEFRAME_THRESHOLDS: Record<string, TimeframeThresholds> = {
  "1m": { quoteMaxAgeMs: 10 * SEC, candleMaxAgeMs: 90 * SEC, minCandles: 150 },
  "2m": { quoteMaxAgeMs: 10 * SEC, candleMaxAgeMs: 3 * MIN, minCandles: 150 },
  "3m": { quoteMaxAgeMs: 10 * SEC, candleMaxAgeMs: 5 * MIN, minCandles: 150 },
  "4m": { quoteMaxAgeMs: 10 * SEC, candleMaxAgeMs: 6 * MIN, minCandles: 150 },
  "5m": { quoteMaxAgeMs: 10 * SEC, candleMaxAgeMs: 6 * MIN, minCandles: 150 },
  "6m": { quoteMaxAgeMs: 10 * SEC, candleMaxAgeMs: 8 * MIN, minCandles: 150 },
  "10m": { quoteMaxAgeMs: 10 * SEC, candleMaxAgeMs: 13 * MIN, minCandles: 130 },
  "12m": { quoteMaxAgeMs: 10 * SEC, candleMaxAgeMs: 16 * MIN, minCandles: 130 },
  "15m": { quoteMaxAgeMs: 10 * SEC, candleMaxAgeMs: 18 * MIN, minCandles: 120 },
  "20m": { quoteMaxAgeMs: 10 * SEC, candleMaxAgeMs: 25 * MIN, minCandles: 115 },
  "30m": { quoteMaxAgeMs: 10 * SEC, candleMaxAgeMs: 36 * MIN, minCandles: 110 },
  "1h": { quoteMaxAgeMs: 10 * SEC, candleMaxAgeMs: 75 * MIN, minCandles: 100 },
  "2h": { quoteMaxAgeMs: 10 * SEC, candleMaxAgeMs: 150 * MIN, minCandles: 95 },
  "3h": { quoteMaxAgeMs: 10 * SEC, candleMaxAgeMs: 225 * MIN, minCandles: 90 },
  "4h": { quoteMaxAgeMs: 10 * SEC, candleMaxAgeMs: 300 * MIN, minCandles: 80 },
  "6h": { quoteMaxAgeMs: 10 * SEC, candleMaxAgeMs: 450 * MIN, minCandles: 75 },
  "8h": { quoteMaxAgeMs: 10 * SEC, candleMaxAgeMs: 600 * MIN, minCandles: 70 },
  "12h": { quoteMaxAgeMs: 10 * SEC, candleMaxAgeMs: 900 * MIN, minCandles: 65 },
  "1d": { quoteMaxAgeMs: 10 * SEC, candleMaxAgeMs: 1800 * MIN, minCandles: 50 },
  "1w": { quoteMaxAgeMs: 10 * SEC, candleMaxAgeMs: 12960 * MIN, minCandles: 30 },
  "1mo": { quoteMaxAgeMs: 10 * SEC, candleMaxAgeMs: 53280 * MIN, minCandles: 12 },
};

// Default to the strictest sensible bucket for an unknown token.
export function thresholdsFor(timeframe: string): TimeframeThresholds {
  const key = timeframe.trim().toLowerCase();
  return TIMEFRAME_THRESHOLDS[key] ?? TIMEFRAME_THRESHOLDS["1m"]!;
}

// ── Consistency tolerances (mirror backend brokerPriceAlignment "normal") ─────
// Used only when an independent quote source is supplied; the scanner currently
// supplies none (simulator excluded), so consistency resolves to "unknown".
function consistencyTolerancePct(assetClass: string | null | undefined): number {
  const a = (assetClass ?? "").toLowerCase();
  if (a === "forex" || a === "metals") return 0.2;
  return 0.5;
}

// ── Normalized contract shape (spec section B) ───────────────────────────────

export type QuoteStatus = "live" | "delayed" | "stale" | "unavailable";
export type CandleStatus =
  | "live"
  | "delayed"
  | "stale"
  | "historical_only"
  | "insufficient"
  | "unavailable";
export type ConsistencyStatus = "aligned" | "mismatch" | "unknown";
export type ReadLevel = "full" | "limited" | "historical_only" | "blocked";
export type OverlayStatus = "verified" | "limited" | "check" | "blocked";
export type EffectiveMode = "demo" | "live" | "read_only";

// Single plain-English data verdict for the consolidated truth strip.
export type DataVerdict = "Live" | "Delayed" | "Stale" | "Historical only" | "Unavailable";
export type TradingVerdict = "Enabled" | "Read-only" | "Approval required" | "Blocked";
export type RubyVerdict = "Full read" | "Limited read" | "No read";

export interface ScannerTruth {
  symbolDisplay: string;
  symbolInternal: string;
  timeframe: string;

  quote: {
    bid: number | null;
    ask: number | null;
    mid: number | null;
    source: string | null;
    sourceLabel: string;
    timestamp: string | null;
    ageMs: number | null;
    status: QuoteStatus;
    reason: string;
  };

  candles: {
    source: string | null;
    sourceLabel: string;
    /** Precise provider name — admin/debug surfaces only. */
    sourceTechnical: string;
    tier: FeedProviderTier;
    timeframe: string;
    count: number;
    requestedCount: number;
    minRequired: number;
    firstTime: string | null;
    lastTime: string | null;
    lastClose: number | null;
    ageMs: number | null;
    status: CandleStatus;
    reason: string;
  };

  consistency: {
    quoteCandlePriceDelta: number | null;
    quoteCandlePriceDeltaPct: number | null;
    withinTolerance: boolean | null;
    status: ConsistencyStatus;
    reason: string;
  };

  permissions: {
    demoManualAllowed: boolean;
    demoAIAllowed: boolean;
    liveManualAllowed: boolean;
    liveAIAllowed: boolean;
    sharedBridgeApproved: boolean;
    ownBridgeConnected: boolean;
    manualTradingBlockedReason: string | null;
    liveTradingBlockedReason: string | null;
    effectiveMode: EffectiveMode;
  };

  analysis: {
    allowed: boolean;
    level: ReadLevel;
    reason: string;
  };

  execution: {
    allowed: boolean;
    reason: string;
  };

  ruby: {
    chartReadAllowed: boolean;
    marketReadAllowed: boolean;
    readLevel: ReadLevel;
    reason: string;
  };

  overlays: {
    allowed: boolean;
    status: OverlayStatus;
    reason: string;
  };

  // Consolidated truth-strip verdicts + plain-English one-liners (finding #24/#25).
  strip: {
    data: { verdict: DataVerdict; detail: string };
    trading: { verdict: TradingVerdict; detail: string };
    ruby: { verdict: RubyVerdict; detail: string };
  };

  /** The shared chart display status (so chart + strip never disagree). */
  displayStatus: ChartDisplayStatus;
  /** True only when the latest-price affordance may render as a live tick. */
  isLivePrice: boolean;
  /** True only when the read is valid for live entry (full analysis). */
  actionable: boolean;

  /**
   * True only when the active candle source is the user's own broker feed
   * (tier === "broker"). A connected MT5 execution bridge does NOT make this
   * true — market data and the execution bridge are independent. When this is
   * false but the data is still live, the source is ARX market data / synthetic,
   * never the broker's chart bars.
   */
  brokerFeedActive: boolean;

  /**
   * Plain-English, user-safe data-health summary for the header detail and the
   * readable feed-health panel. Derived ONLY from the resolved truth above —
   * never leaks provider IDs or internal tokens (those stay in
   * candles.sourceTechnical, which is admin-gated).
   */
  dataHealth: {
    /** One-line status headline (e.g. "Live market data"). */
    headline: string;
    /** Honest note about WHERE the data comes from (broker vs ARX vs synthetic). */
    sourceNote: string;
    /** A few plain-English facts: source, freshness/exact reason, actionability. */
    lines: string[];
  };

  /**
   * Consolidated PUBLIC truth block (Task #600). Derived from the resolved
   * internal truth above (never raw inputs) so every scanner surface — header
   * strip, chart badge, Ruby Chart Read, opportunity/scalp cards, trade ticket,
   * Broad Scan summary — agrees on ONE action verdict and ONE message. Existing
   * internal fields are unchanged; this is purely additive.
   */
  consolidated: ConsolidatedTruth;

  /**
   * The ONE shared trade-health / readiness DISPLAY verdict (Trade Health
   * contract). Composed from the SAME marketDataSufficiency truth Ruby's chart
   * read consumes, so the Scanner and Ruby can never show a different read /
   * eligibility label for the same symbol + timeframe. DISPLAY-ONLY: every caller
   * still ANDs `canTrade` + the live gate — `readiness` can only downgrade or
   * explain, never grant a trade affordance the execution stack forbids.
   */
  readiness: TradeHealthReadinessVerdict;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface ScannerTruthMode {
  isLoading: boolean;
  isDemo: boolean;
  isLiveShared: boolean;
  isPaper: boolean;
  isLiveArmed: boolean;
  isFrozen: boolean;
  canManualTrade: boolean;
  canAutoTrade: boolean;
  isSharedMasterAssigned: boolean;
  ownBridgeConnected: boolean;
  approvalStatus: string | null;
  frozenReason: string | null;
  cleanBlockedReason: string | null;
}

export interface ScannerTruthInputs {
  symbolDisplay: string;
  symbolInternal: string;
  timeframe: string;
  feedStatus: ChartFeedStatus | null;
  candleCount: number;
  requestedCount: number;
  firstTime: string | null;
  lastTime: string | null;
  lastClose: number | null;
  /** Optional independent quote — scanner passes null (simulator excluded). */
  quote?: { bid: number | null; ask: number | null; mid: number | null; source: string | null; timestamp: string | null } | null;
  /** Header ok flag (selected-market) — caps the display state. */
  headerOk: boolean | null;
  mode: ScannerTruthMode;
  nowMs?: number;
  /**
   * Optional scan-level skip list passed through to `consolidated.skippedSymbols`.
   * A per-symbol resolve has no scan knowledge, so this defaults to `[]`; the
   * Broad Scan surface feeds the scanner's real skip list here.
   */
  skippedSymbols?: SkippedSymbol[];
}

// Generic, user-safe source label (never leaks "Polygon"/"TwelveData" etc).
function genericSourceLabel(tier: FeedProviderTier): string {
  switch (tier) {
    case "broker":
      return "Your broker feed";
    case "synthetic":
      return "Synthetic feed";
    case "thirdParty":
      return "Market data feed";
    default:
      return "No feed";
  }
}

function ageMsOf(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, nowMs - t);
}

export function resolveScannerTruth(
  input: ScannerTruthInputs,
  assistantName: string = DEFAULT_ASSISTANT_NAME,
): ScannerTruth {
  const nowMs = input.nowMs ?? Date.now();
  const tf = input.timeframe.trim().toLowerCase();
  const thr = thresholdsFor(tf);
  const fs = input.feedStatus;
  const count = input.candleCount;

  // Display status from the shared chart contract (single source of truth).
  const feedForDisplay: FeedStatus | null = fs
    ? {
        isLive: fs.isLive,
        stale: fs.stale,
        quality: fs.quality,
        source: fs.source,
        aiUsable: fs.aiUsable,
        warning: fs.warning,
        message: fs.message,
        lastCandleTime: fs.lastCandleTime,
      }
    : null;
  const rawDisplay = resolveDisplayStatus(feedForDisplay, count > 0);
  const displayStatus = applyHeaderCap(rawDisplay, input.headerOk);

  const provider = providerInfo(fs?.source ?? null);
  const sourceLabel = genericSourceLabel(provider.tier);
  const candleAgeMs = ageMsOf(input.lastTime, nowMs);

  // ── Candle status (freshness + minimum-candle gating) ──────────────────────
  let candleStatus: CandleStatus;
  let candleReason: string;
  const minMet = count >= thr.minCandles;
  if (count === 0 || displayStatus === "UNAVAILABLE") {
    candleStatus = "unavailable";
    candleReason = "No candles are available for this market right now.";
  } else if (!minMet) {
    candleStatus = "insufficient";
    candleReason = `Only ${count} ${count === 1 ? "candle" : "candles"} loaded — need at least ${thr.minCandles} on ${input.timeframe} for a reliable read.`;
  } else if (displayStatus === "STALE") {
    candleStatus = "stale";
    candleReason = "The latest candle is frozen — this is historical context, not a live read.";
  } else if (displayStatus === "ANALYSIS_ONLY") {
    candleStatus = "historical_only";
    candleReason = "Data is incomplete — historical context only, not valid for a live entry.";
  } else if (displayStatus === "FALLBACK_COMPOSITE") {
    candleStatus = "delayed";
    candleReason = "Delayed market data — readable, but slightly behind live.";
  } else if (
    displayStatus === "LIVE" &&
    (candleAgeMs == null || candleAgeMs <= thr.candleMaxAgeMs)
  ) {
    candleStatus = "live";
    candleReason = "Live, confirmed candles.";
  } else {
    // Display says live but the last bar is older than the timeframe budget.
    candleStatus = "stale";
    candleReason = "The latest candle is older than expected for this timeframe.";
  }

  // ── Quote status (no real quote source today → unavailable, honestly) ───────
  const q = input.quote ?? null;
  const quoteAgeMs = ageMsOf(q?.timestamp ?? null, nowMs);
  let quoteStatus: QuoteStatus;
  let quoteReason: string;
  if (!q || q.mid == null) {
    quoteStatus = "unavailable";
    quoteReason = "No separate live quote feed — price shown is the latest candle close.";
  } else if (quoteAgeMs != null && quoteAgeMs <= thr.quoteMaxAgeMs) {
    quoteStatus = "live";
    quoteReason = "Live quote.";
  } else if (quoteAgeMs != null && quoteAgeMs <= thr.quoteMaxAgeMs * 6) {
    quoteStatus = "delayed";
    quoteReason = "Quote is slightly delayed.";
  } else {
    quoteStatus = "stale";
    quoteReason = "Quote is stale.";
  }

  // Displayed price: real candle close (NOT a simulator quote). When a real
  // quote is supplied we surface it; otherwise the candle close is the price.
  const priceMid = q?.mid ?? input.lastClose ?? null;

  // ── Quote↔candle consistency ───────────────────────────────────────────────
  let delta: number | null = null;
  let deltaPct: number | null = null;
  let withinTol: boolean | null = null;
  let consistencyStatus: ConsistencyStatus = "unknown";
  let consistencyReason =
    "No independent quote to compare — price comes straight from the candle feed.";
  if (q && q.mid != null && input.lastClose != null && input.lastClose !== 0) {
    delta = q.mid - input.lastClose;
    deltaPct = Math.abs(delta / input.lastClose) * 100;
    const tolPct = consistencyTolerancePct(fs?.assetClass);
    withinTol = deltaPct <= tolPct;
    consistencyStatus = withinTol ? "aligned" : "mismatch";
    consistencyReason = withinTol
      ? "Quote and chart price agree."
      : "Quote and chart price disagree — the read is historical only until they re-align.";
  }

  // ── Permissions ────────────────────────────────────────────────────────────
  const m = input.mode;
  const effectiveMode: EffectiveMode = m.isLiveShared
    ? "live"
    : m.isDemo
      ? "demo"
      : "read_only";
  const manualBlocked =
    m.isFrozen
      ? m.frozenReason ?? "Trading is frozen on your account."
      : !m.canManualTrade
        ? m.cleanBlockedReason ?? "Manual trading isn't enabled on your account yet."
        : null;
  const liveBlocked =
    m.isLiveShared
      ? manualBlocked
      : "Live trading requires approval.";
  const permissions = {
    demoManualAllowed: m.isDemo && m.canManualTrade && !m.isFrozen,
    demoAIAllowed: m.isDemo && m.canAutoTrade && !m.isFrozen,
    liveManualAllowed: m.isLiveShared && m.canManualTrade && !m.isFrozen,
    liveAIAllowed: m.isLiveShared && m.canAutoTrade && !m.isFrozen,
    sharedBridgeApproved: m.isSharedMasterAssigned,
    ownBridgeConnected: m.ownBridgeConnected,
    manualTradingBlockedReason: manualBlocked,
    liveTradingBlockedReason: m.isLiveShared && !manualBlocked ? null : liveBlocked,
    effectiveMode,
  };

  // ── Analysis level (gated by candle truth + consistency) ───────────────────
  let analysisLevel: ReadLevel;
  let analysisReason: string;
  if (candleStatus === "unavailable") {
    analysisLevel = "blocked";
    analysisReason = "No market data — analysis is unavailable.";
  } else if (consistencyStatus === "mismatch") {
    analysisLevel = "historical_only";
    analysisReason = consistencyReason;
  } else if (
    candleStatus === "insufficient" ||
    candleStatus === "stale" ||
    candleStatus === "historical_only"
  ) {
    analysisLevel = "historical_only";
    analysisReason = candleReason;
  } else if (candleStatus === "delayed") {
    analysisLevel = "limited";
    analysisReason = candleReason;
  } else {
    analysisLevel = "full";
    analysisReason = "Live data — valid for a live read.";
  }
  const analysisAllowed = analysisLevel !== "blocked";
  const actionable = analysisLevel === "full";

  // ── Ruby read level (also requires aiUsable for a full read) ───────────────
  const aiUsable = fs?.aiUsable === true;
  let rubyLevel: ReadLevel;
  let rubyReason: string;
  if (analysisLevel === "blocked") {
    rubyLevel = "blocked";
    rubyReason = `${assistantName} has no data to read for this market right now.`;
  } else if (analysisLevel === "historical_only") {
    rubyLevel = "historical_only";
    rubyReason = `${assistantName} can only give a historical read — not valid for a live entry.`;
  } else if (analysisLevel === "limited" || !aiUsable) {
    rubyLevel = "limited";
    rubyReason = `${assistantName} can read with caution — the feed isn't fully confirmed.`;
  } else {
    rubyLevel = "full";
    rubyReason = `${assistantName} can give a full, live read.`;
  }

  // ── Overlay validation (fails/downgrades on unstable truth) ────────────────
  let overlayStatus: OverlayStatus;
  let overlayReason: string;
  if (analysisLevel === "blocked") {
    overlayStatus = "blocked";
    overlayReason = "Overlays can't be drawn without market data.";
  } else if (analysisLevel === "historical_only") {
    overlayStatus = "check";
    overlayReason = "Overlays are based on historical data — re-check before acting.";
  } else if (analysisLevel === "limited") {
    overlayStatus = "limited";
    overlayReason = "Overlays drawn on delayed data — treat as approximate.";
  } else {
    overlayStatus = "verified";
    overlayReason = "Overlays verified against live data.";
  }

  // ── Execution (permission-driven; server still re-runs all 16 gates) ───────
  const executionAllowed =
    (permissions.demoManualAllowed || permissions.liveManualAllowed);
  const executionReason = executionAllowed
    ? effectiveMode === "live"
      ? "You can place live trades — every order still passes the full safety checks."
      : "You can place demo trades."
    : effectiveMode === "read_only"
      ? "Read-only — trading isn't available from the scanner in this mode."
      : manualBlocked ?? "Trading is blocked on your account.";

  // ── Consolidated truth strip ───────────────────────────────────────────────
  const dataVerdict: DataVerdict =
    candleStatus === "live"
      ? "Live"
      : candleStatus === "delayed"
        ? "Delayed"
        : candleStatus === "stale"
          ? "Stale"
          : candleStatus === "unavailable"
            ? "Unavailable"
            : "Historical only";

  const tradingVerdict: TradingVerdict = m.isFrozen
    ? "Blocked"
    : executionAllowed
      ? "Enabled"
      : effectiveMode === "read_only" && !m.isLiveShared && !m.isDemo
        ? "Approval required"
        : "Read-only";

  const rubyVerdict: RubyVerdict =
    rubyLevel === "blocked"
      ? "No read"
      : rubyLevel === "full"
        ? "Full read"
        : "Limited read";

  // ── Final chart display status (single-truth cap) ──────────────────────────
  // The chart's "live" affordance MUST reflect the SAME gating the strip/read-gate
  // use, not the raw feed display alone. resolveDisplayStatus is feed-status based,
  // so it can read LIVE even when min-candle / age / consistency gating downgraded
  // the candle truth to insufficient/stale/historical. We re-derive the status the
  // chart renders from the resolved candleStatus + analysisLevel so no surface can
  // ever look more live than scanner truth (Task #391, finding #3).
  let resolvedDisplayStatus: ChartDisplayStatus;
  if (candleStatus === "unavailable" || analysisLevel === "blocked") {
    resolvedDisplayStatus = "UNAVAILABLE";
  } else if (candleStatus === "live" && analysisLevel === "full") {
    resolvedDisplayStatus = "LIVE";
  } else if (candleStatus === "stale") {
    resolvedDisplayStatus = "STALE";
  } else if (analysisLevel === "limited" || candleStatus === "delayed") {
    resolvedDisplayStatus = "FALLBACK_COMPOSITE";
  } else {
    // insufficient, historical_only, or consistency mismatch
    resolvedDisplayStatus = "ANALYSIS_ONLY";
  }

  // ── Plain-English data-health summary (user-safe; no provider IDs) ──────────
  // brokerFeedActive is driven ONLY by the candle source tier — a connected MT5
  // execution bridge never sets it, so we can never imply broker-live chart bars
  // when the data is actually ARX market data or a synthetic feed.
  const brokerFeedActive = provider.tier === "broker";

  const healthHeadline =
    resolvedDisplayStatus === "LIVE"
      ? "Live market data"
      : resolvedDisplayStatus === "FALLBACK_COMPOSITE"
        ? "Delayed market data"
        : resolvedDisplayStatus === "STALE"
          ? "Stale — last-known prices"
          : resolvedDisplayStatus === "ANALYSIS_ONLY"
            ? "Historical data — analysis only"
            : "Market data unavailable";

  // Honest source note. The thirdParty case is the GBPUSD situation: the data is
  // genuinely live, but it is ARX market data, NOT the broker's chart feed — so
  // we say so plainly and data-driven (never hardcoded to "broker dormant").
  const sourceNote =
    provider.tier === "broker"
      ? "Live bars are coming from your broker feed."
      : provider.tier === "synthetic"
        ? "These are synthetic-market bars (algorithmic volatility index), not your broker's bars."
        : provider.tier === "thirdParty"
          ? resolvedDisplayStatus === "LIVE"
            ? "Live via ARX market data — your broker chart feed isn't active yet."
            : "ARX market data is filling in here — your broker chart feed isn't active yet."
          : "No market-data source is serving this chart right now.";

  const actionabilityLine = actionable
    ? "This read is fresh enough for a live entry."
    : resolvedDisplayStatus === "UNAVAILABLE"
      ? "There's nothing to analyse until a feed comes back."
      : "Not fresh enough for a live entry — treat it as context only.";

  // candleReason is the exact, plain-English reason (e.g. GBPUSD D1 "Only N
  // candles loaded — need at least M…" or "Live, confirmed candles.").
  const dataHealth = {
    headline: healthHeadline,
    sourceNote,
    lines: [sourceNote, candleReason, actionabilityLine],
  };

  // ── Consolidated public truth (Task #600) ──────────────────────────────────
  // Translate the resolved INTERNAL truth into the task's public vocabulary.
  // Derived from already-resolved state (candleStatus/analysisLevel/rubyLevel/…),
  // never raw inputs, so there is exactly one authority. Mappings per the
  // architect-confirmed contract design.
  const publicCandleStatus: PublicCandleStatus =
    candleStatus === "unavailable"
      ? "UNAVAILABLE"
      : candleStatus === "stale"
        ? "STALE"
        : candleStatus === "insufficient" || candleStatus === "historical_only"
          ? "LIMITED_HISTORY"
          : candleStatus === "delayed"
            ? "SYNCING"
            : candleStatus === "live" && analysisLevel === "full" && aiUsable
              ? "CONFIRMED"
              : "UNCONFIRMED";

  // No separate quote feed today → UNAVAILABLE honestly. MARKET_CLOSED / FROZEN
  // are reserved for an explicit feed session-closed / feed-freeze signal (none
  // exists yet) — never inferred from an account freeze.
  const publicQuoteStatus: PublicQuoteStatus =
    quoteStatus === "live"
      ? "LIVE"
      : quoteStatus === "stale" || quoteStatus === "delayed"
        ? "STALE"
        : "UNAVAILABLE";

  const chartIntelligenceStatus: ChartIntelligenceStatus =
    analysisLevel === "full"
      ? "FULL"
      : analysisLevel === "blocked"
        ? "UNAVAILABLE"
        : "LIMITED"; // limited | historical_only

  const publicRubyReadStatus: RubyReadStatus =
    rubyLevel === "full"
      ? "FULL_READ"
      : rubyLevel === "blocked"
        ? "NO_READ"
        : "LIMITED_READ";

  // Mirror the existing tradingVerdict so the strip and the public block never
  // drift: frozen → BLOCKED, executable → ENABLED, pending approval →
  // REVIEW_REQUIRED, otherwise (read-only) → DISABLED.
  const tradingStatus: TradingStatus = m.isFrozen
    ? "BLOCKED"
    : executionAllowed
      ? "ENABLED"
      : tradingVerdict === "Approval required"
        ? "REVIEW_REQUIRED"
        : "DISABLED";

  const actionabilityDataInput = {
    quoteStatus: publicQuoteStatus,
    candleStatus: publicCandleStatus,
    chartIntelligenceStatus,
  };
  // Stored verdict is the pure DATA-only verdict (setup UNKNOWN); cards/header
  // refine it with their own setup readiness via resolveScannerActionability.
  const scannerActionability = resolveScannerActionability(
    actionabilityDataInput,
  );

  // ONE governing message + a stable machine code for the most severe downgrade.
  let internalReasonCode: string;
  let userMessage: string;
  if (publicCandleStatus === "UNAVAILABLE") {
    internalReasonCode = "CANDLES_UNAVAILABLE";
    userMessage = candleReason;
  } else if (consistencyStatus === "mismatch") {
    internalReasonCode = "QUOTE_CANDLE_MISMATCH";
    userMessage = consistencyReason;
  } else if (publicCandleStatus === "LIMITED_HISTORY") {
    internalReasonCode =
      candleStatus === "insufficient" ? "CANDLES_INSUFFICIENT" : "CANDLES_HISTORICAL";
    userMessage = candleReason;
  } else if (publicCandleStatus === "STALE") {
    internalReasonCode = "CANDLES_STALE";
    userMessage = candleReason;
  } else if (publicCandleStatus === "SYNCING") {
    internalReasonCode = "CANDLES_DELAYED";
    userMessage = candleReason;
  } else if (publicCandleStatus === "UNCONFIRMED") {
    internalReasonCode = "FEED_UNCONFIRMED";
    userMessage = "Live feed isn't fully confirmed yet — read as context, not a live entry.";
  } else {
    internalReasonCode = "FEED_OK";
    userMessage = actionabilityLine;
  }

  const consolidated: ConsolidatedTruth = {
    selectedSymbol: input.symbolDisplay,
    selectedTimeframe: input.timeframe,
    quoteStatus: publicQuoteStatus,
    candleStatus: publicCandleStatus,
    chartIntelligenceStatus,
    rubyReadStatus: publicRubyReadStatus,
    tradingStatus,
    scannerActionability,
    feedSource: q?.source ?? fs?.source ?? null,
    candleSource: fs?.source ?? null,
    oldestCandleTime: input.firstTime,
    newestCandleTime: input.lastTime,
    candleCount: count,
    skippedSymbols: input.skippedSymbols ?? [],
    userMessage,
    internalReasonCode,
    readId: genReadId(input),
    readTimestamp: Date.now(),
  };

  // ── Shared trade-health / readiness DISPLAY verdict (Trade Health contract) ──
  // Map the already-resolved scanner truth into the canonical contract inputs and
  // compose the ONE verdict Ruby's chart read also composes. DISPLAY-ONLY — never
  // an execution gate; the scanner's stricter per-timeframe minimum (thr.minCandles)
  // is preserved as the floor, so scanner readiness can only be MORE conservative
  // than Ruby's shared floor (downgrade-only, per the HARD RULE).
  const readinessReadLayer: TradeReadLayer =
    analysisLevel === "blocked" || candleStatus === "insufficient" || count < thr.minCandles
      ? "INSUFFICIENT"
      : rubyLevel === "full" && analysisLevel === "full"
        ? "FULL"
        : "STRUCTURAL_ONLY";
  const readiness = evaluateTradeHealthReadiness({
    symbol: input.symbolInternal,
    timeframe: input.timeframe,
    freshnessVerdict:
      candleStatus === "live"
        ? "LIVE"
        : candleStatus === "delayed"
          ? "LIVE_DELAYED"
          : "AWAITING",
    availableClosedCandles: count,
    minimumRequiredCandles: thr.minCandles,
    readLayer: readinessReadLayer,
  });

  return {
    symbolDisplay: input.symbolDisplay,
    symbolInternal: input.symbolInternal,
    timeframe: input.timeframe,
    quote: {
      bid: q?.bid ?? null,
      ask: q?.ask ?? null,
      mid: priceMid,
      source: q?.source ?? null,
      sourceLabel,
      timestamp: q?.timestamp ?? null,
      ageMs: quoteAgeMs,
      status: quoteStatus,
      reason: quoteReason,
    },
    candles: {
      source: fs?.source ?? null,
      sourceLabel,
      sourceTechnical: provider.label,
      tier: provider.tier,
      timeframe: input.timeframe,
      count,
      requestedCount: input.requestedCount,
      minRequired: thr.minCandles,
      firstTime: input.firstTime,
      lastTime: input.lastTime,
      lastClose: input.lastClose,
      ageMs: candleAgeMs,
      status: candleStatus,
      reason: candleReason,
    },
    consistency: {
      quoteCandlePriceDelta: delta,
      quoteCandlePriceDeltaPct: deltaPct,
      withinTolerance: withinTol,
      status: consistencyStatus,
      reason: consistencyReason,
    },
    permissions,
    analysis: { allowed: analysisAllowed, level: analysisLevel, reason: analysisReason },
    execution: { allowed: executionAllowed, reason: executionReason },
    ruby: {
      chartReadAllowed: rubyLevel !== "blocked",
      marketReadAllowed: rubyLevel !== "blocked",
      readLevel: rubyLevel,
      reason: rubyReason,
    },
    overlays: {
      allowed: overlayStatus !== "blocked",
      status: overlayStatus,
      reason: overlayReason,
    },
    strip: {
      data: { verdict: dataVerdict, detail: candleReason },
      trading: { verdict: tradingVerdict, detail: executionReason },
      ruby: { verdict: rubyVerdict, detail: rubyReason },
    },
    displayStatus: resolvedDisplayStatus,
    isLivePrice: resolvedDisplayStatus === "LIVE",
    actionable,
    brokerFeedActive,
    dataHealth,
    consolidated,
    readiness,
  };
}
