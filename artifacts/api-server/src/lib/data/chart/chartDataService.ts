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
import { buildFeedStatus, type FeedQuality } from "../freshness.js";
import {
  getFormingBar,
  getFormingTickAgeMs,
  type FormingBarSnapshot,
  type FormingTickProvider,
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
 * Provider family a winning candle-source label belongs to, for forming-tip
 * basis coherence. Returns null when the family is unrecognized — an unknown
 * source asserts nothing (never guessed).
 */
function formingSourceFamily(source: string | null): FormingTickProvider | null {
  if (!source) return null;
  if (source === "mt5_broker") return "mt5_broker";
  if (source === "deriv" || source.startsWith("deriv")) return "deriv";
  if (source.startsWith("assistant_real")) return "assistant_real";
  return null;
}

/**
 * A tip may sit under closed bars ONLY when it was folded from the SAME
 * provider family that serves those bars — an assistant last/mid tick under
 * broker BID candles would draw a half-spread seam (the per-provider pairing
 * the composer header documents). "unattributed" folds (legacy/tests) and an
 * unknown source family keep the C3.2 behavior: the real-tick question alone
 * decides.
 */
function formingTipBasisCoherent(
  tipProvider: FormingTickProvider,
  family: FormingTickProvider | null,
): boolean {
  if (tipProvider === "unattributed" || family == null) return true;
  return tipProvider === family;
}

/**
 * Single source of truth used by BOTH chart endpoints. Calls the existing
 * router directly so we see the full attempt log (for latency + source) and
 * derives quality from the normalized + truth-validated candles.
 *
 * `includeFormingTip` (default FALSE) is the ONLY switch that folds the live
 * forming-bar tip onto the newest bar. It is passed `true` ONLY by the chart
 * display/feed-status surfaces. Every analysis caller (chart-intelligence,
 * flame signal, timeframe agreement, market overview, Ruby) leaves it false so
 * they keep consuming closed bars exclusively. truthResult + chartTruthScore are
 * always computed on the closed bars BEFORE any tip is appended.
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

  // Latency: the winning provider's measured ms, else total probe cost.
  const okAttempt = result.attempts.find((a) => a.ok);
  const latencyMs = okAttempt
    ? okAttempt.ms
    : result.attempts.length > 0
      ? result.attempts.reduce((s, a) => s + a.ms, 0)
      : null;

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
  const derivBacked = synthetic && (source === "deriv" || (source?.startsWith("deriv") ?? false));
  const derivSymbolStatus = derivBacked ? getDerivSymbolFeedStatus(symbol) : null;
  const hasLiveTick = derivSymbolStatus?.hasRecentTick ?? false;

  // Trailing-gap + last-CLOSED-candle are computed BEFORE any forming tip so
  // they always describe provider truth (the tip would pin trailing to 0).
  const trailing = trailingIntervalGap(candles, timeframe, now);
  const lastCandle = candles[candles.length - 1] ?? null;
  const lastCandleTime = lastCandle ? lastCandle.closeTime : null;
  const lastTickTime = derivSymbolStatus?.lastTickAt ?? null;

  // ── Forming tip (Task #496, opt-in, any live provider) ────────────────
  // Fold the live-tick forming bar onto the newest bar for the DISPLAY surface.
  // The closed bars above remain the truth basis (truthResult/chartTruthScore
  // were already computed); the tip only changes what is rendered + how
  // freshness reads. The authoritative closed CANDLE that lands one interval
  // later naturally supersedes the tip (its openMs moves past the tip → ignore),
  // so there is never an orphan duplicate.
  //
  // PROVIDER SCOPE (Theme C3.2): the append gate is deliberately NOT keyed on
  // the winning candle source. It used to require `source === "mt5_broker"`,
  // which froze every Deriv-fed chart between closed candles — up to a full
  // interval of no motion on a perfectly healthy feed. The question that
  // actually matters is "is there a REAL tick for this symbol's current
  // interval", and getFormingBar already answers exactly that: a symbol with no
  // folded ticks returns null and gets no tip. Basis stays coherent because the
  // tip is folded from the same provider's stream that serves the closed bars
  // beneath it (broker BID under broker candles, Deriv quotes under Deriv
  // candles).
  let formingTipPresent = false;
  let formingTickAgeMs: number | null = null;
  if (includeFormingTip && lastCandle) {
    const forming = getFormingBar(symbol, timeframe, now);
    // Basis coherence (R1 residual): a tip folded from one provider's quote
    // stream never sits under closed bars served by a DIFFERENT provider
    // family. A mismatch yields an honest absent tip — never a substituted
    // price on a foreign basis.
    if (forming && formingTipBasisCoherent(forming.provider, formingSourceFamily(source))) {
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
        formingTickAgeMs = getFormingTickAgeMs(symbol, timeframe, now);
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
  });
  const quality = verdict.quality;
  const warning = verdict.warning;
  const stale = verdict.stale;
  const aiUsable = verdict.aiUsable;

  // isLive: reachable, current, and (for synthetics) confirmed ticking. When a
  // forming tip is present its tick freshness (folded into the verdict) governs
  // liveness — a frozen tip (>15s silent) reads NOT live even though a closed
  // bar still trails by only one interval.
  const reachable = source != null && candles.length > 0;
  const isLive = formingTipPresent
    ? reachable && !verdict.stale
    : reachable && trailing != null && trailing <= 1 && (!derivBacked || hasLiveTick);

  const message = buildMessage(quality, source, displaySymbol);

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

  return { assetClass, displaySymbol, source, candles, status, truthResult, chartTruthScore };
}

/**
 * Human-friendly label for a resolved feed source, so feed-status copy reflects
 * a genuinely broker-native feed distinctly from third-party fallbacks. Never
 * fabricates — it only renames whatever source actually answered.
 */
function friendlyFeedSource(source: string | null): string {
  if (!source) return "no source";
  if (source === "mt5_broker") return "your broker's MetaTrader 5 feed";
  if (source === "deriv") return "Deriv";
  if (source.startsWith("assistant_real:")) {
    const sub = source.slice("assistant_real:".length).trim();
    return sub.length > 0 ? sub : "market-data provider";
  }
  return source;
}

function buildMessage(
  quality: ChartQuality,
  source: string | null,
  displaySymbol: string,
): string {
  switch (quality) {
    case "clean":
      return `Live feed active for ${displaySymbol} (${friendlyFeedSource(source)}).`;
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
  return {
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
    truthResult: feed.truthResult,
    chartTruthScore: feed.chartTruthScore,
  };
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
