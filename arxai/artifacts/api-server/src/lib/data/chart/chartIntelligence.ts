// Chart Brain v2 — Task 1: Chart Intelligence State (Fast Brain builder).
//
// Assembles a centralized per-symbol/timeframe Chart Intelligence State on top
// of the EXISTING Level 1 Truth Layer (`chartDataService`). This is the Fast
// Brain: it computes only cheap, candle-only fields (stats, basic proximity /
// momentum flags) and leaves the heavy market-understanding / setup / decision
// engines as EXPLICIT placeholders for later Chart Brain v2 tasks. Nothing here
// is ever fabricated — when there is no usable candle window the numbers are
// null and `populated` reads false.
//
// HARD RULES honoured here:
//  - Never fabricates a candle or a number. No window => honest empty stats.
//  - Mirrors the truth layer's aiUsable/quality — dirty feed => not AI-usable.
//  - Adds NO new data source; reads ONLY the truth layer.
//  - Pure Fast-Brain work — never invokes the Slow Brain (background-only).

import {
  getChartCandles,
  type ChartFeedStatus,
} from "./chartDataService.js";
import type { TimeframeTruthResult } from "./candleTruthEngine.js";
import type { NormalizedChartCandle } from "./candleNormalization.js";
import {
  buildChartTrendlineOverlay,
  type ChartTrendlineOverlay,
} from "./chartTrendlineOverlay.js";
import type { AssetClass } from "../marketDataRouter.js";
import type { ChartTimeframe } from "./timeframes.js";
import { MIN_SUFFICIENT_CLOSED_BARS } from "@workspace/domain/market";
import {
  SLOW_BRAIN_BLOCKED_LIVE_EXECUTION,
  getSlowBrainLastRunAt,
} from "./chartSlowBrain.js";
import { computeTrendRegime } from "./engines/trendRegime.js";
import { computeLevelPersonality } from "./engines/levelPersonality.js";
import { computeCandleIntent } from "./engines/candleIntent.js";
import { computeSetupLifecycle, type ChartSetupRead } from "./engines/setupLifecycle.js";
import { getTimeframeAgreement } from "./engines/timeframeAgreement.js";
import { computeEvidenceStack } from "./engines/evidenceStack.js";
import { computeTradeReadiness } from "./engines/tradeReadiness.js";
import { recordChartEvents, getRecentChartEvents } from "./engines/chartMarketMemory.js";
import {
  buildMarketSentences,
  type ChartMarketSentences,
} from "./marketSentenceEngine.js";
import {
  computeDecisionReasoning,
  type ChartDecisionReasoning,
} from "./engines/decisionReasoning.js";
import {
  computeDecisionFork,
  type ChartDecisionFork,
} from "./engines/decisionFork.js";
import {
  computeChartAgentConsensus,
  type ChartAgentConsensus,
} from "./chartAgentConsensus.js";
import { computeChartTruthScore, type ChartTruthScore } from "./chartTruthScore.js";
import { computeChartReadScore, type ChartReadScore } from "./chartReadScore.js";
import { computeChartGateOutput, type ChartGateOutput } from "./chartGateOutput.js";
import {
  noBrokerAlignment,
  computeBrokerPriceAlignment,
  type BrokerPriceAlignment,
  type BrokerAlignmentInputs,
} from "./brokerPriceAlignment.js";
import type {
  ChartTrendRead,
  ChartLevelsRead,
  ChartCandleIntentRead,
  ChartTimeframeAgreement,
  ChartEvidenceRead,
  ChartReadinessRead,
  ChartEvidenceDirection,
  ChartQualityLabel,
} from "./engines/marketUnderstandingTypes.js";

export interface ChartCandleStats {
  barsAnalyzed: number;
  direction: "up" | "down" | "flat" | "unknown";
  lastClose: number | null;
  changeAbs: number | null;
  changePct: number | null;
  range: number | null;
  body: number | null;
  avgRange: number | null;
  atr: number | null;
}

export interface ChartFastFlags {
  populated: boolean;
  momentumBurst: boolean;
  nearRecentHigh: boolean;
  nearRecentLow: boolean;
  note: string | null;
}

export interface ChartMarketUnderstanding {
  populated: boolean;
  trend: ChartTrendRead;
  levels: ChartLevelsRead;
  candleIntent: ChartCandleIntentRead;
  timeframeAgreement: ChartTimeframeAgreement;
  evidence: ChartEvidenceRead;
  readiness: ChartReadinessRead;
  note: string;
}

// Setup lifecycle output (Engine 1). Mirrors ChartSetupRead exactly.
export type ChartSetupState = ChartSetupRead;

export type ChartDecisionActionability =
  | "stand_aside"
  | "watch"
  | "prepare"
  | "ready"
  | "unknown";

// Read-only decision SUMMARY surfaced from the engine outputs. This is NOT a
// decision/fork engine (reserved for a later task) and the chart NEVER executes
// from it — it only restates readiness + evidence for display/consumers.
export interface ChartDecisionState {
  populated: boolean;
  bias: ChartEvidenceDirection;
  quality: ChartQualityLabel;
  actionability: ChartDecisionActionability;
  vetoed: boolean;
  decision: string | null;
  note: string;
}

export interface ChartSpeedState {
  activeMode: string;
  brain: "fast" | "slow";
  feedLatencyMs: number | null;
  stateBuildMs: number | null;
  renderLatencyMs: number | null;
  overlayLatencyMs: number | null;
  slowBrainBlockedLiveExecution: boolean;
  slowBrainLastRunAt: string | null;
}

export interface ChartIntelligenceState {
  symbol: string;
  displaySymbol: string;
  timeframe: ChartTimeframe;
  assetClass: AssetClass;
  aiUsable: boolean;
  stale: boolean;
  truthState: ChartFeedStatus;
  currentCandle: NormalizedChartCandle | null;
  latestClosedCandle: NormalizedChartCandle | null;
  candleStats: ChartCandleStats;
  fastFlags: ChartFastFlags;
  marketUnderstanding: ChartMarketUnderstanding;
  setupState: ChartSetupState;
  decisionState: ChartDecisionState;
  decisionReasoning: ChartDecisionReasoning;
  decisionFork: ChartDecisionFork;
  agentConsensus: ChartAgentConsensus;
  marketSentences: ChartMarketSentences;
  /**
   * Task #651 — display-only trendline/channel overlay (geometry + break/retest/
   * reclaim markers) derived from the existing trendline truth verdict. Honesty
   * fail-closed: `visible:false` + empty geometry when the feed is not
   * live-confirmed or the window is insufficient. NEVER a trade affordance.
   */
  trendlineOverlay: ChartTrendlineOverlay;
  speedState: ChartSpeedState;
  lastUpdated: string;
  /** Phase 3: weighted Chart Truth Score (data quality, freshness, mirror). */
  chartTruthScore: ChartTruthScore;
  /** Phase 3: Chart Read Score (setup readability / tradability). */
  chartReadScore: ChartReadScore;
  /** Phase 3: Hard gate output — which chart-based actions are currently allowed. */
  gateOutput: ChartGateOutput;
  /**
   * Phase 3: Broker price alignment (chart close vs MT5 bid/ask).
   * In the cached intelligence path this uses the noBrokerAlignment default;
   * Phase 4 route-level enrichment will supply live per-user broker data.
   */
  brokerAlignment: BrokerPriceAlignment;
}

// ── Tuning (candle-only, deterministic) ───────────────────────────────────
// ONE DATA-SUFFICIENCY TRUTH: the chart's "enough closed bars" floor is the
// SAME shared constant the scanner + Ruby use, so all three surfaces agree on
// when there are too few candles to derive a confident read (value unchanged).
const MIN_FLAG_BARS = MIN_SUFFICIENT_CLOSED_BARS;
const RECENT_WINDOW = 20;
const ATR_PERIOD = 14;
const NEAR_BAND = 0.15;
const MOMENTUM_MULT = 1.5;

// Brief cache so repeat reads within a tick are instant. Keyed by the truth
// inputs only (the state carries no per-user data); the endpoint itself stays
// per-user gated. Short TTL keeps the live feel without re-probing providers.
const CACHE_TTL_MS = 3000;
interface CacheEntry {
  state: ChartIntelligenceState;
  /** Raw truth result — stored so route-level enrichment can recompute truth/gate
   * with per-user broker alignment without re-fetching candles. */
  truthResult: TimeframeTruthResult | null;
  /** Feed status at build time — needed for truth-score recompute. */
  feedStatus: ChartFeedStatus;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

/**
 * Return the cached intelligence context (state + truth result + feed status)
 * for a symbol/timeframe/limit combination if the cache entry is still live.
 * Returns null when nothing is cached — caller should call
 * `buildChartIntelligenceState` first.
 *
 * Used by routes that enrich the state with per-user broker alignment data
 * without re-fetching candles from the provider.
 */
export function getCachedIntelligenceContext(
  symbol: string,
  timeframe: ChartTimeframe,
  limit: number,
): { state: ChartIntelligenceState; truthResult: TimeframeTruthResult | null; feedStatus: ChartFeedStatus } | null {
  const entry = cache.get(`${symbol}|${timeframe}|${limit}`);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return { state: entry.state, truthResult: entry.truthResult, feedStatus: entry.feedStatus };
}

/**
 * Rebuild only the broker-alignment-dependent outputs (alignment, truth score,
 * gate output) with a real per-user broker quote and merge them back into the
 * state. All other fields are unchanged.
 *
 * Caller is responsible for ensuring that only admin-safe fields of the
 * alignment result are surfaced to end users (adminDetail must be stripped).
 */
export function enrichStateWithBrokerAlignment(
  state: ChartIntelligenceState,
  truthResult: TimeframeTruthResult | null,
  feedStatus: ChartFeedStatus,
  brokerInputs: BrokerAlignmentInputs,
): ChartIntelligenceState {
  const brokerAlignment = computeBrokerPriceAlignment(brokerInputs);
  const chartTruthScore = computeChartTruthScore(truthResult, feedStatus, brokerAlignment);
  const gateOutput = computeChartGateOutput(
    chartTruthScore,
    state.chartReadScore,
    brokerAlignment,
    truthResult,
    feedStatus.stale,
  );
  return { ...state, brokerAlignment, chartTruthScore, gateOutput };
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function computeStats(closed: NormalizedChartCandle[]): ChartCandleStats {
  const n = closed.length;
  if (n === 0) {
    return {
      barsAnalyzed: 0,
      direction: "unknown",
      lastClose: null,
      changeAbs: null,
      changePct: null,
      range: null,
      body: null,
      avgRange: null,
      atr: null,
    };
  }
  const last = closed[n - 1]!;
  const lastClose = last.close;
  const range = last.high - last.low;
  const body = Math.abs(last.close - last.open);

  let changeAbs: number | null = null;
  let changePct: number | null = null;
  let direction: ChartCandleStats["direction"] = "unknown";
  if (n >= 2) {
    const prev = closed[n - 2]!;
    changeAbs = last.close - prev.close;
    changePct = prev.close !== 0 ? (changeAbs / prev.close) * 100 : null;
    direction = changeAbs > 0 ? "up" : changeAbs < 0 ? "down" : "flat";
  }

  const rangeWin = closed.slice(Math.max(0, n - RECENT_WINDOW));
  const avgRange = mean(rangeWin.map((c) => c.high - c.low));

  const atrWin = closed.slice(Math.max(0, n - (ATR_PERIOD + 1)));
  const trs: number[] = [];
  for (let i = 0; i < atrWin.length; i++) {
    const c = atrWin[i]!;
    if (i === 0) {
      trs.push(c.high - c.low);
    } else {
      const p = atrWin[i - 1]!;
      trs.push(
        Math.max(
          c.high - c.low,
          Math.abs(c.high - p.close),
          Math.abs(c.low - p.close),
        ),
      );
    }
  }
  const atr = trs.length > 0 ? mean(trs) : null;

  return {
    barsAnalyzed: n,
    direction,
    lastClose,
    changeAbs,
    changePct,
    range,
    body,
    avgRange: rangeWin.length > 0 ? avgRange : null,
    atr,
  };
}

function computeFastFlags(
  closed: NormalizedChartCandle[],
  stats: ChartCandleStats,
): ChartFastFlags {
  const n = closed.length;
  if (n < MIN_FLAG_BARS) {
    return {
      populated: false,
      momentumBurst: false,
      nearRecentHigh: false,
      nearRecentLow: false,
      note: `Not enough closed candles (${n}) to derive fast flags.`,
    };
  }
  const win = closed.slice(Math.max(0, n - RECENT_WINDOW));
  const hi = Math.max(...win.map((c) => c.high));
  const lo = Math.min(...win.map((c) => c.low));
  const span = hi - lo;
  const lastClose = closed[n - 1]!.close;

  let nearRecentHigh = false;
  let nearRecentLow = false;
  if (span > 0) {
    const posFromLow = (lastClose - lo) / span;
    nearRecentHigh = posFromLow >= 1 - NEAR_BAND;
    nearRecentLow = posFromLow <= NEAR_BAND;
  }

  const lastRange = closed[n - 1]!.high - closed[n - 1]!.low;
  const momentumBurst =
    stats.avgRange != null && stats.avgRange > 0
      ? lastRange > stats.avgRange * MOMENTUM_MULT
      : false;

  return {
    populated: true,
    momentumBurst,
    nearRecentHigh,
    nearRecentLow,
    note: null,
  };
}

function deriveDecisionState(
  evidence: ChartEvidenceRead,
  readiness: ChartReadinessRead,
  setup: ChartSetupRead,
  fork: ChartDecisionFork,
): ChartDecisionState {
  if (!readiness.populated) {
    return {
      populated: false,
      bias: "unknown",
      quality: "unrated",
      actionability: "unknown",
      vetoed: false,
      decision: null,
      note: "Not enough data to summarise a decision. The chart never executes from this state.",
    };
  }

  let actionability: ChartDecisionActionability;
  if (readiness.vetoed || setup.stage === "invalid") {
    actionability = "stand_aside";
  } else if (readiness.quality === "A+" || readiness.quality === "A") {
    actionability = "ready";
  } else if (readiness.quality === "B") {
    actionability = "prepare";
  } else if (readiness.quality === "C") {
    actionability = "watch";
  } else {
    actionability = "stand_aside";
  }

  // Setup downgrade-on-failed-expectation: when the fork engine detects the
  // expected behaviour is already failing, knock an actionable read down a notch
  // so the summary stops inviting action it no longer deserves. Honest and
  // bounded — it only ever lowers, never raises, and the chart still executes
  // from nothing.
  let downgraded = false;
  if (fork.downgrade && (actionability === "ready" || actionability === "prepare")) {
    actionability = "watch";
    downgraded = true;
  }

  const biasWord =
    evidence.direction === "bullish"
      ? "long"
      : evidence.direction === "bearish"
        ? "short"
        : "no";
  const decision = `${actionability.replace("_", " ")} — ${biasWord} bias, quality ${readiness.quality}`;

  const note = downgraded
    ? `Read-only summary of the engine outputs. Downgraded — ${fork.downgradeReason ?? "expected behaviour failed"}. The chart never executes from this state.`
    : "Read-only summary of the engine outputs. This is not a decision/fork engine and the chart never executes from this state.";

  return {
    populated: true,
    bias: evidence.direction,
    quality: readiness.quality,
    actionability,
    vetoed: readiness.vetoed,
    decision,
    note,
  };
}

/**
 * Fast Brain entry point. Builds the Chart Intelligence State from the truth
 * layer for a symbol/timeframe. Always returns an honest state — never throws
 * for a missing feed (the truth layer already encodes unavailability), so a
 * caller can render the chart regardless.
 */
export async function buildChartIntelligenceState(
  symbol: string,
  timeframe: ChartTimeframe,
  limit: number,
): Promise<ChartIntelligenceState> {
  const cacheKey = `${symbol}|${timeframe}|${limit}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.state;
  }

  const buildStart = now;
  const truth = await getChartCandles(symbol, timeframe, limit);

  const candles = truth.candles;
  const lastCandle = candles[candles.length - 1] ?? null;
  const currentCandle =
    lastCandle != null && lastCandle.isComplete === false ? lastCandle : null;
  const closed = candles.filter((c) => c.isComplete);
  const latestClosedCandle = closed[closed.length - 1] ?? null;

  const candleStats = computeStats(closed);
  const fastFlags = computeFastFlags(closed, candleStats);

  // ── Market Understanding Engines (deterministic, candle-only) ───────────
  // Engine 2's level personality folds in remembered market events. The read
  // is defensive (returns [] on any error) so the hot path is never blocked.
  const remembered = await getRecentChartEvents(truth.symbol, timeframe);

  const trend = computeTrendRegime(closed);
  const levelsResult = computeLevelPersonality(
    closed,
    remembered,
    truth.symbol,
    timeframe,
  );
  const levels = levelsResult.read;
  const candleIntent = computeCandleIntent(closed);

  // Engine 4 is heavy (4 timeframes) — read the cached value instantly and let
  // it refresh in the background (Slow Brain). Never awaited on the hot path.
  const timeframeAgreement = getTimeframeAgreement(truth.symbol);

  const setup = computeSetupLifecycle(closed, timeframe, trend, levels, candleIntent);
  const evidence = computeEvidenceStack(
    trend,
    levels,
    candleIntent,
    setup,
    timeframeAgreement,
  );
  const readiness = computeTradeReadiness({
    feedUsable: truth.aiUsable,
    feedStale: truth.feedStatus.stale,
    trend,
    levels,
    candleIntent,
    setup,
    tfAgreement: timeframeAgreement,
    evidence,
  });

  // Best-effort, fire-and-forget persistence of any newly detected events.
  if (truth.aiUsable && levelsResult.newEvents.length > 0) {
    void recordChartEvents(levelsResult.newEvents);
  }

  const understandingPopulated =
    trend.populated && levels.populated && candleIntent.populated;

  const marketUnderstanding: ChartMarketUnderstanding = {
    populated: understandingPopulated,
    trend,
    levels,
    candleIntent,
    timeframeAgreement,
    evidence,
    readiness,
    note: understandingPopulated
      ? "Market-understanding engines populated from the candle truth layer."
      : "Insufficient candle window for full market understanding — populated fields are honest.",
  };

  const setupState: ChartSetupState = setup;

  // Decision-reasoning engines (deterministic, over the state). Computed before
  // the decision summary so the fork's downgrade signal can feed it.
  const decisionReasoning: ChartDecisionReasoning = computeDecisionReasoning({
    trend,
    levels,
    evidence,
    setup,
  });
  const decisionFork: ChartDecisionFork = computeDecisionFork({
    trend,
    levels,
    candleIntent,
    setup,
  });

  const decisionState: ChartDecisionState = deriveDecisionState(
    evidence,
    readiness,
    setup,
    decisionFork,
  );

  // Agent-consensus summary (advisory/shadow only; never gates a trade or the
  // live path; fail-open). Honestly absent when specialist agents are in shadow.
  const agentConsensus: ChartAgentConsensus = await computeChartAgentConsensus(
    decisionState,
    readiness.score,
  );

  const speedState: ChartSpeedState = {
    activeMode: "fast_brain",
    brain: "fast",
    feedLatencyMs: truth.latencyMs,
    stateBuildMs: Date.now() - buildStart,
    renderLatencyMs: null,
    overlayLatencyMs: null,
    slowBrainBlockedLiveExecution: SLOW_BRAIN_BLOCKED_LIVE_EXECUTION,
    slowBrainLastRunAt: getSlowBrainLastRunAt(),
  };

  // Phase 3: Chart Truth Score, Chart Read Score, Gate Output, Broker Alignment.
  // Broker alignment placeholder computed first so it can be fed into the truth
  // score's SymbolMirrorAccuracy sub-metric. Phase 4 route-level enrichment
  // replaces the placeholder with real per-user broker tick data.
  const brokerAlignment = noBrokerAlignment(
    latestClosedCandle?.close ?? null,
    "LAST",
  );
  const chartTruthScore = computeChartTruthScore(truth.truthResult, truth.feedStatus, brokerAlignment);

  const chartReadScore = computeChartReadScore({
    barsAnalyzed: candleStats.barsAnalyzed,
    aiUsable: truth.aiUsable,
    marketUnderstanding,
    setup: setupState,
    decisionState,
    readiness,
    candleStats,
  });

  const gateOutput = computeChartGateOutput(
    chartTruthScore,
    chartReadScore,
    brokerAlignment,
    truth.truthResult,
    truth.feedStatus.stale,
  );

  // Natural-language reader over the assembled engine outputs. Deterministic
  // and honest: it reads only the state fields below and never re-fetches or
  // fabricates. Built before the final state so it can be attached as a field.
  // Display-only trendline/channel overlay derived from the SAME candle window.
  // Honesty facts are the chart's ALREADY-DECIDED verdict — the producer never
  // recomputes feed/sufficiency and fails closed when not live-confirmed.
  const trendlineOverlay = buildChartTrendlineOverlay(candles, {
    feedConfirmed: truth.aiUsable && !truth.feedStatus.stale,
    feedStale: truth.feedStatus.stale,
    sufficiencyAllowsSetup: closed.length >= MIN_SUFFICIENT_CLOSED_BARS,
    chartReadConfidenceLow: !truth.aiUsable,
  });

  const sentenceInput: Omit<ChartIntelligenceState, "marketSentences"> = {
    symbol: truth.symbol,
    displaySymbol: truth.displaySymbol,
    timeframe: truth.timeframe,
    assetClass: truth.assetClass,
    aiUsable: truth.aiUsable,
    stale: truth.feedStatus.stale,
    truthState: truth.feedStatus,
    currentCandle,
    latestClosedCandle,
    candleStats,
    fastFlags,
    marketUnderstanding,
    setupState,
    decisionState,
    decisionReasoning,
    decisionFork,
    agentConsensus,
    trendlineOverlay,
    speedState,
    lastUpdated: new Date().toISOString(),
    chartTruthScore,
    chartReadScore,
    gateOutput,
    brokerAlignment,
  };
  const marketSentences = buildMarketSentences(sentenceInput);

  const state: ChartIntelligenceState = {
    ...sentenceInput,
    marketSentences,
  };

  cache.set(cacheKey, {
    state,
    truthResult: truth.truthResult,
    feedStatus: truth.feedStatus,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return state;
}
