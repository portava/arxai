// Selected-market analysis assembler.
//
// Pure data-shaping over existing read-only modules:
//   - analyzeMarketFromCandles() (lib/aiBrain.ts)           — bias, SR, SL/TP
//     run over REAL canonical-feed candles (NEVER the simulator)
//   - getChartCandles()      (lib/data/chart/chartDataService.ts) — the SAME
//     pipeline the chart bars and the truth brain read
//   - evaluateLevelStaleness (@workspace/domain/truth)      — Task #512 guard
//   - scoreNewsRisk()        (lib/news/calendar/newsRiskScorer.ts)
//   - resolveNewsRiskEvents()                              — calendar availability
//
// Output is user-facing trading language. Never returns secrets. Never
// dispatches anything. The function is idempotent and cheap to call. The
// simulator is unreachable from this envelope — Task #518.

import {
  analyzeMarketFromCandles,
  type MarketAnalysis,
  type AnalysisCandle,
  type AnalysisQuote,
  type AnalysisDataSource,
} from "../aiBrain.js";
import {
  evaluateLevelStaleness,
  type TruthDataState,
  type TruthLevelInput,
} from "@workspace/domain/truth";
import {
  getChartCandles,
  type ChartFeedStatus,
} from "../data/chart/chartDataService.js";
import type { NormalizedChartCandle } from "../data/chart/candleNormalization.js";
import {
  isChartTimeframe,
  type ChartTimeframe,
} from "../data/chart/timeframes.js";
import { newsRiskUnavailable, scoreNewsRisk } from "../news/calendar/newsRiskScorer.js";
import { resolveNewsRiskEvents } from "../news/calendar/newsRiskResolver.js";
import type { EconomicEvent } from "../news/calendar/economicEvents.js";
import { isSupported, normalizeSymbol, resolveCanonicalSymbol } from "../instruments/index.js";
import { getCache } from "../cache/cacheAdapter.js";

// Namespace + TTL are intentionally hard-coded so the cache shape stays
// predictable even after a Redis adapter is swapped in.
const SELECTED_MARKET_CACHE_NS = "scanner-selected-market";
const SELECTED_MARKET_CACHE_TTL_MS = 30_000;
export const SELECTED_MARKET_CACHE_META = {
  namespace: SELECTED_MARKET_CACHE_NS,
  ttlMs: SELECTED_MARKET_CACHE_TTL_MS,
} as const;

// How many real candles to pull for analysis (mirrors the truth brain).
const CANDLE_LIMIT = 200;

// Injectable SOURCE deps so the builder is unit-testable with crafted candle /
// feed inputs (mirrors the truth brain's dependency-injection pattern). The real
// dependency is the canonical chart pipeline.
export interface SelectedMarketDeps {
  getChartCandlesFn: typeof getChartCandles;
  // Existing real calendar authority; tests inject explicit availability and
  // crafted events so no provider or database is contacted.
  loadEventsFn: typeof loadEventRows;
}
const REAL_DEPS: SelectedMarketDeps = {
  getChartCandlesFn: getChartCandles,
  loadEventsFn: loadEventRows,
};

export interface SelectedMarketHighlights {
  bias: "BUY" | "SELL" | "NEUTRAL" | "WAIT";
  confidenceLabel: "Very Low" | "Low" | "Medium" | "High";
  confidenceScore: number;
  volatilityLabel: "Calm" | "Normal" | "Elevated" | "Choppy";
  trendState: "bullish" | "bearish" | "neutral" | "choppy";
  // Level geometry is NULL when withheld by the stale-level guard or when there
  // is no live data — never zeros styled as levels (Task #518).
  entryZone: { low: number; high: number } | null;
  suggestedStop: number | null;
  suggestedTakeProfit: number | null;
  riskRewardRatio: number;
  riskWarnings: string[];
}

export interface SelectedMarketEvent {
  externalId: string;
  title: string;
  currency: string;
  impactLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  eventTime: string;
  minutesUntil: number;
}

export interface SelectedMarketExplanation {
  hedge: string;
  why: string;
  whyItMatters: string;
  risk: string;
  invalidation: string;
  cautions: string[];
  disclaimer: string;
}

export interface SelectedMarketResult {
  ok: true;
  symbolRaw: string;
  symbol: string;
  timeframe: string;
  highlights: SelectedMarketHighlights;
  explanation: SelectedMarketExplanation;
  upcomingEvents: SelectedMarketEvent[];
  newsRisk: {
    riskLevel: "none" | "low" | "medium" | "high";
    blockTrading: boolean;
    summary: string;
    calendarAvailable: boolean;
    applicability: "applicable" | "not_applicable";
  };
  /**
   * Honest data source for THIS envelope. Always the real market-data pipeline
   * ("LIVE_FEED") — the selected-market builder NEVER analyzes simulator
   * candles. Widened from the legacy "SIMULATOR" literal; this path never emits
   * SIMULATOR (Task #518).
   */
  dataSource: AnalysisDataSource;
  /** Clean-English source label (e.g. "Live broker feed"); null when unknown. */
  dataSourceLabel: string | null;
  /** Honest freshness state derived from the feed status. */
  dataState: TruthDataState;
  /** The DATA timestamp (newest candle time from the feed), NOT the build time. */
  dataAsOf: string | null;
  /** True when saved geometry drifted too far from price and was withheld. */
  levelsWithheld: boolean;
  /** The guard's reason sentence when levels are withheld, else null. */
  levelsWithheldReason: string | null;
  generatedAt: string;
  cacheHit: boolean;
}

export interface SelectedMarketUnavailable {
  ok: false;
  symbolRaw: string;
  symbol: string;
  reason: "SYMBOL_NOT_SUPPORTED" | "NO_MARKET_DATA";
  message: string;
}

export type SelectedMarketEnvelope = SelectedMarketResult | SelectedMarketUnavailable;

// ── Cache (pluggable adapter, ~30s TTL, refresh bypasses) ─────────────────
// The adapter is selected by `ARX_CACHE_MODE` env at process start.
// Today this is always an in-process Map; a Redis-backed adapter can be
// dropped in without touching this file.
function cache() {
  return getCache(SELECTED_MARKET_CACHE_NS, SELECTED_MARKET_CACHE_TTL_MS);
}

// Pending work has no TTL: an unresolved build must not spawn another copy.
// A forced refresh may supersede one ordinary build, but never another forced
// build. Identity checks prevent superseded work from publishing older data.
const pendingBuilds = new Map<string, { forced: boolean; promise: Promise<SelectedMarketEnvelope> }>();
export function clearSelectedMarketCache(): void {
  cache().clear();
  pendingBuilds.clear();
}

function cacheKey(symbol: string, timeframe: string, viewerUserId?: number): string {
  if (viewerUserId !== undefined && (!Number.isSafeInteger(viewerUserId) || viewerUserId <= 0)) {
    throw new Error("Invalid selected-market viewer identity");
  }
  // Background/internal callers occupy a separate namespace. HTTP callers
  // always supply the authenticated user, never a query-string user id.
  return JSON.stringify([viewerUserId ?? "internal", symbol, timeframe]);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function confidenceLabel(score: number): SelectedMarketHighlights["confidenceLabel"] {
  if (score >= 75) return "High";
  if (score >= 50) return "Medium";
  if (score >= 25) return "Low";
  return "Very Low";
}

function volatilityLabel(riskScore: number, bias: MarketAnalysis["marketBias"]): SelectedMarketHighlights["volatilityLabel"] {
  if (bias === "choppy") return "Choppy";
  if (riskScore >= 70) return "Elevated";
  if (riskScore >= 40) return "Normal";
  return "Calm";
}

function biasFromAction(a: MarketAnalysis["recommendedAction"]): SelectedMarketHighlights["bias"] {
  if (a === "BUY" || a === "SELL") return a;
  if (a === "WAIT") return "WAIT";
  return "NEUTRAL";
}

function buildExplanation(a: MarketAnalysis, newsBlocking: boolean, newsReason: string): SelectedMarketExplanation {
  const side = biasFromAction(a.recommendedAction);
  const hedge = side === "BUY"
    ? "This looks like a possible buy setup right now."
    : side === "SELL"
    ? "This setup currently leans toward sellers."
    : side === "WAIT"
    ? "No clear directional edge — better to wait for confirmation."
    : "The market is neutral. Nothing actionable yet.";
  const whyParts: string[] = [];
  if (a.reasonForTrade && a.reasonForTrade !== "no data") whyParts.push(a.reasonForTrade);
  if (a.trendStrength > 0) whyParts.push(`trend strength ${Math.round(a.trendStrength)}/100`);
  const why = whyParts.join(" · ").slice(0, 240)
    || "Scanner detected a tradable structure on the current timeframe.";
  const whyItMattersBits: string[] = [];
  if (newsBlocking) {
    whyItMattersBits.push("A high-impact event is near — large moves are possible.");
  }
  if (a.riskScore >= 70) whyItMattersBits.push("Volatility is elevated, so position sizing matters.");
  if (a.confidenceScore < 50) whyItMattersBits.push("Confidence is not high — wait for confirmation before sizing up.");
  if (!whyItMattersBits.length) whyItMattersBits.push("Conditions look stable for the scanner's read.");
  const whyItMatters = whyItMattersBits.join(" ");
  const risk = a.reasonToAvoid && a.reasonToAvoid !== "n/a"
    ? a.reasonToAvoid.slice(0, 180)
    : a.stopLoss > 0
    ? `Idea weakens if price closes ${side === "SELL" ? "above" : "below"} ${a.stopLoss}.`
    : "Idea weakens if momentum stalls or structure breaks against the bias.";
  const invalidation = a.stopLoss > 0
    ? `Invalidates ${side === "SELL" ? "above" : "below"} ${a.stopLoss}.`
    : "Invalidates if price closes through the opposing structure.";
  const cautions: string[] = [];
  if (newsReason) cautions.push(newsReason);
  if (a.confidenceScore < 50) cautions.push("Confidence is low — confirm with price action.");
  if (a.riskScore >= 70) cautions.push("Size smaller than usual while volatility is elevated.");
  if (a.marketBias === "choppy") cautions.push("Market is choppy — wait for a clear direction.");
  return {
    hedge, why, whyItMatters, risk, invalidation, cautions,
    disclaimer: "Decision support only — confirm live readiness and risk before trading.",
  };
}

// Availability comes from the existing connected-calendar authority, not from
// a successful query of an empty/stale economic_events table.
async function loadEventRows(symbol: string, currencyHints: string[]): Promise<{
  events: SelectedMarketEvent[];
  scorerInput: EconomicEvent[];
  calendarAvailable?: boolean;
  reason?: string;
}> {
  const resolved = await resolveNewsRiskEvents({ daysAhead: 2 });
  if (!resolved.available) return { events: [], scorerInput: [], calendarAvailable: false, reason: resolved.reason };
  const now = Date.now();
  const until = now + 24 * 3600 * 1000;
  const sorted = resolved.events.filter((e) => {
    const time = Date.parse(e.eventTime);
    return time >= now && time <= until && e.impact !== "low"
      && (currencyHints.includes(e.currency) || e.affectedMarkets.includes(symbol));
  }).sort((a, b) => Date.parse(a.eventTime) - Date.parse(b.eventTime));
  return {
    calendarAvailable: true,
    reason: resolved.reason,
    scorerInput: sorted,
    events: sorted.slice(0, 8).map((e) => ({
      externalId: e.id, title: e.title, currency: e.currency,
      impactLevel: e.impact.toUpperCase() as SelectedMarketEvent["impactLevel"],
      eventTime: e.eventTime, minutesUntil: Math.round((Date.parse(e.eventTime) - now) / 60000),
    })),
  };
}

async function selectedNewsEvidence(symbol: string, deps: SelectedMarketDeps) {
  // Use the instrument authority for aliases as well as the scorer's long names.
  const synthetic = resolveCanonicalSymbol(symbol).assetClass === "synthetic";
  if (synthetic) return {
    events: [] as SelectedMarketEvent[],
    news: { ...newsRiskUnavailable(symbol, ""), calendarAvailable: true,
      reason: "Macro news is not applicable to this synthetic market." },
    applicability: "not_applicable" as const,
  };
  try {
    const loaded = await deps.loadEventsFn(symbol, currencyHintsFor(symbol));
    // Missing/legacy evidence is not a checked event set.
    const available = loaded.calendarAvailable === true;
    return {
      events: available ? loaded.events : [],
      news: available ? scoreNewsRisk(symbol, loaded.scorerInput)
        : newsRiskUnavailable(symbol, loaded.reason || "Economic calendar unavailable — news risk could not be verified."),
      applicability: "applicable" as const,
    };
  } catch {
    return { events: [] as SelectedMarketEvent[],
      news: newsRiskUnavailable(symbol, "Economic calendar unavailable — news risk could not be read."),
      applicability: "applicable" as const };
  }
}

function currencyHintsFor(symbol: string): string[] {
  if (/^[A-Z]{6}$/.test(symbol)) return [symbol.slice(0, 3), symbol.slice(3, 6)];
  if (symbol === "XAUUSD" || symbol === "XAGUSD") return ["USD"];
  if (symbol === "US30" || symbol === "NAS100" || symbol === "SPX500") return ["USD"];
  return [];
}

// ── Feed helpers (mirrored from the truth brain; the brain is NOT modified) ───
function sourceLabelFor(source: string | null): string | null {
  if (!source) return null;
  const s = source.toLowerCase();
  if (s.startsWith("mt5_broker")) return "Live broker feed";
  if (s.startsWith("deriv")) return "Deriv feed";
  return "Market data feed";
}

function deriveDataState(fs: ChartFeedStatus | null): TruthDataState {
  if (!fs || !fs.source) return "UNAVAILABLE";
  const q = fs.quality;
  if (q === "unavailable" || q === "empty" || q === "invalid") return "UNAVAILABLE";
  if (fs.stale || q === "stale") return "STALE";
  if (fs.isLive && q === "clean") return "LIVE_CONFIRMED";
  return "SYNCING";
}

function newestClose(candles: NormalizedChartCandle[]): number | null {
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    if (c && Number.isFinite(c.close)) return c.close;
  }
  return null;
}

function computeAtr(candles: NormalizedChartCandle[], period = 14): number | null {
  if (candles.length < 2) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    if (!c || !p) continue;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close),
    );
    if (Number.isFinite(tr)) trs.push(tr);
  }
  const window = trs.slice(-period);
  if (window.length === 0) return null;
  return window.reduce((a, b) => a + b, 0) / window.length;
}

// ── Public ────────────────────────────────────────────────────────────────
export async function getSelectedMarketSnapshot(args: {
  symbolRaw: string;
  timeframe?: string;
  refresh?: boolean;
  viewerUserId?: number;
}, depsOverride: Partial<SelectedMarketDeps> = {}): Promise<SelectedMarketEnvelope> {
  const deps: SelectedMarketDeps = { ...REAL_DEPS, ...depsOverride };
  const symbol = normalizeSymbol(args.symbolRaw);
  // Coerce to a real chart timeframe; an unknown token falls back to M15 (never
  // silently passed to the feed). The active timeframe is echoed back below.
  const tfRaw = args.timeframe ?? "M15";
  const timeframe: ChartTimeframe = isChartTimeframe(tfRaw) ? tfRaw : "M15";
  if (!symbol) {
    return {
      ok: false, symbolRaw: args.symbolRaw, symbol: "",
      reason: "SYMBOL_NOT_SUPPORTED",
      message: "Please enter a symbol like EURUSD, XAUUSD, US30, or BTCUSDT.",
    };
  }
  if (!isSupported(symbol)) {
    return {
      ok: false, symbolRaw: args.symbolRaw, symbol,
      reason: "SYMBOL_NOT_SUPPORTED",
      message: `${symbol} is not available in the scanner yet. Try a major pair, gold, an index, or a top crypto.`,
    };
  }
  const key = cacheKey(symbol, timeframe, args.viewerUserId);
  const inFlight = pendingBuilds.get(key);
  if (inFlight && (!args.refresh || inFlight.forced)) {
    return { ...await inFlight.promise, symbolRaw: args.symbolRaw };
  }
  if (!args.refresh) {
    const hit = cache().get<SelectedMarketEnvelope>(key);
    if (hit.hit) {
      const cached = hit.value;
      return cached.ok ? { ...cached, symbolRaw: args.symbolRaw, cacheHit: true } : { ...cached, symbolRaw: args.symbolRaw };
    }
  } else {
    // A failed explicit refresh cannot silently revive the previous envelope.
    cache().clear(key);
  }
  const build = { forced: Boolean(args.refresh), promise: null as unknown as Promise<SelectedMarketEnvelope> };
  build.promise = buildSelectedMarketSnapshot(args.symbolRaw, symbol, timeframe, deps).then((result) => {
    if (pendingBuilds.get(key) === build) cache().set(key, result);
    return result;
  }).finally(() => {
    if (pendingBuilds.get(key) === build) pendingBuilds.delete(key);
  });
  pendingBuilds.set(key, build);
  return build.promise;
}

async function buildSelectedMarketSnapshot(
  symbolRaw: string, symbol: string, timeframe: ChartTimeframe, deps: SelectedMarketDeps,
): Promise<SelectedMarketEnvelope> {
  // Pull REAL candles from the SAME canonical chart pipeline the chart bars and
  // the truth brain read. The simulator is never consulted from this envelope.
  const chart = await deps.getChartCandlesFn(symbol, timeframe, CANDLE_LIMIT, false);
  const fs = chart.feedStatus;
  const dataSourceLabel = sourceLabelFor(fs?.source ?? null);
  // Freshness honesty rides on dataState / dataAsOf — NEVER on a faked source.
  const dataAsOf = fs?.lastCandleTime ?? null;
  const analysisCandles: AnalysisCandle[] = chart.candles.map((c) => ({
    o: c.open, h: c.high, l: c.low, c: c.close,
  }));
  const price = newestClose(chart.candles);
  const quote: AnalysisQuote = { mid: price ?? 0, spread: 0 };
  const feedProvider = fs?.source ?? undefined;
  const a = analyzeMarketFromCandles(
    symbol, timeframe, analysisCandles, quote, "LIVE_FEED", feedProvider,
  );

  // Calendar evidence is independent of price availability. Keep valid event
  // reads even when the chart has no candles; a calendar failure cannot erase
  // otherwise valid price analysis.
  const { events, news, applicability } = await selectedNewsEvidence(symbol, deps);
  const newsRisk = { riskLevel: news.riskLevel, blockTrading: news.blockTrading,
    summary: news.reason, calendarAvailable: news.calendarAvailable, applicability };

  // No real candles → honest WAITING envelope (ok:true). Never a simulator
  // fallback and never a fabricated level.
  if (a.recommendedAction === "REJECT" && a.reasonForTrade === "no data") {
    const waiting: SelectedMarketResult = {
      ok: true,
      symbolRaw,
      symbol,
      timeframe,
      highlights: {
        bias: "WAIT",
        confidenceLabel: "Very Low",
        confidenceScore: 0,
        volatilityLabel: "Calm",
        trendState: "neutral",
        entryZone: null,
        suggestedStop: null,
        suggestedTakeProfit: null,
        riskRewardRatio: 0,
        riskWarnings: [],
      },
      explanation: {
        hedge: "No live data for this market yet.",
        why: a.reasonToAvoid || "Awaiting candles from the live market data feed.",
        whyItMatters: "Levels appear once a clean candle feed is confirmed.",
        risk: "There is no actionable read until the live feed is confirmed.",
        invalidation: "Not available without live candles.",
        cautions: [],
        disclaimer: "Decision support only — confirm live readiness and risk before trading.",
      },
      upcomingEvents: events,
      newsRisk,
      dataSource: a.dataSource,
      dataSourceLabel,
      dataState: "UNAVAILABLE",
      dataAsOf,
      levelsWithheld: true,
      levelsWithheldReason: null,
      generatedAt: new Date().toISOString(),
      cacheHit: false,
    };
    return waiting;
  }

  // Stale-level guard (Task #512 pure domain guard): withhold geometry that has
  // drifted too far from the CURRENT real price — never show stale entries/stops.
  const atr = computeAtr(chart.candles, 14);
  const levelInput: TruthLevelInput = {
    entryFrom: a.entryZone.low,
    entryTo: a.entryZone.high,
    stopLoss: a.stopLoss,
    invalidation: a.stopLoss,
    takeProfit: [a.takeProfit],
  };
  const staleness = evaluateLevelStaleness({ price, levels: levelInput, atr });
  const dataState = deriveDataState(fs);

  const highlights: SelectedMarketHighlights = {
    bias: biasFromAction(a.recommendedAction),
    confidenceLabel: confidenceLabel(a.confidenceScore),
    confidenceScore: Math.round(a.confidenceScore),
    volatilityLabel: volatilityLabel(a.riskScore, a.marketBias),
    trendState: a.marketBias,
    entryZone: staleness.stale ? null : a.entryZone,
    suggestedStop: staleness.stale ? null : a.stopLoss,
    suggestedTakeProfit: staleness.stale ? null : a.takeProfit,
    riskRewardRatio: a.riskRewardRatio,
    riskWarnings: news.blockTrading ? [news.reason] : [],
  };
  const explanation = buildExplanation(a, news.blockTrading, news.reason);
  const result: SelectedMarketResult = {
    ok: true,
    symbolRaw,
    symbol,
    timeframe,
    highlights,
    explanation,
    upcomingEvents: events,
    newsRisk,
    dataSource: a.dataSource,
    dataSourceLabel,
    dataState,
    dataAsOf,
    levelsWithheld: staleness.stale,
    levelsWithheldReason: staleness.stale ? staleness.reason : null,
    generatedAt: new Date().toISOString(),
    cacheHit: false,
  };
  return result;
}
