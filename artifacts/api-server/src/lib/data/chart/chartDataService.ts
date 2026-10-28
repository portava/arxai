// ARX Native Chart — Level 1: candle data truth service.
// Phase 1 hardening: full VerifiedCandle shape + TimeframeTruthResult.
//
// Orchestrates the EXISTING market-data router (`routeCandles`) plus the
// candle truth engine into the normalized chart contract. This layer adds
// NO new data source and NEVER fabricates: when the router exhausts every
// provider it returns an honest empty result with `quality: "unavailable"`.
//
// Phase 1 additions:
//   - Every candle now carries the full VerifiedCandle shape (sourceMode,
//     priceBasis, isFinal, receivedAt, providerSymbol, brokerSymbol,
//     qualityFlags) via the truth engine.
//   - A `truthResult: TimeframeTruthResult` is returned alongside candles,
//     giving callers a structured per-timeframe audit (history depth, forming
//     bar, outliers, mock detection, seam verification, symbol profile).
//   - Mock/dev data is detected and the response quality is degraded to
//     "invalid" so the UI shows an honest syncing state instead of silently
//     displaying simulation bars as tradable data.
//
// Quality precedence (highest wins):
//   unavailable > invalid > partial > stale > delayed > clean
//   aiUsable === (quality === "clean")
//
// "delayed" / "stale" are derived from OBSERVABLE data (how many timeframe
// intervals the newest bar trails the current bar, plus — for synthetics — a
// confirmed recent live tick), not from any hidden provider flag.

import type { TruthReadEvidence } from "@workspace/domain/truth";
import { prepareMarketRead } from "../../truth/marketReadEvidence.js";
import { routeCandles, classifySymbol, type AssetClass } from "../marketDataRouter.js";
import {
  getDerivSymbolFeedStatus,
  resolveDerivSymbol,
} from "../providers/derivProvider.js";
import { trailingIntervalGap } from "./candleNormalization.js";
import { runCandleTruth, type TimeframeTruthResult } from "./candleTruthEngine.js";
import { getSymbolProfile } from "./symbolProfile.js";
import { getSessionProfile, type WeeklyPresenceProfile } from "./sessionProfile.js";
import type { NormalizedChartCandle } from "./candleNormalization.js";
import { timeframeMs, type ChartTimeframe } from "./timeframes.js";
import { computeChartTruthScore, type ChartTruthScore } from "./chartTruthScore.js";
import {
  buildFeedStatus,
  feedTimestampsUnconfirmed,
  newestBarLeadMs,
  FUTURE_STAMPED_SERIES_NOTE,
  MARKET_FROZEN_WALL_FRESH_MS,
  scheduledWeekendClosure,
  type FeedQuality,
} from "../freshness.js";
import {
  attachSeriesAttribution,
  seriesAttributionFrom,
  type ChartSeriesAttribution,
} from "./brokerQuoteBinding.js";
import {
  getFormingBar,
  isFormingTickSource,
  getFormingTickAgeMs,
  getFeedFreshness,
  type FormingBarSnapshot,
} from "./formingBarComposer.js";

// Quality precedence + trailing-interval thresholds now live in the shared
// freshness module (../freshness.js) so every analysis/chart surface classifies
// the same feed identically. ChartQuality is kept as an alias for callers that
// import it from here.
export type ChartQuality = FeedQuality;

export interface ChartFeedStatus {
  symbol: string;
  displaySymbol: string;
  assetClass: AssetClass;
  source: string | null;
  isLive: boolean;
  lastTickTime: string | null;
  lastCandleTime: string | null;
  latencyMs: number | null;
  missingCandleCount: number;
  duplicateCount: number;
  outOfOrderCount: number;
  invalidOhlcCount: number;
  /**
   * How many timeframe bar-intervals the newest bar lags behind the current
   * expected bar (clean <= 1, delayed = 2, stale >= 3). null when the gap is
   * unknown (no candles). This is the SAME gap that drives the staleness
   * verdict — surfacing it shows operators HOW MANY recent intervals are
   * missing, making "delayed" vs "stale" self-explanatory.
   */
  trailingIntervals: number | null;
  stale: boolean;
  quality: ChartQuality;
  warning: string | null;
  aiUsable: boolean;
  feedReadinessState: string | null;
  message: string;
  /**
   * Session-aware completeness reason ("isolated_closure_or_gap",
   * "insufficient_history_for_session_profile") or null. Advisory transparency —
   * never changes the quality verdict on its own.
   */
  completenessReason: string | null;
}

export interface ChartCandlesResponse {
  marketEvidence?: TruthReadEvidence | null;
  symbol: string;
  displaySymbol: string;
  timeframe: ChartTimeframe;
  assetClass: AssetClass;
  source: string | null;
  quality: ChartQuality;
  aiUsable: boolean;
  warning: string | null;
  latencyMs: number | null;
  requestedLimit: number;
  candleCount: number;
  candles: NormalizedChartCandle[];
  feedStatus: ChartFeedStatus;
  /** Phase 1: structured per-timeframe truth result alongside every candle response. */
  truthResult: TimeframeTruthResult | null;
  /** Phase 3: weighted Chart Truth Score derived from Phase 1 signals. */
  chartTruthScore: ChartTruthScore;
}

function resolveDisplaySymbol(symbol: string, assetClass: AssetClass): string {
  if (assetClass === "synthetic") {
    const m = resolveDerivSymbol(symbol);
    if (m) return m.displayName;
  }
  return symbol.trim().toUpperCase();
}

interface BuiltFeed {
  marketEvidence: TruthReadEvidence | null;
  /** Observed router provenance of the served series (server-internal). */
  seriesAttribution: ChartSeriesAttribution | null;
  assetClass: AssetClass;
  displaySymbol: string;
  source: string | null;
  candles: NormalizedChartCandle[];
  status: ChartFeedStatus;
  truthResult: TimeframeTruthResult | null;
  chartTruthScore: ChartTruthScore;
}

/**
 * Build the still-forming tip candle from a composer snapshot, using a closed
 * bar as the field template (symbol/source/basis identity) and overriding the
 * OHLC + time bounds + completion flags. Display/telemetry only — never
 * persisted, never an analysis input.
 */
function buildFormingTipCandle(
  template: NormalizedChartCandle,
  forming: FormingBarSnapshot,
  timeframe: ChartTimeframe,
  nowMs: number,
): NormalizedChartCandle {
  const closeMs = forming.openMs + timeframeMs(timeframe);
  return {
    ...template,
    openTime: new Date(forming.openMs).toISOString(),
    closeTime: new Date(closeMs).toISOString(),
    open: forming.open,
    high: forming.high,
    low: forming.low,
    close: forming.close,
    volume: 0,
    tickVolume: forming.tickCount,
    isComplete: false,
    isFinal: false,
    isForming: true,
    receivedAt: new Date(nowMs).toISOString(),
    qualityFlags: ["FORMING_BAR"],
  };
}

/**
 * Single source of truth used by BOTH chart endpoints. Calls the existing
 * router directly so we see the full attempt log (for latency + source) and
 * derives quality from the normalized + truth-validated candles.
 *
 * `includeFormingTip` (default FALSE) is the ONLY switch that folds the live
 * forming-bar tip onto the newest bar. It is passed `true` ONLY by the chart
 * display/feed-status surfaces. Every analysis caller (chart-intelligence,
 * flame signal, timeframe agreement, market overview, Ruby) leaves it false.
 * A provider may already include its unfinished interval; analysis consumers
 * must still respect completion flags. marketEvidence refers only to accepted
 * closed bars; truthResult + chartTruthScore precede any appended display tip.
 */
async function buildChartFeed(
  symbol: string,
  timeframe: ChartTimeframe,
  limit: number,
  includeFormingTip: boolean = false,
): Promise<BuiltFeed> {
  const assetClass = classifySymbol(symbol);
  const displaySymbol = resolveDisplaySymbol(symbol, assetClass);
  const now = Date.now();

  const result = await routeCandles(symbol, timeframe, limit);
  const source = result.primaryProvider;

  // Latency: the winning provider's server-side read time (ms). When nothing
  // was served there is no read to time — the cost of failed probes is not a
  // feed latency, so it reports unknown (null) rather than their sum.
  const okAttempt = result.attempts.find((a) => a.ok);
  const latencyMs = okAttempt ? okAttempt.ms : null;

  // ── Phase 1: run truth engine over raw candles ─────────────────────────
  let candles: NormalizedChartCandle[];
  let truthResult: TimeframeTruthResult | null = null;

  // Session-aware completeness: for instruments with a market session
  // (forex/stocks/indices/metals — NOT 24/7 synthetics/crypto) load the weekly
  // presence profile so weekend/off-hours closures are not mistaken for missing
  // bars. Skipped entirely for 24/7 instruments (no DB hit on the hot path).
  let sessionProfile: WeeklyPresenceProfile | null = null;
  if (result.candles.length > 0 && !getSymbolProfile(symbol, assetClass).session.alwaysOpen) {
    sessionProfile = await getSessionProfile(symbol, timeframe, now);
  }

  if (result.candles.length > 0) {
    const tr = runCandleTruth(result.candles, {
      symbol,
      displaySymbol,
      timeframe,
      source,
      assetClass,
      limit,
      now,
      sessionProfile,
    });
    candles = tr.verifiedCandles;
    truthResult = tr.truthResult;
  } else {
    candles = [];
    truthResult = null;
  }

  const anomalies = truthResult
    ? {
        missingCandleCount: truthResult.missingCandleCount,
        duplicateCount: truthResult.duplicateCount,
        outOfOrderCount: truthResult.outOfOrderCount,
        invalidOhlcCount: truthResult.invalidOhlcCount,
      }
    : { missingCandleCount: 0, duplicateCount: 0, outOfOrderCount: 0, invalidOhlcCount: 0 };

  const synthetic = assetClass === "synthetic";
  // Phase 1B (Task #542) — ONE per-symbol Deriv verdict. hasLiveTick, the
  // popover "Last tick", and "Readiness" all derive from THIS single call, so
  // the badge popover can never show a global "Last tick"/"Readiness" that
  // contradicts the per-symbol State/AI-usable on the same chip. A different
  // synthetic ticking never makes THIS symbol read live.
  //
  // Task #776 — the Deriv WS tick is the liveness signal ONLY when Deriv is the
  // winning provider. When the MT5 broker (`mt5_broker`) serves a synthetic's
  // candles, the broker IS the live source: freshness must be judged on broker
  // candle / forming-tip freshness exactly like any broker symbol, NOT on a
  // Deriv WS tick the broker feed does not depend on. This mirrors
  // marketScanner's `derivBacked` rule so a broker-fed synthetic classifies
  // identically on the chart and the scanner. Without it, a fresh mt5_broker
  // synthetic feed was mislabeled delayed / not-live / aiUsable=false
  // ("historical only" / "feed limited" / "analysis only") whenever the Deriv
  // WS was not independently ticking that exact symbol. A genuinely
  // stale/historical feed is unaffected — trailing-interval staleness below
  // still demotes it honestly and keeps it entry-blocked.
  const derivBacked = synthetic && (source?.startsWith("deriv") ?? false);
  const derivSymbolStatus = derivBacked ? getDerivSymbolFeedStatus(symbol) : null;
  const hasLiveTick = derivSymbolStatus?.hasRecentTick ?? false;

  // Trailing-gap + newest provider candle precede any appended display tip.
  // A provider forming bar can have a scheduled future closeTime; that is not
  // the closed-bar observation carried separately in marketEvidence.
  const trailing = trailingIntervalGap(candles, timeframe, now);
  const lastCandle = candles[candles.length - 1] ?? null;
  const lastCandleTime = lastCandle ? lastCandle.closeTime : null;
  // Future-stamp bound uses the newest provider bar's OPEN time, not its
  // closeTime: a forming bar legitimately has a scheduled closeTime after now,
  // but no bar can open before its first tick. Bounded by an absolute
  // clock-skew allowance (ms), never by "one interval". A series the producer
  // observed stamped ahead of its receipt time stays unconfirmed even after it
  // stalls into a past-looking open time (sticky producer note).
  const newestOpenLeadMs = lastCandle ? newestBarLeadMs(Date.parse(lastCandle.openTime), now) : null;
  const futureStampObserved = result.ok && (result.provenanceNotes ?? []).includes(FUTURE_STAMPED_SERIES_NOTE);
  const timestampsUnconfirmed = feedTimestampsUnconfirmed({ trailingIntervals: trailing, newestOpenLeadMs, futureStampObserved });
  // "Last tick": the Deriv WS tick for a Deriv-served series, else the MT5
  // broker tick the server last RECEIVED for this symbol (receive time — the
  // broker clock is not zone-verified). A quote the broker is only replaying
  // (market frozen) is not a new tick, so it reports unknown, never "just now".
  const mt5TickFreshness = source === "mt5_broker" ? getFeedFreshness(symbol, now, "mt5_broker") : null;
  const lastTickTime = derivBacked
    ? derivSymbolStatus?.lastTickAt ?? null
    : mt5TickFreshness && !mt5TickFreshness.marketFrozen
      ? new Date(mt5TickFreshness.lastTickWallMs).toISOString()
      : null;

  // ── Forming tip (Task #496, opt-in, any live provider) ────────────────
  // Fold the live-tick forming bar onto the newest bar for the DISPLAY surface.
  // The closed bars above remain the truth basis (truthResult/chartTruthScore
  // were already computed); the tip only changes what is rendered + how
  // freshness reads. The authoritative closed CANDLE that lands one interval
  // later naturally supersedes the tip (its openMs moves past the tip → ignore),
  // so there is never an orphan duplicate.
  //
  // The tip must share the winning history provider. Canonical symbols can
  // exist at both MT5 and Deriv; a real tick from a different source is still
  // the wrong price basis for this series. Unknown providers get no live tip.
  let formingTipPresent = false;
  let formingTickAgeMs: number | null = null;
  if (includeFormingTip && lastCandle && isFormingTickSource(source)) {
    const forming = getFormingBar(symbol, timeframe, now, source);
    if (forming) {
      const tipOpenMs = forming.openMs;
      const lastClosedOpenMs = Date.parse(lastCandle.openTime);
      if (tipOpenMs > lastClosedOpenMs) {
        // Tip is for an interval ahead of the newest closed bar → append.
        candles = [...candles, buildFormingTipCandle(lastCandle, forming, timeframe, now)];
        formingTipPresent = true;
      } else if (tipOpenMs === lastClosedOpenMs) {
        // Provider's newest bar is the same (current) interval → merge live
        // extremes onto it; keep the closed bar's open, take the tip's close.
        const merged: NormalizedChartCandle = {
          ...lastCandle,
          high: Math.max(lastCandle.high, forming.high),
          low: Math.min(lastCandle.low, forming.low),
          close: forming.close,
          tickVolume: forming.tickCount,
          isComplete: false,
          isFinal: false,
          isForming: true,
          receivedAt: new Date(now).toISOString(),
          qualityFlags: lastCandle.qualityFlags.includes("FORMING_BAR")
            ? lastCandle.qualityFlags
            : [...lastCandle.qualityFlags, "FORMING_BAR"],
        };
        candles = [...candles.slice(0, -1), merged];
        formingTipPresent = true;
      }
      // tipOpenMs < lastClosedOpenMs → stale tip behind the closed feed; ignore.
      if (formingTipPresent) {
        formingTickAgeMs = getFormingTickAgeMs(symbol, timeframe, now, source);
      }
    }
  }

  // ── Quality precedence (shared freshness module) ──────────────────────
  // The full quality verdict (unavailable > invalid > partial > stale >
  // delayed > clean) + the stale flag + aiUsable are computed by the ONE
  // shared evaluator so every analysis/chart surface classifies a feed
  // identically. Cache-availability never sets aiUsable — only "clean" does.
  const verdict = buildFeedStatus({
    routerOk: result.ok,
    hasSource: result.primaryProvider != null,
    candleCount: candles.length,
    trailingIntervals: trailing,
    syntheticAwaitingTick: derivBacked && !hasLiveTick,
    mockDataDetected: truthResult?.mockDataDetected ?? false,
    invalidOhlcCount: anomalies.invalidOhlcCount,
    missingCandleCount: anomalies.missingCandleCount,
    duplicateCount: anomalies.duplicateCount,
    outOfOrderCount: anomalies.outOfOrderCount,
    routerUserMessage: result.userMessage,
    completenessReason: truthResult?.completenessReason ?? null,
    formingTipPresent,
    formingTickAgeMs,
    newestOpenLeadMs,
    futureStampObserved,
  });
  const quality = verdict.quality;
  const warning = verdict.warning;
  const stale = verdict.stale;
  const aiUsable = verdict.aiUsable;

  // isLive: reachable, current, and (for synthetics) confirmed ticking. When a
  // forming tip is present its tick freshness (folded into the verdict) governs
  // liveness — a frozen tip (>15s silent) reads NOT live even though a closed
  // bar still trails by only one interval.
  //
  // The durable market_candles mirror (tryMt5Candles step 2) is never live: it
  // is served only when no bridge is currently pushing this series, it carries
  // no bridge/owner attribution and its entitlement delay is unknown. Its bars
  // are real stored broker bars (quality still describes them), but nothing
  // backs a "live" claim.
  const durableMirror = result.ok && result.provenance?.subProviderId === DURABLE_MIRROR_SUB_PROVIDER;
  //
  // Scheduled weekend closure: on coarse timeframes the newest bar of a closed
  // market stays within one interval of the epoch-aligned "current" bar for
  // hours (D1: all Saturday morning), so the trailing gap alone reads current.
  // When the instrument's session is in its weekend window, the newest
  // provider bar opened before the scheduled close, and no tick for this
  // series' source has observably MOVED in the last two minutes (the EA keeps
  // replaying a frozen quote on weekends), nothing shows a trading market —
  // the series is not live. Observed trading always beats the static schedule.
  const tickSource = isFormingTickSource(source) ? source : null;
  const tickFreshness = tickSource === "mt5_broker"
    ? mt5TickFreshness
    : tickSource
      ? getFeedFreshness(symbol, now, tickSource)
      : null;
  const tradingObserved =
    tickFreshness?.quoteMovedWallMs != null && now - tickFreshness.quoteMovedWallMs <= MARKET_FROZEN_WALL_FRESH_MS;
  const closure = lastCandle && !tradingObserved
    ? scheduledWeekendClosure(getSymbolProfile(symbol, assetClass).session, now)
    : null;
  const marketClosedAtMs = closure && lastCandle && Date.parse(lastCandle.openTime) < closure.closedAtMs
    ? closure.closedAtMs
    : null;
  const reachable = source != null && candles.length > 0;
  const isLive = timestampsUnconfirmed || durableMirror || marketClosedAtMs != null
    ? false
    : formingTipPresent
      ? reachable && !verdict.stale
      : reachable && trailing != null && trailing <= 1 && (!derivBacked || hasLiveTick);

  const message = buildMessage(quality, source, displaySymbol, {
    isLive,
    durableMirror,
    newestOpenTime: lastCandle?.openTime ?? null,
    marketClosedAtMs,
  });

  const status: ChartFeedStatus = {
    symbol,
    displaySymbol,
    assetClass,
    source,
    isLive,
    lastTickTime,
    lastCandleTime,
    latencyMs,
    missingCandleCount: anomalies.missingCandleCount,
    duplicateCount: anomalies.duplicateCount,
    outOfOrderCount: anomalies.outOfOrderCount,
    invalidOhlcCount: anomalies.invalidOhlcCount,
    trailingIntervals: verdict.trailingIntervals,
    stale,
    quality,
    warning,
    aiUsable,
    feedReadinessState: derivSymbolStatus?.feedReadinessState ?? null,
    message,
    completenessReason: verdict.completenessReason,
  };

  // Phase 3: Chart Truth Score — derived from Phase 1 signals.
  const chartTruthScore = computeChartTruthScore(truthResult, status);

  return { assetClass, displaySymbol, source, candles, status, truthResult, chartTruthScore,
    marketEvidence: prepareMarketRead(result, symbol, timeframe, now)?.evidence ?? null,
    seriesAttribution: result.ok ? seriesAttributionFrom(result.provenance) : null };
}

/**
 * Human-friendly label for a resolved feed source, so feed-status copy reflects
 * a genuinely broker-native feed distinctly from third-party fallbacks. Never
 * fabricates — it only renames whatever source actually answered.
 */
function friendlyFeedSource(source: string | null): string {
  if (!source) return "no source";
  // Never "your": the chart route has no viewer, and an unpinned MT5 read
  // serves whichever bridge pushed last — possibly another user's terminal.
  if (source === "mt5_broker") return "MetaTrader 5 broker bridge";
  if (source === "deriv" || source === "deriv_public") return "Deriv";
  if (source.startsWith("assistant_real:")) {
    const sub = source.slice("assistant_real:".length).trim();
    return sub.length > 0 ? sub : "market-data provider";
  }
  return source;
}

/** Router sub-provider id of the restart-surviving MT5 market_candles mirror. */
const DURABLE_MIRROR_SUB_PROVIDER = "durable_mirror";

interface MessageContext {
  isLive: boolean;
  durableMirror: boolean;
  /** Newest provider bar's open time (ISO), before any display tip. */
  newestOpenTime: string | null;
  /** Scheduled weekend close (epoch ms) the series predates, or null. */
  marketClosedAtMs: number | null;
}

function utcStamp(iso: string | null): string {
  if (!iso) return "an unknown time";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "an unknown time";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function buildMessage(
  quality: ChartQuality,
  source: string | null,
  displaySymbol: string,
  ctx: MessageContext,
): string {
  if (ctx.marketClosedAtMs != null && (quality === "clean" || quality === "delayed")) {
    return `Market closed for ${displaySymbol} since the scheduled weekend close (${utcStamp(new Date(ctx.marketClosedAtMs).toISOString())}); newest bar opened ${utcStamp(ctx.newestOpenTime)}. No live data until the market reopens.`;
  }
  if (ctx.durableMirror && (quality === "clean" || quality === "delayed")) {
    return `Showing stored MetaTrader 5 broker candles for ${displaySymbol} (newest bar opened ${utcStamp(ctx.newestOpenTime)}). No broker bridge is pushing this series right now, so this is not a live feed.`;
  }
  switch (quality) {
    case "clean":
      return ctx.isLive
        ? `Live feed active for ${displaySymbol} (${friendlyFeedSource(source)}).`
        : `Candles for ${displaySymbol} from ${friendlyFeedSource(source)} are complete but not confirmed live (newest bar opened ${utcStamp(ctx.newestOpenTime)}).`;
    case "delayed":
      return `Feed for ${displaySymbol} is delayed / not yet confirmed real-time.`;
    case "stale":
      return `Feed for ${displaySymbol} is stale.`;
    case "partial":
      return `Feed for ${displaySymbol} returned an incomplete candle sequence.`;
    case "invalid":
      return `Feed for ${displaySymbol} failed candle integrity checks.`;
    case "empty":
      return `No candles available for ${displaySymbol} right now.`;
    case "unavailable":
    default:
      return `No live feed available for ${displaySymbol}.`;
  }
}

export async function getChartCandles(
  symbol: string,
  timeframe: ChartTimeframe,
  limit: number,
  includeFormingTip: boolean = false,
): Promise<ChartCandlesResponse> {
  // `includeFormingTip` defaults FALSE so every analysis caller (flame signal,
  // chart-intelligence, timeframe agreement, market overview, truth audit) gets
  // closed bars only. The chart DISPLAY route passes true.
  const feed = await buildChartFeed(symbol, timeframe, limit, includeFormingTip);
  // The series' observed identity rides along as a non-enumerable symbol
  // property (read with chartSeriesAttribution); the JSON wire is unchanged.
  return attachSeriesAttribution({
    symbol,
    displaySymbol: feed.displaySymbol,
    timeframe,
    assetClass: feed.assetClass,
    source: feed.source,
    quality: feed.status.quality,
    aiUsable: feed.status.aiUsable,
    warning: feed.status.warning,
    latencyMs: feed.status.latencyMs,
    requestedLimit: limit,
    candleCount: feed.candles.length,
    candles: feed.candles,
    feedStatus: feed.status,
    marketEvidence: feed.marketEvidence,
    truthResult: feed.truthResult,
    chartTruthScore: feed.chartTruthScore,
  }, feed.seriesAttribution);
}

// feed-status probes with a small window — enough to assess liveness and
// trailing-gap without pulling a full chart payload.
const FEED_STATUS_PROBE_LIMIT = 5;

export async function getChartFeedStatus(
  symbol: string,
  timeframe: ChartTimeframe,
  includeFormingTip: boolean = false,
): Promise<ChartFeedStatus> {
  // Defaults FALSE so market-availability + provider-health probes read closed-
  // bar provider truth (a forming tip must never mask a stale provider). The
  // chart DISPLAY feed-status route passes true.
  const feed = await buildChartFeed(symbol, timeframe, FEED_STATUS_PROBE_LIMIT, includeFormingTip);
  return feed.status;
}
