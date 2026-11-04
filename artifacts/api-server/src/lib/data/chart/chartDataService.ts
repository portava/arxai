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
import { routeStoredCandleHistory, STORED_HISTORY_SUB_PROVIDER } from "../storedCandleHistory.js";
import { currentFeedScopeBridge } from "../feedScope.js";
import { MULTI_BRIDGE_CONTENTION_NOTE, mt5SeriesContention, readMt5Quote } from "../providers/mt5Provider.js";
import { getBrokerClockOffset } from "../../brokerHub/brokerClockOffset.js";
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
  type FormingPartition,
} from "./formingBarComposer.js";
import { brokerBucketCloseMs, isBrokerBucketAligned } from "./brokerBucket.js";

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
  /**
   * Why the series is not live although its bars may be clean: the market is
   * in its scheduled weekend close ("market_closed"), or the bars are the
   * stored MT5 mirror with no bridge pushing them ("stored_history"). null
   * when neither applies, or when the bars failed their checks (quality
   * partial / invalid / empty; stale too for stored bars) — the message then
   * names that failure, so the series is not "history" to read. Lets consumers that bucket freshness (e.g. the
   * symbol snapshot's DELAYED) say what the chart says instead of "delayed".
   */
  notLiveReason?: "market_closed" | "stored_history" | null;
  /**
   * Whose feed this is (Truth audit T2): the requesting trader's own bridge
   * ("own_bridge"), another bridge's MT5 series served platform-wide
   * ("platform_shared"), a non-MT5 provider ("provider"), or null when nothing
   * was served. Absent from older servers.
   */
  feedScope?: ChartFeedScope | null;
  /**
   * Two attributed bridges were pushing this symbol+timeframe when it was read;
   * the served series is one of them. Named, never silently resolved.
   */
  contention?: boolean;
  /**
   * The measured broker-clock offset (ms, broker − UTC) in force for the serving
   * bridge; its bar and tick stamps were converted to UTC with it at ingest.
   * null when unknown (stamps are the broker's raw clock; freshness fails closed).
   */
  brokerClockOffsetMs?: number | null;
  /**
   * What `lastTickTime` is: the producer's own tick time ("producer_tick") or
   * the time this server received the tick ("server_receive", which can never
   * prove the tick is current). null when there is no last tick.
   */
  lastTickTimeBasis?: "producer_tick" | "server_receive" | null;
}

export type ChartFeedScope = "own_bridge" | "platform_shared" | "provider";

/** Reader context for a feed build (Truth audit T2). */
export interface ChartFeedOptions {
  /** The requesting trader's own bridge connection; pins the MT5 read to it. */
  bridgeConnectionId?: number | null;
  /**
   * Chart DISPLAY only: when no provider can serve the series (market closed,
   * bridge disconnected, no feed configured), serve the newest bars already
   * stored in market_candles, labelled stored history and never live or
   * AI-usable. Analysis and decision callers leave this off.
   */
  storedHistoryFallback?: boolean;
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
  const closeMs = brokerBucketCloseMs(forming.openMs, timeframe, forming.brokerOffsetMs);
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
  opts: ChartFeedOptions = {},
): Promise<BuiltFeed> {
  const assetClass = classifySymbol(symbol);
  const displaySymbol = resolveDisplaySymbol(symbol, assetClass);
  const now = Date.now();

  // Whose feed (Truth audit T2): with a requesting bridge the MT5 read is
  // pinned to that trader's own partition. When their bridge is not pushing
  // this series, the platform-wide MT5 series (another bridge's) may still be
  // served, but it is LABELLED platform_shared — never passed off as theirs.
  // With no explicit pin the bound reader's bridge (lib/data/feedScope.ts)
  // is the pin, so the AI, scanner and chart banners built in one request
  // all describe the same series.
  const pinnedBridge = opts.bridgeConnectionId ?? (await currentFeedScopeBridge());
  let result = await routeCandles(symbol, timeframe, limit, { bridgeConnectionId: pinnedBridge });
  if (pinnedBridge != null && result.primaryProvider !== "mt5_broker") {
    const shared = await routeCandles(symbol, timeframe, limit, { bridgeConnectionId: null });
    if (shared.primaryProvider === "mt5_broker") result = shared;
  }
  // Nothing live answered: the display chart still shows the market up to its
  // last stored bar (closed market or a down feed), labelled as stored.
  if (!result.ok && opts.storedHistoryFallback === true) {
    result = await routeStoredCandleHistory(symbol, timeframe, limit, result);
  }
  const storedHistory = result.ok && result.provenance?.subProviderId === STORED_HISTORY_SUB_PROVIDER;
  const source = result.primaryProvider;
  const servingBridgeId = result.ok ? (result.provenance?.bridgeConnectionId ?? null) : null;
  const feedScope: ChartFeedScope | null = source == null
    ? null
    : source === "mt5_broker"
      ? (pinnedBridge != null && servingBridgeId === pinnedBridge ? "own_bridge" : "platform_shared")
      : "provider";
  // A pinned read never reports contention itself (it never blends), so ask the
  // store directly whether two bridges are pushing this series.
  const contention = result.ok && source === "mt5_broker" &&
    ((result.provenanceNotes ?? []).includes(MULTI_BRIDGE_CONTENTION_NOTE) || mt5SeriesContention(symbol, timeframe, now));
  const brokerClock = source === "mt5_broker" ? getBrokerClockOffset(servingBridgeId, now) : null;

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

  // Tick evidence for this series' source, read once and shared by the truth
  // engine's STALE reason and the feed status below, so the two never
  // disagree on whether the market is closed. The MT5 broker tick also backs
  // "Last tick". A quote that observably moved in the last two minutes means
  // the market is trading, whatever the static weekend schedule says.
  // Tick state is partitioned by writer: an MT5 series reads the ticks of the
  // bridge that wrote its bars, never another broker's.
  const tickPartition: FormingPartition = source === "mt5_broker" ? servingBridgeId : null;
  const mt5TickFreshness = source === "mt5_broker" ? getFeedFreshness(symbol, now, "mt5_broker", tickPartition) : null;
  const tickSource = isFormingTickSource(source) ? source : null;
  const tickFreshness = tickSource === "mt5_broker"
    ? mt5TickFreshness
    : tickSource
      ? getFeedFreshness(symbol, now, tickSource, tickPartition)
      : null;
  const quoteMovedWallMs: number | null = tickFreshness ? tickFreshness.quoteMovedWallMs : null;
  const tradingObserved = quoteMovedWallMs != null && now - quoteMovedWallMs <= MARKET_FROZEN_WALL_FRESH_MS;
  // Three-state evidence for the truth engine: true = a quote moved (trading),
  // false = ticks are still arriving with a frozen quote (positive evidence of
  // a closed market), null = nothing was checked (no tick since boot, a dead
  // tick feed, or a source with no tick stream). Only false lets its STALE
  // reason state a scheduled weekend close; null keeps it hedged.
  const tradingEvidence: boolean | null = tradingObserved
    ? true
    : tickFreshness?.marketFrozen === true
      ? false
      : null;

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
      tradingObserved: tradingEvidence,
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
  // broker tick for this series' own writer. When that bridge's clock offset
  // is measured, the tick's own time (converted to UTC at ingest) is reported
  // with basis producer_tick; otherwise the time the server RECEIVED it, with
  // basis server_receive, which can never prove the tick is current (Truth
  // audit T3). A quote the broker is only replaying (market frozen) is not a
  // new tick, so it reports unknown, never "just now".
  const mt5WriterQuote = source === "mt5_broker"
    ? readMt5Quote(symbol, { writer: { bridgeConnectionId: servingBridgeId }, now })
    : null;
  const mt5TickConverted = mt5WriterQuote != null && mt5WriterQuote.tickTimeObserved && mt5WriterQuote.brokerClockOffsetMs != null
    && Number.isFinite(Date.parse(mt5WriterQuote.quote.timestamp));
  const lastTickTime = derivBacked
    ? derivSymbolStatus?.lastTickAt ?? null
    : mt5TickFreshness && !mt5TickFreshness.marketFrozen
      ? (mt5TickConverted ? mt5WriterQuote!.quote.timestamp : new Date(mt5TickFreshness.lastTickWallMs).toISOString())
      : null;
  const lastTickTimeBasis: ChartFeedStatus["lastTickTimeBasis"] = lastTickTime == null
    ? null
    : derivBacked || mt5TickConverted ? "producer_tick" : "server_receive";

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
  if (includeFormingTip && lastCandle && !storedHistory && isFormingTickSource(source)) {
    const forming = getFormingBar(symbol, timeframe, now, source, tickPartition);
    if (forming) {
      const tipOpenMs = forming.openMs;
      const lastClosedOpenMs = Date.parse(lastCandle.openTime);
      // Safety net for coarse timeframes: a tip that opens inside the newest
      // bar's interval but not on its open is the same session bucketed on a
      // different grid (an offset that changed, a bar pushed before the clock
      // was measured). It is merged into that bar, never appended beside it.
      const sameSessionOffGrid = timeframeMs(timeframe) >= timeframeMs("H2")
        && tipOpenMs > lastClosedOpenMs
        && tipOpenMs - lastClosedOpenMs < timeframeMs(timeframe)
        && !isBrokerBucketAligned(lastClosedOpenMs, timeframe, forming.brokerOffsetMs);
      if (tipOpenMs > lastClosedOpenMs && !sameSessionOffGrid) {
        // Tip is for an interval ahead of the newest closed bar → append.
        candles = [...candles, buildFormingTipCandle(lastCandle, forming, timeframe, now)];
        formingTipPresent = true;
      } else if (tipOpenMs === lastClosedOpenMs || sameSessionOffGrid) {
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
        formingTickAgeMs = getFormingTickAgeMs(symbol, timeframe, now, source, tickPartition);
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
  let warning = verdict.warning;
  const stale = verdict.stale;
  // Stored bars are a record of the past, never an input the AI may read as
  // the current market, however recent the newest one is.
  const aiUsable = verdict.aiUsable && !storedHistory;

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
  // (`tradingObserved` is read before the truth engine runs. The engine's
  // STALE reason is stricter: it states a weekend close only when ticks
  // still arrive with a frozen quote, and stays hedged when no tick evidence
  // exists — see `tradingEvidence`.)
  const session = getSymbolProfile(symbol, assetClass).session;
  const closure = lastCandle && !tradingObserved
    ? scheduledWeekendClosure(session, now)
    : null;
  const marketClosedAtMs = closure && lastCandle && Date.parse(lastCandle.openTime) < closure.closedAtMs
    ? closure.closedAtMs
    : null;
  const reachable = source != null && candles.length > 0;
  const isLive = timestampsUnconfirmed || durableMirror || storedHistory || marketClosedAtMs != null
    ? false
    : formingTipPresent
      ? reachable && !verdict.stale
      : reachable && trailing != null && trailing <= 1 && (!derivBacked || hasLiveTick);

  const messageCtx: MessageContext = {
    isLive,
    durableMirror,
    storedHistory,
    sourceLabel: friendlyFeedSource(source),
    nowMs: now,
    newestOpenTime: lastCandle?.openTime ?? null,
    marketClosedAtMs,
    alwaysOpen: session.alwaysOpen,
    trailingIntervals: verdict.trailingIntervals,
  };
  const message = buildMessage(quality, source, displaySymbol, messageCtx);
  // The shared verdict's lag warning cannot see the session: never let it
  // call a closed (or possibly closed) market a stale feed. Wording only —
  // quality, stale and isLive are unchanged.
  warning = lagWarning(quality, displaySymbol, messageCtx) ?? warning;

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
    notLiveReason: notLiveReasonFor(quality, messageCtx),
    feedScope,
    contention,
    brokerClockOffsetMs: brokerClock?.offsetMs ?? null,
    lastTickTimeBasis,
  };

  // Phase 3: Chart Truth Score — derived from Phase 1 signals.
  const chartTruthScore = computeChartTruthScore(truthResult, status);

  return { assetClass, displaySymbol, source, candles, status, truthResult, chartTruthScore,
    marketEvidence: storedHistory ? null : prepareMarketRead(result, symbol, timeframe, now)?.evidence ?? null,
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
  /** Bars served from stored history because no feed answered (display only). */
  storedHistory?: boolean;
  /** Friendly name of the stored source, for the stored-history wording. */
  sourceLabel?: string;
  /** Serve time, for the newest stored bar's age. */
  nowMs?: number;
  /** Newest provider bar's open time (ISO), before any display tip. */
  newestOpenTime: string | null;
  /** Scheduled weekend close (epoch ms) the series predates, or null. */
  marketClosedAtMs: number | null;
  /** The instrument trades 24/7 (it never has a session close). */
  alwaysOpen?: boolean;
  /** Bars the newest bar trails the current bar by, or null. */
  trailingIntervals?: number | null;
}

/**
 * Plain wording for a lagging series (quality stale or delayed) that does not
 * call a closed market a stale feed:
 *   - scheduled weekend closure the series predates → market closed;
 *   - an instrument with session closes, outside that window → what was
 *     observed (no new bar since …) and that the market may be closed or the
 *     feed delayed (there is no reliable daily-session / holiday source);
 *   - a 24/7 instrument → null (the generic stale/delayed wording is true).
 */
function lagWarning(quality: ChartQuality, displaySymbol: string, ctx: MessageContext): string | null {
  if (quality !== "stale" && quality !== "delayed") return null;
  if (ctx.storedHistory && ctx.marketClosedAtMs == null) return storedHistoryMessage(displaySymbol, ctx);
  if (ctx.marketClosedAtMs != null) {
    return `Market closed for ${displaySymbol} since the scheduled weekend close (${utcStamp(new Date(ctx.marketClosedAtMs).toISOString())}); newest bar opened ${utcStamp(ctx.newestOpenTime)}. Not a feed fault, and not live data.`;
  }
  if (quality === "stale" && ctx.alwaysOpen === false) {
    const gap = typeof ctx.trailingIntervals === "number" && Number.isFinite(ctx.trailingIntervals) ? ctx.trailingIntervals : null;
    if (gap == null || gap >= 2) {
      const behind = gap == null ? "" : ` (${gap} bars behind the current bar)`;
      return `No new ${displaySymbol} bar since one opened ${utcStamp(ctx.newestOpenTime)}${behind}. The market may be closed or the feed delayed; this is not live data.`;
    }
    // Bars are current but the live tick stream that forms the newest bar
    // went silent (forming-tip path).
    return `Live ticks for ${displaySymbol} have stopped, so the forming bar is frozen. The market may be closed or the feed delayed; this is not live data.`;
  }
  return null;
}

function ageText(fromIso: string | null, nowMs: number | undefined): string | null {
  const from = fromIso ? Date.parse(fromIso) : Number.NaN;
  if (!Number.isFinite(from) || nowMs == null || !Number.isFinite(nowMs) || nowMs < from) return null;
  const mins = Math.floor((nowMs - from) / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function storedHistoryMessage(displaySymbol: string, ctx: MessageContext): string {
  const age = ageText(ctx.newestOpenTime, ctx.nowMs);
  return `Showing stored ${ctx.sourceLabel ?? "market"} candles for ${displaySymbol} up to the last bar (opened ${utcStamp(ctx.newestOpenTime)}${age ? `, ${age}` : ""}). No live feed is available right now, so this is history, not live data.`;
}

function utcStamp(iso: string | null): string {
  if (!iso) return "an unknown time";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "an unknown time";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The not-live reason the chart's own message states, or null. Given only
 * under the same quality conditions buildMessage uses for the closed-market /
 * stored-candles wording: bars that failed their checks (partial, invalid,
 * empty) are described as that failure, never as readable history.
 */
function notLiveReasonFor(quality: ChartQuality, ctx: MessageContext): "market_closed" | "stored_history" | null {
  if (ctx.marketClosedAtMs != null && (quality === "clean" || quality === "delayed" || quality === "stale")) return "market_closed";
  if (ctx.durableMirror && (quality === "clean" || quality === "delayed")) return "stored_history";
  if (ctx.storedHistory && (quality === "clean" || quality === "delayed" || quality === "stale")) return "stored_history";
  return null;
}

function buildMessage(
  quality: ChartQuality,
  source: string | null,
  displaySymbol: string,
  ctx: MessageContext,
): string {
  if (ctx.marketClosedAtMs != null && (quality === "clean" || quality === "delayed" || quality === "stale")) {
    return `Market closed for ${displaySymbol} since the scheduled weekend close (${utcStamp(new Date(ctx.marketClosedAtMs).toISOString())}); newest bar opened ${utcStamp(ctx.newestOpenTime)}. No live data until the market reopens.`;
  }
  if (ctx.storedHistory && (quality === "clean" || quality === "delayed" || quality === "stale")) {
    return storedHistoryMessage(displaySymbol, ctx);
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
      return lagWarning(quality, displaySymbol, ctx) ?? `Feed for ${displaySymbol} is stale.`;
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
  opts: ChartFeedOptions = {},
): Promise<ChartCandlesResponse> {
  // `includeFormingTip` defaults FALSE so every analysis caller (flame signal,
  // chart-intelligence, timeframe agreement, market overview, truth audit) gets
  // closed bars only. The chart DISPLAY route passes true.
  const feed = await buildChartFeed(symbol, timeframe, limit, includeFormingTip, opts);
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
  opts: ChartFeedOptions = {},
): Promise<ChartFeedStatus> {
  // Defaults FALSE so market-availability + provider-health probes read closed-
  // bar provider truth (a forming tip must never mask a stale provider). The
  // chart DISPLAY feed-status route passes true.
  const feed = await buildChartFeed(symbol, timeframe, FEED_STATUS_PROBE_LIMIT, includeFormingTip, opts);
  return feed.status;
}
