// Selected-market analysis assembler.
//
// Pure data-shaping over existing read-only modules:
//   - analyzeMarketFromCandles() (lib/aiBrain.ts)           — bias, SR, SL/TP
//     run over REAL canonical-feed candles (NEVER the simulator)
//   - getChartCandles()      (lib/data/chart/chartDataService.ts) — the SAME
//     pipeline the chart bars and the truth brain read
//   - evaluateLevelStaleness (@workspace/domain/truth)      — Task #512 guard
//   - scoreNewsRisk()        (lib/news/calendar/newsRiskScorer.ts)
//   - economic_events table  (@workspace/db)                — upcoming events
//
// Output is user-facing trading language. Never returns secrets. Never
// dispatches anything. The function is idempotent and cheap to call. The
// simulator is unreachable from this envelope — Task #518.

import { and, gte, lte } from "drizzle-orm";
import { db, economicEventsTable } from "@workspace/db";
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
  timeframeMs,
  type ChartTimeframe,
} from "../data/chart/timeframes.js";
import {
  evaluateMarketDataSufficiency,
  type MarketDataSufficiencyVerdict,
} from "@workspace/domain/market";
import { newsRiskUnavailable, scoreNewsRisk } from "../news/calendar/newsRiskScorer.js";
import { isSyntheticSymbol as isSyntheticCalendarSymbol } from "../news/calendar/calendarSymbolMap.js";
import { isCalendarProviderEnabled } from "../news/economicCalendarProvider.js";
import { SYNTHETIC_EVENT_RISK_LABEL } from "@workspace/domain/truth";
import type { EconomicEvent } from "../news/calendar/economicEvents.js";
import { isSupported, normalizeSymbol, resolveCanonicalSymbol } from "../instruments/index.js";
import { getCache } from "../cache/cacheAdapter.js";
import { readStoredCalendarCoverage } from "../../routes/newsCalendar.js";

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

// The bias / trend / confidence read is measured over the SAME window the
// scanner row uses: the newest 30 CLOSED bars (marketScanner.ts
// SCAN_ANALYSIS_WINDOW, fed by prepareScannerCandles which drops forming bars).
// Measuring over all 200 bars, or including the still-forming bar, let this
// panel show BUY while the Results card and Opportunity Map showed SELL for the
// same symbol and timeframe. A drift guard test pins the two constants together.
export const SELECTED_ANALYSIS_WINDOW = 30;

// Clock-skew allowance for a closed bar's close time. A closed bar cannot close
// in the future; beyond this allowance its time is not an observation.
const DATA_AS_OF_SKEW_MS = 5_000;

/**
 * The observation time of the analysis data: the newest CLOSED bar's close
 * time. Never the forming bar's scheduled close (which lies in the future and
 * read as "Data as of 0s ago"), and never a time later than now.
 */
function closedBarDataAsOf(closed: NormalizedChartCandle[], nowMs: number): string | null {
  const last = closed[closed.length - 1];
  if (!last) return null;
  const closeMs = Date.parse(last.closeTime);
  if (!Number.isFinite(closeMs) || closeMs > nowMs + DATA_AS_OF_SKEW_MS) return null;
  return new Date(closeMs).toISOString();
}

/** Fully closed provider bars only. A forming bar is never an analysis input. */
function closedBars(candles: NormalizedChartCandle[]): NormalizedChartCandle[] {
  return candles.filter((c) => c.isComplete === true && c.isForming !== true);
}

// Injectable SOURCE deps so the builder is unit-testable with crafted candle /
// feed inputs (mirrors the truth brain's dependency-injection pattern). The real
// dependency is the canonical chart pipeline.
export interface SelectedMarketDeps {
  getChartCandlesFn: typeof getChartCandles;
  // The upcoming-economic-events loader. The real implementation reads the
  // `economic_events` table; tests inject an honest-empty (or crafted) loader so
  // the builder is exercised without a live DB round-trip.
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
  /**
   * Measured volatility: the newest 14-bar ATR against the mean true range of
   * the older closed bars. "Unmeasured" when there are too few closed bars to
   * compare; "Choppy" when the read itself is choppy.
   */
  volatilityLabel: "Calm" | "Normal" | "Elevated" | "Choppy" | "Unmeasured";
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
    /**
     * True only when the stored calendar reaches the end of the 24 h window
     * (the shared readStoredCalendarCoverage rule), or scheduled events do not
     * apply (synthetic). false means the calendar was NOT fully checked: an
     * empty or short event list is then not a confirmed quiet day.
     */
    calendarChecked: boolean;
    /** Plain-English limit of the event list (not checked / synthetic / unmapped), or null. */
    calendarNote: string | null;
  };
  /**
   * Honest data source for THIS envelope. Always the real market-data pipeline
   * ("LIVE_FEED") — the selected-market builder NEVER analyzes simulator
   * candles. Widened from the legacy "SIMULATOR" literal; this path never emits
   * SIMULATOR (Task #518).
   */
  dataSource: AnalysisDataSource;
  /** Clean-English source label (e.g. "MT5 broker feed"); null when unknown. */
  dataSourceLabel: string | null;
  /** Honest freshness state derived from the feed status. */
  dataState: TruthDataState;
  /**
   * The DATA timestamp: the newest CLOSED bar's close time, NOT the build time
   * and never a forming bar's scheduled future close. null when unknown.
   */
  dataAsOf: string | null;
  /**
   * The latest instant the LIVE_CONFIRMED claim holds without a new read: the
   * interval boundary at which the feed's newest bar would trail by two bars
   * (no longer live). Equal to generatedAt when the gap is unknown, null when
   * the envelope is not LIVE_CONFIRMED. A cached envelope is never served as
   * live past it.
   */
  liveClaimExpiresAt: string | null;
  /** True when saved geometry drifted too far from price and was withheld. */
  levelsWithheld: boolean;
  /** The guard's reason sentence when levels are withheld, else null. */
  levelsWithheldReason: string | null;
  /**
   * Why NO directional read (bias, confidence, trend, levels) is shown, or null
   * when one is. Set whenever the feed is not LIVE_CONFIRMED or the shared
   * data-sufficiency verdict (the scanner row's) withholds direction.
   */
  readWithheldReason: string | null;
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

// Recent-vs-baseline volatility. The label used to map the analysis riskScore,
// which (with no spread observed here) is a constant 20 — so every non-choppy
// market read "Calm" whatever its ranges were. It now MEASURES the bars.
const VOL_RECENT_BARS = 14;
const VOL_MIN_BASELINE_BARS = 14;
const VOL_ELEVATED_RATIO = 1.5;
const VOL_CALM_RATIO = 0.67;

function trueRanges(candles: NormalizedChartCandle[]): number[] {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    if (!c || !p) continue;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (Number.isFinite(tr)) trs.push(tr);
  }
  return trs;
}

function volatilityLabel(
  closed: NormalizedChartCandle[], bias: MarketAnalysis["marketBias"],
): SelectedMarketHighlights["volatilityLabel"] {
  if (bias === "choppy") return "Choppy";
  const trs = trueRanges(closed);
  if (trs.length < VOL_RECENT_BARS + VOL_MIN_BASELINE_BARS) return "Unmeasured";
  const recent = trs.slice(-VOL_RECENT_BARS);
  const baseline = trs.slice(0, -VOL_RECENT_BARS);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const base = mean(baseline);
  if (!(base > 0)) return "Unmeasured";
  const ratio = mean(recent) / base;
  if (ratio >= VOL_ELEVATED_RATIO) return "Elevated";
  if (ratio <= VOL_CALM_RATIO) return "Calm";
  return "Normal";
}

function biasFromAction(a: MarketAnalysis["recommendedAction"]): SelectedMarketHighlights["bias"] {
  if (a === "BUY" || a === "SELL") return a;
  if (a === "WAIT") return "WAIT";
  return "NEUTRAL";
}

function impactDbToLower(level: string): "low" | "medium" | "high" {
  const v = String(level).toUpperCase();
  if (v === "HIGH" || v === "CRITICAL") return "high";
  if (v === "MEDIUM") return "medium";
  return "low";
}

function buildExplanation(
  a: MarketAnalysis, newsBlocking: boolean, newsReason: string,
  volatility: SelectedMarketHighlights["volatilityLabel"],
): SelectedMarketExplanation {
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
  if (volatility === "Elevated") whyItMattersBits.push("Recent bars are much wider than usual, so position sizing matters.");
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
  if (volatility === "Elevated") cautions.push("Size smaller than usual while volatility is elevated.");
  if (a.marketBias === "choppy") cautions.push("Market is choppy — wait for a clear direction.");
  return {
    hedge, why, whyItMatters, risk, invalidation, cautions,
    disclaimer: "Decision support only — confirm live readiness and risk before trading.",
  };
}

/** Non-directional copy for a withheld read: no side, no level, no "setup". */
function withheldExplanation(reason: string, newsReason: string): SelectedMarketExplanation {
  return {
    hedge: "No directional read right now.",
    why: reason,
    whyItMatters: "Direction, confidence and levels return once the feed is confirmed live with enough closed bars.",
    risk: "There is no actionable read until the feed is confirmed live.",
    invalidation: "Not available without a current read.",
    cautions: newsReason ? [newsReason] : [],
    disclaimer: "Decision support only — confirm live readiness and risk before trading.",
  };
}

/** Calendar check outcome for the selected symbol's event list. */
export interface SelectedMarketCalendarStatus {
  checked: boolean;
  note: string | null;
}

export const CALENDAR_NOT_CONFIGURED_NOTE =
  "No economic-calendar provider is configured, so scheduled events were not checked.";
export const CALENDAR_EMPTY_WINDOW_NOTE =
  "No economic-calendar events are stored for the next 24 hours. The calendar may not have been synced, so this is not a confirmed quiet day.";

/** Synthetic markets are not moved by scheduled economic events. */
export function isSyntheticEventSymbol(symbol: string): boolean {
  try {
    if (resolveCanonicalSymbol(symbol).assetClass === "synthetic") return true;
  } catch {
    // fall through to the calendar matcher
  }
  return isSyntheticCalendarSymbol(symbol);
}

interface EventRowLike {
  currency: string;
  affectedSymbols: unknown;
  source?: string | null;
}

/**
 * The stored calendar rows that may move `symbol`: a row whose currency is one
 * of the symbol's currencies, or that names the symbol explicitly. With no
 * currency mapping only explicitly tagged rows match (never every row), a
 * synthetic market matches none, and rows written by the mock provider are
 * never listed as real events.
 */
export function filterEventRowsForSymbol<R extends EventRowLike>(
  rows: R[], symbol: string, currencyHints: string[],
): R[] {
  if (isSyntheticEventSymbol(symbol)) return [];
  return rows.filter((r) => {
    if (r.source === "mock") return false;
    if (currencyHints.includes(r.currency)) return true;
    const affected = r.affectedSymbols;
    return Array.isArray(affected) && affected.some((s) => typeof s === "string" && s.toUpperCase() === symbol);
  });
}

async function loadEventRows(symbol: string, currencyHints: string[]): Promise<{
  events: SelectedMarketEvent[];
  scorerInput: EconomicEvent[];
  calendar?: SelectedMarketCalendarStatus;
}> {
  if (isSyntheticEventSymbol(symbol)) {
    return { events: [], scorerInput: [], calendar: { checked: true, note: SYNTHETIC_EVENT_RISK_LABEL } };
  }
  if (!isCalendarProviderEnabled()) {
    return { events: [], scorerInput: [], calendar: { checked: false, note: CALENDAR_NOT_CONFIGURED_NOTE } };
  }
  const now = new Date();
  const until = new Date(now.getTime() + 24 * 3600 * 1000);
  const rows = await db.select().from(economicEventsTable)
    .where(and(
      gte(economicEventsTable.eventTime, now),
      lte(economicEventsTable.eventTime, until),
    ));
  const realRows = rows.filter((r) => r.source !== "mock");
  // The table is filled only by a manual sync. Rows inside the window do not
  // show that it reaches the window's end; the shared coverage rule does.
  const coverage = await readStoredCalendarCoverage(until);
  const calendar: SelectedMarketCalendarStatus = !coverage.windowCovered
    ? { checked: false, note: coverage.note ?? CALENDAR_EMPTY_WINDOW_NOTE }
    : {
      checked: true,
      note: currencyHints.length === 0
        ? `No currency mapping for ${symbol}, so only calendar events tagged to ${symbol} are listed.`
        : null,
    };
  const matching = filterEventRowsForSymbol(realRows, symbol, currencyHints);
  const sorted = matching
    .filter((r) => ["MEDIUM", "HIGH", "CRITICAL"].includes(String(r.impactLevel)))
    .sort((a, b) => +new Date(a.eventTime) - +new Date(b.eventTime));
  const events: SelectedMarketEvent[] = sorted.slice(0, 8).map((r) => ({
    externalId: r.externalId,
    title: r.eventName,
    currency: r.currency,
    impactLevel: r.impactLevel as SelectedMarketEvent["impactLevel"],
    eventTime: new Date(r.eventTime).toISOString(),
    minutesUntil: Math.round((+new Date(r.eventTime) - Date.now()) / 60000),
  }));
  // The scorer reasons over exactly the events listed for this symbol, so the
  // risk line and the list can never disagree about which events apply.
  const scorerInput: EconomicEvent[] = sorted.map((r) => ({
    id: r.externalId,
    title: r.eventName,
    country: r.country,
    currency: r.currency,
    impact: impactDbToLower(String(r.impactLevel)),
    actual: r.actual ?? null,
    forecast: r.forecast ?? null,
    previous: r.previous ?? null,
    eventTime: new Date(r.eventTime).toISOString(),
    affectedMarkets: [...((r.affectedSymbols ?? []) as unknown as string[]), symbol],
    source: r.source ?? "db",
  }));
  return { events, scorerInput, calendar };
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
  // Source identity only — liveness is the data state's job (a stored mirror
  // or stale series is still "mt5_broker").
  if (s.startsWith("mt5_broker")) return "MT5 broker feed";
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
  const window = trueRanges(candles).slice(-period);
  if (window.length === 0) return null;
  return window.reduce((a, b) => a + b, 0) / window.length;
}

/** The shared freshness scale the scanner row feeds the sufficiency verdict. */
function freshnessVerdictFor(state: TruthDataState): "LIVE" | "LIVE_DELAYED" | "AWAITING" {
  if (state === "LIVE_CONFIRMED") return "LIVE";
  if (state === "STALE") return "LIVE_DELAYED";
  return "AWAITING";
}

/**
 * Why the directional read is withheld, or null when it may be shown. Only a
 * LIVE_CONFIRMED feed that also passes the scanner's shared sufficiency verdict
 * may show a bias, confidence, trend or levels.
 */
function readWithheldReasonFor(state: TruthDataState, sufficiency: MarketDataSufficiencyVerdict): string | null {
  if (state === "STALE") {
    return "The market data feed is stale: its newest bars are not current, so no direction, confidence or levels are shown.";
  }
  if (state === "SYNCING") {
    return "The market data feed is not confirmed live yet (it is still syncing), so no direction, confidence or levels are shown.";
  }
  if (state !== "LIVE_CONFIRMED") {
    return "No confirmed market data feed, so no direction, confidence or levels are shown.";
  }
  return sufficiency.mayShowBias ? null : sufficiency.humanReason;
}

/**
 * The latest instant a LIVE_CONFIRMED read stays live without a new read.
 * The feed is live only while its newest bar trails the current bar by at
 * most one interval; the gap can only grow at an interval boundary, by one per
 * boundary. With gap g (0 or 1) at build time, the gap reaches 2 at the
 * (2 − g)-th boundary after the build. Unknown or out-of-range gap → no live
 * window (the build time itself). null when the read is not LIVE_CONFIRMED.
 */
function liveClaimExpiry(
  state: TruthDataState, fs: ChartFeedStatus | null, timeframe: ChartTimeframe, builtAtMs: number,
): string | null {
  if (state !== "LIVE_CONFIRMED") return null;
  const gap = fs?.trailingIntervals;
  const iv = timeframeMs(timeframe);
  if (typeof gap !== "number" || !Number.isFinite(gap) || gap < 0 || gap > 1 || !(iv > 0)) {
    return new Date(builtAtMs).toISOString();
  }
  const nextBoundary = Math.floor(builtAtMs / iv) * iv + iv;
  return new Date(nextBoundary + (1 - gap) * iv).toISOString();
}

function liveClaimLapsed(env: SelectedMarketEnvelope, nowMs: number): boolean {
  if (!env.ok || env.dataState !== "LIVE_CONFIRMED") return false;
  const until = env.liveClaimExpiresAt == null ? NaN : Date.parse(env.liveClaimExpiresAt);
  return !Number.isFinite(until) || nowMs >= until;
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
    // A cached LIVE_CONFIRMED envelope whose live window has lapsed is not
    // served: the feed may have stopped being live since it was built.
    if (hit.hit && !liveClaimLapsed(hit.value, Date.now())) {
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
  // One clock reading for the build: the live window is measured from it.
  const builtAtMs = Date.now();
  const fs = chart.feedStatus;
  const dataSourceLabel = sourceLabelFor(fs?.source ?? null);
  // Closed-bar rule (same as the scanner row): the analysis window is the newest
  // SELECTED_ANALYSIS_WINDOW closed bars; the forming bar never moves the read.
  const closed = closedBars(chart.candles);
  // Freshness honesty rides on dataState / dataAsOf — NEVER on a faked source.
  // dataAsOf is the newest closed bar's close time, not feedStatus.lastCandleTime:
  // the latter is the newest provider bar's closeTime, which for a forming bar
  // is a scheduled FUTURE instant, not an observation.
  const dataAsOf = closedBarDataAsOf(closed, Date.now());
  const analysisBars = closed.slice(-SELECTED_ANALYSIS_WINDOW);
  const analysisCandles: AnalysisCandle[] = analysisBars.map((c) => ({
    o: c.open, h: c.high, l: c.low, c: c.close,
  }));
  // The analysis prices off the newest CLOSED close (no bound quote here, the
  // scanner does the same). The stale-level guard below still compares levels
  // with the newest observed price, which may be the forming bar's close.
  const quote: AnalysisQuote = { mid: newestClose(analysisBars) ?? 0, spread: 0 };
  const price = newestClose(chart.candles);
  const feedProvider = fs?.source ?? undefined;
  const a = analyzeMarketFromCandles(
    symbol, timeframe, analysisCandles, quote, "LIVE_FEED", feedProvider,
  );

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
        volatilityLabel: "Unmeasured",
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
      upcomingEvents: [],
      newsRisk: {
        riskLevel: "none", blockTrading: false, summary: "",
        calendarChecked: false,
        calendarNote: "Scheduled events are not checked until market data is available for this market.",
      },
      dataSource: a.dataSource,
      dataSourceLabel,
      dataState: "UNAVAILABLE",
      dataAsOf,
      liveClaimExpiresAt: null,
      levelsWithheld: true,
      levelsWithheldReason: null,
      readWithheldReason: "No closed candles from the market data feed yet, so there is no read to show.",
      generatedAt: new Date().toISOString(),
      cacheHit: false,
    };
    return waiting;
  }

  // Stale-level guard (Task #512 pure domain guard): withhold geometry that has
  // drifted too far from the CURRENT real price — never show stale entries/stops.
  const atr = computeAtr(closed, 14);
  const levelInput: TruthLevelInput = {
    entryFrom: a.entryZone.low,
    entryTo: a.entryZone.high,
    stopLoss: a.stopLoss,
    invalidation: a.stopLoss,
    takeProfit: [a.takeProfit],
  };
  const staleness = evaluateLevelStaleness({ price, levels: levelInput, atr });
  const dataState = deriveDataState(fs);
  // ONE data-sufficiency truth: the SAME shared verdict the scanner row applies.
  // A stale or syncing feed, or too few closed bars, withholds every directional
  // field — never a BUY / High confidence / levels read on data that is not current.
  const sufficiency = evaluateMarketDataSufficiency({
    symbol,
    timeframe,
    freshnessVerdict: freshnessVerdictFor(dataState),
    availableClosedCandles: closed.length,
  });
  const readWithheldReason = readWithheldReasonFor(dataState, sufficiency);
  const readShown = readWithheldReason === null;
  const levelsShown = readShown && !staleness.stale;

  const hints = currencyHintsFor(symbol);
  const loaded = await deps.loadEventsFn(symbol, hints);
  // A loader that does not state the calendar's status has not checked it.
  const calendar: SelectedMarketCalendarStatus = loaded.calendar
    ?? { checked: false, note: "The economic calendar's status is unknown, so scheduled events could not be confirmed." };
  const synthetic = isSyntheticEventSymbol(symbol);
  const events = synthetic ? [] : loaded.events;
  const news = synthetic
    ? { ...scoreNewsRisk(symbol, []), reason: SYNTHETIC_EVENT_RISK_LABEL, riskLevel: "none" as const, blockTrading: false }
    : calendar.checked
      ? scoreNewsRisk(symbol, loaded.scorerInput)
      : newsRiskUnavailable(symbol, calendar.note ?? CALENDAR_NOT_CONFIGURED_NOTE);
  const volatility = volatilityLabel(closed, a.marketBias);
  const highlights: SelectedMarketHighlights = {
    bias: readShown ? biasFromAction(a.recommendedAction) : "WAIT",
    confidenceLabel: readShown ? confidenceLabel(a.confidenceScore) : "Very Low",
    confidenceScore: readShown ? Math.round(a.confidenceScore) : 0,
    volatilityLabel: volatility,
    trendState: readShown ? a.marketBias : "neutral",
    entryZone: levelsShown ? a.entryZone : null,
    suggestedStop: levelsShown ? a.stopLoss : null,
    suggestedTakeProfit: levelsShown ? a.takeProfit : null,
    riskRewardRatio: levelsShown ? a.riskRewardRatio : 0,
    riskWarnings: news.blockTrading ? [news.reason] : [],
  };
  const explanation = readWithheldReason === null
    ? buildExplanation(a, news.blockTrading, news.reason, volatility)
    : withheldExplanation(readWithheldReason, news.reason);
  const result: SelectedMarketResult = {
    ok: true,
    symbolRaw,
    symbol,
    timeframe,
    highlights,
    explanation,
    upcomingEvents: events,
    newsRisk: {
      riskLevel: news.riskLevel, blockTrading: news.blockTrading, summary: news.reason,
      calendarChecked: synthetic || calendar.checked,
      calendarNote: synthetic ? SYNTHETIC_EVENT_RISK_LABEL : calendar.note,
    },
    dataSource: a.dataSource,
    dataSourceLabel,
    dataState,
    dataAsOf,
    liveClaimExpiresAt: liveClaimExpiry(dataState, fs, timeframe, builtAtMs),
    levelsWithheld: !levelsShown,
    levelsWithheldReason: !readShown ? readWithheldReason : staleness.stale ? staleness.reason : null,
    readWithheldReason,
    generatedAt: new Date(builtAtMs).toISOString(),
    cacheHit: false,
  };
  return result;
}
