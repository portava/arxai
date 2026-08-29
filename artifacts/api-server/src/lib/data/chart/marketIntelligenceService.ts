// ── MARKET INTELLIGENCE — backend producer (Task #652) ────────────────────────
//
// The ONE backend call site that turns a RubyChartContext (real candles + the
// already-decided feed/sufficiency truth, mt5_broker-aware via the chart
// intelligence path) into the shared, DISPLAY-ONLY `MarketIntelligenceSnapshot`
// and its `StrategyVerdict`. It runs the SIX pure domain "Truth" contracts
// (Pivot / Direction / Entry / OrderFlow / Timing / Confluence) — composed with
// the existing Pattern & Trendline truths — none of which import any execution /
// feed / sufficiency module, and folds them into ONE read.
//
// HARD BOUNDARY (mirrors the contracts): everything this produces is a CHILD
// INPUT. It can only make a read the SAME or MORE conservative (plus the small,
// bounded supportive nudges the contracts already cap). It can NEVER produce
// trade permission, READY_NOW, override feed/sufficiency/risk truth, or touch the
// 23-gate live pipeline, MT5 bridge, broker dispatch, kill switch, or owner/admin
// overrides. There is deliberately NO execution-permission field anywhere in the
// snapshot or verdict. Fail closed: any error returns `null` (no read impact).
//
// HONESTY: where true Level-2 / tape order-flow, spread, news and wall-clock
// session facts are not actually available offline, this producer degrades them
// honestly — proxy order flow is labelled proxy by the contract, spread/volume
// read "unknown", and no news/spread/liquidity BLOCK is ever fabricated. Session
// is derived deterministically from the latest CLOSED bar's own timestamp (not a
// wall-clock read), and synthetic 24/7 instruments report `synthetic_continuous`.
import {
  resolvePivotTruth,
  computeClassicPivots,
  EMPTY_PIVOT_REACTION,
  type PivotPriorPeriod,
  type PivotSourceTimeframe,
  resolveDirectionTruth,
  type DirectionBias,
  resolveEntryTruth,
  type EntryDirection,
  type EntryType,
  resolveOrderFlowTruth,
  type OrderFlowPressure,
  type ProxyOrderFlowData,
  type TradingSession,
  type CandleState,
  type TimingVolatilityState,
  type MarketPhase,
  resolveTimingTruth,
  composeMarketIntelligenceSnapshot,
  deriveStrategyVerdict,
  requiredClosedBarsForTimeframe,
  type IntelligenceMode,
  type IntelligenceFeedTruth,
  type IntelligenceRiskContext,
  type MarketIntelligenceSnapshot,
  type StrategyVerdict,
  type PatternBias,
} from "@workspace/domain/market";
import { isChartTimeframe, type ChartTimeframe } from "./timeframes.js";
import type { ChartDirection } from "./engines/marketUnderstandingTypes.js";
import type { RubyChartContext } from "./rubyChartContext.js";
import {
  buildPatternTruthVerdict,
  buildPatternLibraryRead,
  type PatternLibraryRead,
} from "./patternTruthService.js";
import { buildTrendlineTruthVerdict } from "./trendlineTruthService.js";
import type { Candle } from "../types.js";

export interface MarketIntelligenceServiceResult {
  snapshot: MarketIntelligenceSnapshot;
  verdict: StrategyVerdict;
  /**
   * Additive, display-only Pattern Library read (Task #654). Composed from the
   * SAME real candles + feed/sufficiency facts as the pattern verdict. Carries no
   * execution-permission field and gates nothing — a pattern is evidence, not
   * permission. `null` when no structure is detected or inputs are insufficient.
   */
  patternLibrary: PatternLibraryRead | null;
}

export interface BuildMarketIntelligenceOptions {
  /** Analysis mode — display-only. Defaults to a live chart read. */
  mode?: IntelligenceMode;
}

// ── pure mapping helpers (deterministic; no IO) ───────────────────────────────

function chartDirToBias(d: ChartDirection): DirectionBias {
  return d === "bullish"
    ? "bullish"
    : d === "bearish"
      ? "bearish"
      : d === "mixed"
        ? "mixed"
        : "neutral";
}

function chartDirToPatternBias(d: ChartDirection): PatternBias {
  return d === "bullish" ? "bullish" : d === "bearish" ? "bearish" : "neutral";
}

function candleDirToBias(d: "up" | "down" | "flat" | "unknown"): DirectionBias {
  return d === "up" ? "bullish" : d === "down" ? "bearish" : "neutral";
}

function pressureToBias(p: OrderFlowPressure): DirectionBias {
  return p === "buying"
    ? "bullish"
    : p === "selling"
      ? "bearish"
      : p === "mixed"
        ? "mixed"
        : "neutral";
}

function setupDirToEntry(d: "bullish" | "bearish" | "none" | "unknown"): EntryDirection {
  return d === "bullish" ? "buy" : d === "bearish" ? "sell" : "none";
}

/** Deterministic session from a CLOSED bar's UTC hour (NOT a wall-clock read). */
function sessionFromBarTime(iso: string | null, synthetic: boolean): TradingSession {
  if (synthetic) return "synthetic_continuous";
  if (!iso) return "synthetic_continuous";
  const h = new Date(iso).getUTCHours();
  if (!Number.isFinite(h)) return "synthetic_continuous";
  if (h >= 13 && h < 16) return "overlap";
  if (h >= 8 && h < 13) return "london";
  if (h >= 16 && h < 21) return "new_york";
  return "asia";
}

function volatilityState(atr: number | null, avgRange: number | null): TimingVolatilityState {
  if (atr == null || avgRange == null || avgRange <= 0) return "normal";
  const ratio = atr / avgRange;
  if (ratio < 0.8) return "low";
  if (ratio < 1.3) return "normal";
  if (ratio < 2) return "high";
  return "extreme";
}

function regimeToPhase(regime: string): MarketPhase {
  switch (regime) {
    case "trending":
      return "trend";
    case "ranging":
      return "range";
    case "volatile":
      return "expansion";
    case "quiet":
      return "compression";
    default:
      return "unknown";
  }
}

/** The prior CLOSED higher-timeframe period for classic pivots, or null. */
function htfPriorPeriod(htf: Candle[]): PivotPriorPeriod | null {
  // Classic pivots use the PRIOR period; the last HTF bar may be the current
  // (forming) period, so take the one before it. Null when there isn't enough.
  if (htf.length < 2) return null;
  const prior = htf[htf.length - 2];
  if (
    !prior ||
    !Number.isFinite(prior.high) ||
    !Number.isFinite(prior.low) ||
    !Number.isFinite(prior.close)
  ) {
    return null;
  }
  return { high: prior.high, low: prior.low, close: prior.close };
}

/**
 * Build the shared MarketIntelligenceSnapshot + StrategyVerdict from a
 * RubyChartContext. Returns `null` on an unsupported timeframe or any error —
 * the caller then leaves its base read completely untouched.
 */
export function buildMarketIntelligenceSnapshot(
  ctx: RubyChartContext,
  opts: BuildMarketIntelligenceOptions = {},
): MarketIntelligenceServiceResult | null {
  try {
    if (!isChartTimeframe(ctx.timeframe)) return null;
    const tf = ctx.timeframe as ChartTimeframe;
    const mode: IntelligenceMode = opts.mode ?? "live_read";

    const state = ctx.state;
    const stats = state.candleStats;
    const mu = state.marketUnderstanding;
    const trend = mu.trend;
    const levels = mu.levels;
    const fast = state.fastFlags;
    const setup = state.setupState;

    const lastClose = stats.lastClose;
    const atr = stats.atr;
    const avgRange = stats.avgRange;

    // ── Caller's ALREADY-DECIDED feed/sufficiency truth (never recomputed) ─────
    const feedConfirmed = ctx.basis === "VERIFIED";
    const feedStale = state.stale || ctx.liveDelayed;
    const sufficiencyAllowsSetup = ctx.sufficiency.canShowTradeSetup;
    const chartReadConfidenceLow = !ctx.confidentReadAllowed;
    const display = {
      feedConfirmed,
      feedStale,
      sufficiencyAllowsSetup,
      chartReadConfidenceLow,
    };

    const feed: IntelligenceFeedTruth = {
      feedConfirmed,
      feedStale,
      sufficiencyAllowsSetup,
      chartReadConfidenceLow,
      candleCount: ctx.closedBarsCount,
      minimumRequiredCandles: requiredClosedBarsForTimeframe(tf),
    };

    // ── Proximity / structure facts derived from the level engine ─────────────
    const nS = levels.nearestSupport;
    const nR = levels.nearestResistance;
    const NEAR_PCT = 0.25;
    const supportNear = nS?.distancePct != null && Math.abs(nS.distancePct) <= NEAR_PCT;
    const resistanceNear = nR?.distancePct != null && Math.abs(nR.distancePct) <= NEAR_PCT;
    const atKeyLevel =
      Boolean(supportNear) ||
      Boolean(resistanceNear) ||
      fast.nearRecentHigh ||
      fast.nearRecentLow;

    let distanceToSrAtr: number | null = null;
    if (lastClose != null && atr != null && atr > 0) {
      const dists: number[] = [];
      if (nS?.price != null) dists.push(Math.abs(lastClose - nS.price));
      if (nR?.price != null) dists.push(Math.abs(lastClose - nR.price));
      if (dists.length) distanceToSrAtr = Math.min(...dists) / atr;
    }

    const syntheticAsset = String(state.assetClass).toLowerCase().includes("synth");

    // ── Pattern & Trendline (reuse the existing pure producers) ───────────────
    const patternContext = {
      symbol: state.symbol,
      displaySymbol: state.displaySymbol,
      timeframe: tf,
      rawCandles: ctx.candles,
      feedConfirmed,
      feedStale,
      sufficiencyAllowsSetup,
      chartReadConfidenceLow,
      trend: chartDirToPatternBias(trend.direction),
      momentumAligned: fast.momentumBurst,
      nearSupportResistance: atKeyLevel,
      distanceToSrAtr,
      volatilityAtr: atr,
    };
    const pattern = buildPatternTruthVerdict(patternContext);
    const trendline = buildTrendlineTruthVerdict(patternContext);
    // Additive, display-only Pattern Library read (Task #654). Same real candles +
    // feed/sufficiency facts; fail-closed (null on no structure / bad input); never
    // a gate. The classifier already collapses to context-only off a non-live feed.
    const patternLibrary = buildPatternLibraryRead({
      symbol: state.symbol,
      displaySymbol: state.displaySymbol,
      timeframe: tf,
      rawCandles: ctx.candles,
      feedConfirmed,
      feedStale,
      sufficiencyAllowsSetup,
    });

    // ── Pivot Truth ───────────────────────────────────────────────────────────
    const prior = htfPriorPeriod(ctx.htfCandles);
    const pivotSourceTimeframe: PivotSourceTimeframe = ctx.htfCandles.length
      ? "daily"
      : "session";
    const pivot = resolvePivotTruth(
      {
        pivotSourceTimeframe,
        prior,
        precomputedLevels: prior ? computeClassicPivots(prior) : null,
        currentPrice: lastClose,
        atr,
        reaction: EMPTY_PIVOT_REACTION,
        exhaustionExtended: false,
      },
      display,
    );

    // ── Order Flow Truth (proxy only — honestly labelled by the contract) ─────
    const setupDirection = setupDirToEntry(setup.direction);
    const dp = mu.candleIntent.dominantPressure;
    const bodyMag = stats.body != null && Number.isFinite(stats.body) ? Math.abs(stats.body) : null;
    const bodyPressure =
      dp === "buyers"
        ? (bodyMag ?? 1)
        : dp === "sellers"
          ? -(bodyMag ?? 1)
          : dp === "balanced"
            ? 0
            : null;
    const proxyData: ProxyOrderFlowData = {
      bodyPressure,
      volumeSpike: false,
      momentumImpulse: stats.changeAbs,
      rejectionCandle: mu.candleIntent.latestIntent === "rejecting",
      liquiditySweep: { detected: false, side: null, reclaimed: false },
    };
    const orderFlow = resolveOrderFlowTruth(
      {
        setupDirection,
        trueData: null,
        proxyData,
        spreadCondition: "unknown",
        volumeCondition: "unknown",
        atKeyLevel,
      },
      display,
    );

    // ── Timing Truth (no fabricated news/spread/liquidity BLOCK) ──────────────
    const timing = resolveTimingTruth(
      {
        session: sessionFromBarTime(state.latestClosedCandle?.closeTime ?? null, syntheticAsset),
        candleState: (ctx.hasFormingCandle ? "forming" : "closed_confirmed") as CandleState,
        volatilityState: volatilityState(atr, avgRange),
        marketPhase: regimeToPhase(trend.regime),
        signalAge: setup.ageBars,
        maxSignalAge: setup.expiresInBars,
        distanceFromTriggerAtr: null,
        newsImminent: false,
        spreadWide: false,
        lowLiquidity: false,
        cooldownActive: false,
        intrabarScalpAllowed: false,
        retestRequired: false,
      },
      display,
    );

    // ── Direction Truth ───────────────────────────────────────────────────────
    const ltfDirection = trend.populated
      ? chartDirToBias(trend.direction)
      : candleDirToBias(stats.direction);
    const direction = resolveDirectionTruth(
      {
        htfDirection: chartDirToBias(trend.higherTimeframeBias),
        ltfDirection,
        trendlineBias: "neutral",
        pivotBias: pivot.pivotBias,
        patternBias: "neutral",
        patternForming: false,
        orderFlowBias: pressureToBias(orderFlow.pressure),
        midRange: !atKeyLevel,
        atMajorLevel: atKeyLevel,
        newsRisk: false,
        volatilityExtreme: timing.volatilityState === "extreme",
        invalidationLevel: setup.invalidationPrice,
      },
      display,
    );

    // ── Entry Truth ───────────────────────────────────────────────────────────
    const hasSetup = setup.hasActiveSetup && setupDirection !== "none";
    const entryType: EntryType = hasSetup ? "continuation" : "none";
    const targetLevels: number[] = [];
    if (hasSetup) {
      const t = setupDirection === "buy" ? nR?.price : nS?.price;
      if (t != null && Number.isFinite(t)) targetLevels.push(t);
    }
    const entry = resolveEntryTruth(
      {
        entryType,
        direction: hasSetup ? setupDirection : "none",
        proposedEntryPrice: hasSetup ? lastClose : null,
        entryZone: null,
        confirmationTrigger: null,
        invalidationTrigger: setup.invalidationPrice,
        stopLossLevel: setup.invalidationPrice,
        targetLevels,
        closedBeyondTrigger: false,
        wickOnlyBeyondTrigger: false,
        levelFailed: setup.stage === "invalid",
        triggerDistanceAtr: null,
        alreadyMoved: false,
        minimumRR: null,
      },
      { ...display, timingApproved: timing.timingApproved },
    );

    // ── Risk context (derived from the entry verdict's own RR read) ───────────
    const risk: IntelligenceRiskContext = {
      rrAcceptable: entry.currentRR != null && entry.currentRR >= entry.minimumRR,
      currentRR: entry.currentRR,
      minimumRR: entry.minimumRR,
      targetRoom: entry.entryStatus === "not_available" ? "unknown" : entry.targetRoomStatus,
    };

    const snapshot = composeMarketIntelligenceSnapshot({
      symbol: state.symbol,
      timeframe: tf,
      asOf: state.latestClosedCandle?.closeTime ?? null,
      mode,
      feed,
      direction,
      pivot,
      entry,
      orderFlow,
      timing,
      pattern,
      trendline,
      risk,
      reliability: {
        backtestWinRate: null,
        forwardWinRate: null,
        backtestSamples: null,
        forwardSamples: null,
      },
    });
    const verdict = deriveStrategyVerdict(snapshot);
    return { snapshot, verdict, patternLibrary };
  } catch {
    return null;
  }
}
