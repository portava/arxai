// Task #512 — One Truth, One Brain (the brain).
//
// Builds ONE per-symbol Truth Snapshot by COMPOSING the existing canonical
// resolvers — it never re-derives freshness, news, price, or a verdict on its
// own. Every scanner/chart/Ruby surface renders from this single object, so two
// widgets on the same page can never disagree about the same symbol.
//
// SOURCES (composed, never duplicated):
//   1. getChartCandles        → data state + price + data timestamps (chart feed)
//   2. buildMarketImpactRadar → news provider + events + high-impact window
//   3. buildRubyMarketEdgeForUser → scanner verdict + actionable level geometry
//   4. evaluateScalpForSymbol → scalp + flame component verdicts
//   5. computeTimingRead      → timing component verdict (persistSnapshot:false)
//
// HONESTY / SAFETY (read-side only — nothing here gates, slows, or places a
// trade; it touches no execution path, gate, bridge, attribution, or permission):
//   - Each SOURCE is composed via Promise.allSettled — a failing/blind source
//     becomes an absent component (present:false), NEVER a fabricated value and
//     NEVER a 500. Unknown stays unknown.
//   - Freshness is exposed as the underlying DATA timestamps (lastCandleAt /
//     lastTickAt); we never stamp read-time as data-time. The snapshot's own
//     `generatedAt` is the (cache-able) build time, kept separate.
//   - All user-facing strings are clean English built here; raw enum/rule
//     tokens are humanized and never leak to a surface.
//   - The verdict + stale-level guard are delegated to the PURE domain composer
//     so the logic is deterministic and unit-tested in isolation.

import {
  composeVerdict,
  type ComposedLevels,
  type ComposeVerdictInput,
  type TruthAlignment,
  type TruthBestAction,
  type TruthBias,
  type TruthComponentInput,
  type TruthDataState,
  type TruthInvalidation,
  type TruthStage,
} from "@workspace/domain/truth";
import type { RubyMarketEdgeSignal } from "@workspace/domain/signal-intelligence";
import { evaluateMarketDataSufficiency } from "@workspace/domain/market";
import type { MarketTimingRead } from "@workspace/domain/timing-brain";
import { createShortTtlCache } from "../perf/shortTtlCache.js";
import {
  getChartCandles,
  type ChartFeedStatus,
} from "../data/chart/chartDataService.js";
import type { NormalizedChartCandle } from "../data/chart/candleNormalization.js";
import {
  isChartTimeframe,
  type ChartTimeframe,
} from "../data/chart/timeframes.js";
import { buildMarketImpactRadar } from "../news/marketImpactRadar.js";
import { buildRubyMarketEdgeForUser } from "../signalIntelligence/signalIntelligenceService.js";
import { evaluateScalpForSymbol } from "../scalp/scalpService.js";
import type { ScalpResult } from "../scalp/scalpTypes.js";
import { computeTimingRead } from "../../brain/timing/marketTimingBrainService.js";

// ── Public snapshot shape ────────────────────────────────────────────────────

export interface TruthComponent {
  present: boolean;
  alignment: TruthAlignment;
  /** Clean-English one-liner, rendered verbatim by every surface. */
  label: string;
  /** ISO data-time of this component's read, or null. */
  asOf: string | null;
}

export interface TruthNewsEvent {
  id: string;
  title: string;
  /** Affected currency code (e.g. "USD") — passed through from the radar. */
  currency: string;
  /** Raw severity (for marker colour / toast decision; never rendered raw). */
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  /** Clean-English severity (e.g. "High impact"). */
  severityLabel: string;
  /** Event lifecycle state (drives the toast decision; never rendered raw). */
  state: "UPCOMING" | "IMMINENT" | "LIVE" | "RECENT";
  /** Fixed event time (ISO) — surfaces compute any countdown from this. */
  eventTimeIso: string;
  affectsSymbol: boolean;
}

export interface TruthNews {
  providerConnected: boolean;
  events: TruthNewsEvent[];
  /** Clean-English risk summary. */
  riskLabel: string;
  highImpactWindowActive: boolean;
  /** Single clean-English disclaimer when no calendar provider is connected. */
  disclaimer: string | null;
}

export interface TruthData {
  state: TruthDataState;
  /** Raw provider id — for logic/admin only, never rendered raw. */
  source: string | null;
  /** Clean-English provider label for display. */
  sourceLabel: string | null;
  /** Last confirmed price (close of newest closed bar), or null. */
  price: number | null;
  /** DATA timestamp of the newest candle, or null. */
  lastCandleAt: string | null;
  /** DATA timestamp of the newest tick, or null. */
  lastTickAt: string | null;
}

export interface TruthVerdict {
  stage: TruthStage;
  bias: TruthBias;
  headline: string;
  evidenceFor: string[];
  evidenceAgainst: string[];
  bestAction: TruthBestAction;
  bestActionText: string;
  invalidation: TruthInvalidation | null;
}

export interface SymbolTruthSnapshot {
  symbol: string;
  displaySymbol: string;
  timeframe: ChartTimeframe;
  /** Snapshot build time (read-time). NOT a data timestamp. */
  generatedAt: string;
  data: TruthData;
  news: TruthNews;
  components: {
    scanner: TruthComponent;
    flame: TruthComponent;
    timing: TruthComponent;
    scalp: TruthComponent;
  };
  levels: ComposedLevels;
  verdict: TruthVerdict;
}

// ── Injectable SOURCEs (real by default; tests inject deterministic stubs) ────

export interface TruthSnapshotDeps {
  getChartCandlesFn: typeof getChartCandles;
  buildNewsFn: typeof buildMarketImpactRadar;
  buildScannerFn: typeof buildRubyMarketEdgeForUser;
  evaluateScalpFn: typeof evaluateScalpForSymbol;
  computeTimingFn: typeof computeTimingRead;
}

const REAL_DEPS: TruthSnapshotDeps = {
  getChartCandlesFn: getChartCandles,
  buildNewsFn: buildMarketImpactRadar,
  buildScannerFn: buildRubyMarketEdgeForUser,
  evaluateScalpFn: evaluateScalpForSymbol,
  computeTimingFn: computeTimingRead,
};

const CANDLE_LIMIT = 200;
const ABSENT_COMPONENT: TruthComponent = {
  present: false,
  alignment: "UNKNOWN",
  label: "No clear read.",
  asOf: null,
};

// ── Clean-English helpers (never leak a raw enum token) ───────────────────────

/** "ENTRY_WINDOW_OPEN" → "Entry window open". Guarantees no UPPER_SNAKE leaks. */
function humanize(token: string): string {
  const lower = token.replace(/_/g, " ").toLowerCase().trim();
  if (lower.length === 0) return "";
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

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
  if (q === "unavailable" || q === "empty" || q === "invalid") {
    return "UNAVAILABLE";
  }
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

function computeAtr(
  candles: NormalizedChartCandle[],
  period = 14,
): number | null {
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

// ── Component normalizers ─────────────────────────────────────────────────────

const SIGNAL_BIAS_WORD: Record<string, string> = {
  BULLISH: "Bullish",
  BEARISH: "Bearish",
  RANGING: "Ranging",
  MIXED: "Mixed",
  UNCLEAR: "Unclear",
};

function scannerComponent(signal: RubyMarketEdgeSignal | null): TruthComponent {
  if (!signal || !signal.hasSufficientData) return { ...ABSENT_COMPONENT };
  let alignment: TruthAlignment;
  if (signal.direction === "BUY") alignment = "BULLISH";
  else if (signal.direction === "SELL") alignment = "BEARISH";
  else if (signal.bias === "BULLISH") alignment = "BULLISH";
  else if (signal.bias === "BEARISH") alignment = "BEARISH";
  else alignment = "NEUTRAL";
  const biasWord = SIGNAL_BIAS_WORD[signal.bias] ?? humanize(signal.bias);
  const stageWord = humanize(signal.lifecycleStage);
  return {
    present: true,
    alignment,
    label: `${biasWord} · ${stageWord}`,
    asOf: signal.generatedAt ?? null,
  };
}

function scalpAsOf(scalp: ScalpResult): string | null {
  const expires = Date.parse(scalp.expiresAt);
  if (!Number.isFinite(expires)) return null;
  return new Date(expires - scalp.validForSeconds * 1000).toISOString();
}

function flameComponent(scalp: ScalpResult | null): TruthComponent {
  if (!scalp || scalp.flame.blind) return { ...ABSENT_COMPONENT };
  const dir = scalp.flame.readDirection;
  let alignment: TruthAlignment;
  if (dir === "BUY") alignment = "BULLISH";
  else if (dir === "SELL") alignment = "BEARISH";
  else alignment = "NEUTRAL";
  const stageWord = humanize(scalp.flame.flameStage);
  return {
    present: scalp.flame.flameStage !== "NONE",
    alignment,
    label: stageWord.length > 0 ? stageWord : "No clear momentum.",
    asOf: scalpAsOf(scalp),
  };
}

function scalpComponent(scalp: ScalpResult | null): TruthComponent {
  if (!scalp || scalp.flame.blind || scalp.direction == null) {
    return { ...ABSENT_COMPONENT };
  }
  const alignment: TruthAlignment =
    scalp.direction === "BUY" ? "BULLISH" : "BEARISH";
  const dirWord = scalp.direction === "BUY" ? "long" : "short";
  return {
    present: true,
    alignment,
    label: `${humanize(scalp.status)} (${dirWord})`,
    asOf: scalpAsOf(scalp),
  };
}

function timingComponent(timing: MarketTimingRead | null): TruthComponent {
  if (!timing || timing.dataQuality.label === "unavailable") {
    return { ...ABSENT_COMPONENT };
  }
  let alignment: TruthAlignment;
  if (timing.pressureBias === "BUY") alignment = "BULLISH";
  else if (timing.pressureBias === "SELL") alignment = "BEARISH";
  else alignment = "NEUTRAL";
  return {
    present: true,
    alignment,
    label: `Grade ${timing.timingGrade} · ${humanize(timing.entryPermission)}`,
    asOf: timing.generatedAt ?? null,
  };
}

// ── News normalizer ───────────────────────────────────────────────────────────

const SEVERITY_LABEL: Record<string, string> = {
  CRITICAL: "Critical",
  HIGH: "High impact",
  MEDIUM: "Medium impact",
  LOW: "Low impact",
};

type RadarResult = Awaited<ReturnType<typeof buildMarketImpactRadar>>;

function buildNews(radar: RadarResult | null): TruthNews {
  if (!radar) {
    return {
      providerConnected: false,
      events: [],
      riskLabel: "Event risk is unavailable.",
      highImpactWindowActive: false,
      disclaimer:
        "No economic-calendar provider is connected, so no scheduled events are shown.",
    };
  }
  const { radar: r } = radar;
  const providerConnected = r.provider.connected;

  // Dedupe events by id (a single event must never show as two rows).
  const deduped = Array.from(
    new Map(r.events.map((e) => [e.id, e])).values(),
  );
  const events: TruthNewsEvent[] = deduped.map((e) => ({
    id: e.id,
    title: e.title,
    currency: e.currency,
    severity: e.severity,
    severityLabel: SEVERITY_LABEL[e.severity] ?? humanize(e.severity),
    state: e.state,
    eventTimeIso: e.eventTimeIso,
    affectsSymbol: e.affectsSymbol,
  }));

  let riskLabel: string;
  if (r.highImpactWindowActive) {
    riskLabel = "A high-impact event is in play.";
  } else if (r.topSeverity === "CRITICAL" || r.topSeverity === "HIGH") {
    riskLabel = "Elevated event risk ahead.";
  } else if (r.topSeverity === "MEDIUM") {
    riskLabel = "Moderate event risk ahead.";
  } else if (r.topSeverity === "LOW") {
    riskLabel = "Low event risk ahead.";
  } else {
    riskLabel = providerConnected
      ? "No scheduled events affect this symbol."
      : "No event calendar is connected.";
  }

  return {
    providerConnected,
    events,
    riskLabel,
    highImpactWindowActive: r.highImpactWindowActive,
    disclaimer: providerConnected
      ? null
      : "No economic-calendar provider is connected, so no scheduled events are shown.",
  };
}

// ── Settled extraction helper ─────────────────────────────────────────────────

function valueOrNull<T>(r: PromiseSettledResult<T>): T | null {
  return r.status === "fulfilled" ? r.value : null;
}

// ── The composer (uncached, deps-injectable) ──────────────────────────────────

export async function buildSymbolTruthSnapshot(
  symbolRaw: string,
  timeframeRaw: string,
  userId: number,
  depsOverride: Partial<TruthSnapshotDeps> = {},
): Promise<SymbolTruthSnapshot> {
  const deps: TruthSnapshotDeps = { ...REAL_DEPS, ...depsOverride };
  const symbol = symbolRaw.trim().toUpperCase();
  const timeframe: ChartTimeframe = isChartTimeframe(timeframeRaw)
    ? timeframeRaw
    : "M15";

  // Scalp is BOTH its own component AND an input the scanner edge build needs.
  // Evaluate it ONCE here and reuse it for the scanner so a single snapshot
  // build never runs evaluateScalpForSymbol twice. It runs in parallel with the
  // other independent SOURCEs; only the scanner build waits on it.
  const [chartR, newsR, scalpR, timingR] = await Promise.allSettled([
    deps.getChartCandlesFn(symbol, timeframe, CANDLE_LIMIT, false),
    deps.buildNewsFn(symbol),
    deps.evaluateScalpFn(userId, { symbol, mode: "ANY" }),
    deps.computeTimingFn({ symbol, timeframe, persistSnapshot: false }),
  ]);

  const chart = valueOrNull(chartR);
  const news = valueOrNull(newsR);
  const scalp = valueOrNull(scalpR);
  const timing = valueOrNull(timingR);

  // Compose the scanner edge reusing the scalp we already have, and skip the
  // advisory signalMemoryTable upsert on this read-side polled path (mirrors
  // the timing dep's persistSnapshot:false discipline).
  const [scannerR] = await Promise.allSettled([
    deps.buildScannerFn(
      userId,
      { symbol, timeframe },
      { skipPersist: true, scalp },
    ),
  ]);
  const scanner = valueOrNull(scannerR);

  // ── data block (single source of freshness + price) ────────────────────────
  const feedStatus = chart?.feedStatus ?? null;
  const candles = chart?.candles ?? [];
  const data: TruthData = {
    state: deriveDataState(feedStatus),
    source: feedStatus?.source ?? chart?.source ?? null,
    sourceLabel: sourceLabelFor(feedStatus?.source ?? chart?.source ?? null),
    price: newestClose(candles),
    lastCandleAt: feedStatus?.lastCandleTime ?? null,
    lastTickAt: feedStatus?.lastTickTime ?? null,
  };

  // ── components ──────────────────────────────────────────────────────────────
  const components = {
    scanner: scannerComponent(scanner),
    flame: flameComponent(scalp),
    timing: timingComponent(timing),
    scalp: scalpComponent(scalp),
  };

  // ── news ────────────────────────────────────────────────────────────────────
  const newsBlock = buildNews(news);

  // ── level geometry (from the scanner signal only) ──────────────────────────
  const hasScannerLevels = scanner != null && scanner.hasSufficientData;
  const levelInput = {
    entryFrom: hasScannerLevels ? (scanner!.entryZone?.from ?? null) : null,
    entryTo: hasScannerLevels ? (scanner!.entryZone?.to ?? null) : null,
    stopLoss: hasScannerLevels ? scanner!.stopLoss : null,
    invalidation: hasScannerLevels ? scanner!.invalidationPrice : null,
    takeProfit: hasScannerLevels
      ? scanner!.takeProfitZones.map((z) => (z.from + z.to) / 2)
      : [],
  };

  // ── READABILITY CONTRACT (display-only) ────────────────────────────────────
  // The composed verdict may present a directional bias/stage ONLY when the ONE
  // shared data-sufficiency contract says this symbol/timeframe has enough proven
  // data for a directional read (approved ARX market + live feed + the shared
  // minimum of closed bars). We DERIVE that verdict from the shared contract here
  // — rather than re-checking feed-state and bar-count locally — so the scanner,
  // Ruby, and chart surfaces can never drift from THIS snapshot's read. Component
  // engines (flame/scalp/timing) can compute a raw direction off very little
  // data, so we feed them to the PURE composer ONLY when the shared contract
  // allows a read; otherwise the composer sees no directional components and
  // returns an honest UNKNOWN bias/stage with the "not enough confirmed data"
  // headline. Display-only — composeVerdict already holds bestAction at
  // WAIT_FOR_DATA when the feed is not live, and nothing here gates, slows, or
  // places a trade; the live gates remain the sole execution authority.
  const sufficiency = evaluateMarketDataSufficiency({
    symbol,
    timeframe,
    freshnessVerdict: data.state === "LIVE_CONFIRMED" ? "LIVE" : "AWAITING",
    availableClosedCandles: candles.length,
  });
  const directionReadable = sufficiency.canShowTradeSetup;
  const verdictComponents = directionReadable
    ? [components.scanner, components.flame, components.timing, components.scalp]
    : [];

  // ── compose the one verdict (pure) ─────────────────────────────────────────
  // We ALWAYS feed the real level geometry so the composer's stale-level guard
  // runs as designed. Directional READABILITY is enforced separately: only the
  // sufficient-data components are voted (empty when !directionReadable ⇒ an
  // honest UNKNOWN bias/stage), and the actionable trade idea is withheld below.
  const composeInput: ComposeVerdictInput = {
    dataState: data.state,
    price: data.price,
    highImpactWindowActive: newsBlock.highImpactWindowActive,
    components: verdictComponents.map((c, i) => {
      const key = (["scanner", "flame", "timing", "scalp"] as const)[i];
      const input: TruthComponentInput = {
        key,
        present: c.present,
        alignment: c.alignment,
        label: c.label,
        asOf: c.asOf,
      };
      return input;
    }),
    levels: levelInput,
    atr: computeAtr(candles),
  };
  const composed = composeVerdict(composeInput);

  // ── READABILITY CONTRACT (display-only): withhold the trade idea ───────────
  // When the data behind THIS snapshot is not sufficient for a directional read,
  // we never present an actionable setup (entry/stop/target) or its invalidation
  // side — even when the geometry is not "stale". The composed bias/stage are
  // already UNKNOWN (no directional components were voted). If the composer also
  // withheld on staleness we keep that (more specific) reason; otherwise we state
  // the honest insufficiency reason. Display-only — nothing here gates, slows, or
  // places a trade; the live gates remain the sole execution authority.
  const levels: ComposedLevels = directionReadable
    ? composed.levels
    : {
        entryFrom: null,
        entryTo: null,
        stopLoss: null,
        invalidation: null,
        takeProfit: [],
        withheld: true,
        withheldReason:
          composed.levels.withheldReason ?? sufficiency.humanReason,
      };

  return {
    symbol,
    displaySymbol: chart?.displaySymbol ?? symbol,
    timeframe,
    generatedAt: new Date().toISOString(),
    data,
    news: newsBlock,
    components,
    levels,
    verdict: {
      stage: composed.stage,
      bias: composed.bias,
      headline: composed.headline,
      evidenceFor: composed.evidenceFor,
      evidenceAgainst: composed.evidenceAgainst,
      bestAction: composed.bestAction,
      bestActionText: composed.bestActionText,
      invalidation: directionReadable ? composed.invalidation : null,
    },
  };
}

// ── Cached wrapper (per-user keyed, short TTL) ────────────────────────────────

const snapshotCache = createShortTtlCache<SymbolTruthSnapshot>({
  ttlMs: 4500,
  maxEntries: 500,
});

/**
 * The ONE entry point every surface ultimately reads. Per-user keyed so user A
 * can never receive user B's snapshot; short-TTL single-flight collapses the
 * "many widgets ask for the same symbol at once" fan-out into one compute.
 */
export async function getSymbolTruthSnapshot(
  symbol: string,
  timeframe: string,
  userId: number,
): Promise<SymbolTruthSnapshot> {
  const tf: ChartTimeframe = isChartTimeframe(timeframe) ? timeframe : "M15";
  const key = `${userId}|${symbol.trim().toUpperCase()}|${tf}`;
  return snapshotCache.get(key, () =>
    buildSymbolTruthSnapshot(symbol, tf, userId),
  );
}

/** Test helper — drop all cached snapshots. */
export function __clearTruthSnapshotCache(): void {
  snapshotCache.clear();
}
