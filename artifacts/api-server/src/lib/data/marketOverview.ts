// ── data/marketOverview.ts ──────────────────────────────────────────────────
// Shared broad-market composer for Ruby (the assistant).
//
// PURPOSE
//   Ruby's broad market-intelligence surfaces (opportunities, per-symbol
//   snapshot, symbol-context, briefing) must read from the SAME truth layer the
//   chart uses, so what Ruby says about a market matches exactly what the chart
//   shows for that symbol at the same moment.
//
//   - Per-symbol picture  →  getChartCandles() (chartDataService) → the unified
//     marketDataRouter → truth engine → ChartFeedStatus. ONE resolver.
//   - Opportunity scoring →  scanSymbolTimeframe() (the SINGLE scoring path),
//     ranked by effectiveOpportunityScore().
//
// HONESTY INVARIANTS (advisory/read-only — never a 16-gate or live path):
//   - The per-symbol picture is NEVER gated on scanner or provider availability.
//     Only the "setups" section degrades when the scanner is idle, with an
//     honest "scanner idle since X" note.
//   - Core opportunity scan keeps ONLY confirmed-live rows
//     (dataStatus === "live"). Simulator / awaiting-feed / history-only rows can
//     never leak through as a tradeable setup.
//   - Never fabricate and never substitute simulator data — honest empty + a
//     stated cause taken from feed status only.
//   - News is gated on the provider's connected flag and is sanitized as DATA
//     before it can reach the assistant model.
//   - Keep the core symbol set SMALL and short-TTL cached — this runs in the
//     chat hot path.

import {
  getChartCandles,
  type ChartFeedStatus,
  type ChartQuality,
} from "./chart/chartDataService.js";
import type { ChartTimeframe } from "./chart/timeframes.js";
import { classifySymbol, type AssetClass } from "./marketDataRouter.js";
import {
  scanSymbolTimeframe,
  effectiveOpportunityScore,
  scannerStatus,
  type ScannerOpportunity,
} from "../marketScanner.js";
import { getMarketProvider, type NewsItem } from "../assistant/marketProvider.js";
import { sanitizeExternalText } from "../security/promptInjectionGuard.js";

// ── Per-symbol snapshot ─────────────────────────────────────────────────────

/** Honest freshness verdict derived from the shared feed status. */
export type SnapshotFreshness = "REALTIME" | "DELAYED" | "STALE" | "UNAVAILABLE";

export interface SymbolSnapshot {
  symbol: string;
  displaySymbol: string;
  assetClass: AssetClass;
  /** Resolved provider/source from the shared router, or null when unavailable. */
  source: string | null;
  /** Shared chart-truth quality verdict (same value the chart shows). */
  quality: ChartQuality;
  /** True only when the data is clean enough for AI to read confidently. */
  aiUsable: boolean;
  isLive: boolean;
  stale: boolean;
  /** Most-recent candle close, or null when there is no usable data. */
  lastPrice: number | null;
  lastCandleTime: string | null;
  freshness: SnapshotFreshness;
  /** Honest cause when degraded/unavailable; null when clean + AI-usable. */
  cause: string | null;
  /** User-safe message straight from the shared feed status. */
  message: string;
}

/** Default per-symbol snapshot timeframe for the broad picture. */
const DEFAULT_SNAPSHOT_TIMEFRAME: ChartTimeframe = "M15";
/** Enough history for the truth engine to judge completeness honestly. */
const DEFAULT_SNAPSHOT_LIMIT = 200;

function deriveFreshness(fs: ChartFeedStatus): SnapshotFreshness {
  switch (fs.quality) {
    case "unavailable":
    case "invalid":
    case "empty":
      return "UNAVAILABLE";
    case "stale":
      return "STALE";
    case "delayed":
    case "partial":
      return "DELAYED";
    case "clean":
      return fs.isLive ? "REALTIME" : "DELAYED";
    default:
      return "UNAVAILABLE";
  }
}

/**
 * Per-symbol market snapshot composed from the SAME shared resolver the chart
 * uses. Calling getChartCandles() with the same (symbol, timeframe, limit) the
 * chart reads guarantees identical source + quality at the same moment.
 *
 * Never throws — on a resolver error it returns an honest UNAVAILABLE snapshot
 * rather than fabricating data.
 */
export async function getSymbolSnapshot(
  symbol: string,
  timeframe: ChartTimeframe = DEFAULT_SNAPSHOT_TIMEFRAME,
  limit = DEFAULT_SNAPSHOT_LIMIT,
): Promise<SymbolSnapshot> {
  try {
    const resp = await getChartCandles(symbol, timeframe, limit);
    const fs = resp.feedStatus;
    const lastCandle =
      resp.candles.length > 0 ? resp.candles[resp.candles.length - 1]! : null;
    const lastPrice =
      lastCandle && Number.isFinite(lastCandle.close) ? lastCandle.close : null;
    const cleanAndUsable = fs.quality === "clean" && fs.aiUsable === true;
    const cause = cleanAndUsable
      ? null
      : fs.warning ?? fs.completenessReason ?? fs.message;
    return {
      symbol: resp.symbol,
      displaySymbol: resp.displaySymbol,
      assetClass: resp.assetClass,
      source: resp.source,
      quality: resp.quality,
      aiUsable: resp.aiUsable,
      isLive: fs.isLive,
      stale: fs.stale,
      lastPrice,
      lastCandleTime: fs.lastCandleTime,
      freshness: deriveFreshness(fs),
      cause,
      message: fs.message,
    };
  } catch {
    return {
      symbol,
      displaySymbol: symbol,
      assetClass: classifySymbol(symbol),
      source: null,
      quality: "unavailable",
      aiUsable: false,
      isLive: false,
      stale: true,
      lastPrice: null,
      lastCandleTime: null,
      freshness: "UNAVAILABLE",
      cause: "Market data resolver error.",
      message: "Market data is unavailable for this symbol right now.",
    };
  }
}

// ── Core opportunity scan (single scoring path) ─────────────────────────────

export interface CoreOpportunityScanResult {
  /** Top-N live-only opportunities, ranked by effectiveOpportunityScore. */
  opportunities: ScannerOpportunity[];
  /** (symbol × timeframe) pairs attempted. */
  pairsAttempted: number;
  /** Live rows found before the top-N slice. */
  liveRows: number;
  /** Distinct symbols that produced at least one confirmed-live row. */
  symbolsWithLiveData: number;
  /** Last time the global scanner loop completed a scan, or null. */
  scannerLastScanAt: string | null;
  generatedAt: string;
}

/**
 * Scan a small core set through the SINGLE scoring path (scanSymbolTimeframe)
 * and rank by effectiveOpportunityScore.
 *
 * CRITICAL never-simulator invariant: ONLY rows whose dataStatus is "live" are
 * kept. scanSymbolTimeframe falls back to the simulator for non-synthetic
 * symbols with no live feed; those rows (and awaiting-feed / history-only rows)
 * are dropped here so a fabricated/simulator setup can never reach Ruby.
 */
export async function scanCoreOpportunities(
  symbols: readonly string[],
  timeframes: readonly string[],
  limit = 10,
): Promise<CoreOpportunityScanResult> {
  const pairs: Array<{ symbol: string; timeframe: string }> = [];
  for (const s of symbols) {
    for (const tf of timeframes) pairs.push({ symbol: s, timeframe: tf });
  }
  const rows = await mapWithConcurrency(pairs, OVERVIEW_CONCURRENCY, async (p) => {
    try {
      return await scanSymbolTimeframe(p.symbol, p.timeframe);
    } catch {
      return null;
    }
  });

  const live: ScannerOpportunity[] = [];
  const liveSymbols = new Set<string>();
  for (const r of rows) {
    if (!r) continue;
    if (r.dataStatus !== "live") continue; // never-simulator invariant
    live.push(r);
    liveSymbols.add(r.symbol);
  }
  live.sort((a, b) => effectiveOpportunityScore(b) - effectiveOpportunityScore(a));

  const status = scannerStatus();
  return {
    opportunities: live.slice(0, Math.max(1, limit)),
    pairsAttempted: pairs.length,
    liveRows: live.length,
    symbolsWithLiveData: liveSymbols.size,
    scannerLastScanAt: status.lastScanAt ?? null,
    generatedAt: new Date().toISOString(),
  };
}

// ── Market overview assembler ───────────────────────────────────────────────

/** Small core symbol set kept deliberately tiny for chat latency. */
export const CORE_OVERVIEW_SYMBOLS = [
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "XAUUSD",
  "BTCUSDT",
] as const;

/** Timeframes the core opportunity scan covers (enrichment only). */
const SETUP_TIMEFRAMES = ["M15", "H1"] as const;

/** Bounded fan-out for the snapshot/scan loops. */
const OVERVIEW_CONCURRENCY = 6;

/** Short cache window for the default core overview (chat hot path). */
const OVERVIEW_CACHE_TTL_MS = 10_000;

export interface MarketOverviewNews {
  connected: boolean;
  provider: string;
  items: NewsItem[];
}

export interface MarketOverviewSetups {
  opportunities: ScannerOpportunity[];
  /** True when the scanner produced no live setups this pass. */
  scannerIdle: boolean;
  scannerLastScanAt: string | null;
  /** Honest enrich-not-gate note ("scanner idle since X" / live count). */
  note: string;
}

export interface MarketOverview {
  generatedAt: string;
  /** Per-symbol picture — ALWAYS present, never gated on scanner/provider. */
  snapshots: SymbolSnapshot[];
  /** Scanner setups as ENRICHMENT; degrades independently of the snapshots. */
  setups: MarketOverviewSetups;
  /** Provider-gated, sanitized news. */
  news: MarketOverviewNews;
}

let overviewCache: { at: number; value: MarketOverview } | null = null;

export interface MarketOverviewOptions {
  /** Override the core symbol set (bypasses the cache). */
  symbols?: readonly string[];
  newsQuery?: string;
  newsLimit?: number;
  setupLimit?: number;
  /** Bypass the short-TTL cache for the default core overview. */
  force?: boolean;
  /** Attribute any sanitized-news security event to this user. */
  userId?: number | null;
}

/**
 * Assemble the broad market overview:
 *   1. Per-symbol picture (independent of scanner/provider) — ALWAYS computed.
 *   2. Scanner setups as enrichment with an honest idle note.
 *   3. Provider-gated, sanitized news.
 *
 * The default core overview is cached for OVERVIEW_CACHE_TTL_MS to keep chat
 * fast. A custom symbol set always bypasses the cache.
 */
export async function getMarketOverview(
  opts: MarketOverviewOptions = {},
): Promise<MarketOverview> {
  const useDefaultCore = !opts.symbols || opts.symbols.length === 0;
  if (
    useDefaultCore &&
    !opts.force &&
    overviewCache &&
    Date.now() - overviewCache.at < OVERVIEW_CACHE_TTL_MS
  ) {
    return overviewCache.value;
  }

  const symbols = useDefaultCore
    ? [...CORE_OVERVIEW_SYMBOLS]
    : [...new Set(opts.symbols!)];

  // 1) Per-symbol picture — NEVER gated on scanner/provider availability.
  const snapshots = await mapWithConcurrency(symbols, OVERVIEW_CONCURRENCY, (s) =>
    getSymbolSnapshot(s),
  );

  // 2) Setups (enrichment) + 3) news (provider-gated) — independent, parallel.
  const [scan, news] = await Promise.all([
    scanCoreOpportunities(symbols, SETUP_TIMEFRAMES, opts.setupLimit ?? 10),
    fetchOverviewNews(opts.newsQuery ?? "forex markets", opts.newsLimit ?? 5, opts.userId ?? null),
  ]);

  const scannerIdle = scan.opportunities.length === 0;
  const note = scannerIdle
    ? scan.scannerLastScanAt
      ? `No live setups right now — scanner idle since ${scan.scannerLastScanAt}.`
      : "No live setups right now — the scanner has not produced a live scan yet."
    : `${scan.opportunities.length} live setup(s) from the scanner.`;

  const overview: MarketOverview = {
    generatedAt: new Date().toISOString(),
    snapshots,
    setups: {
      opportunities: scan.opportunities,
      scannerIdle,
      scannerLastScanAt: scan.scannerLastScanAt,
      note,
    },
    news,
  };

  if (useDefaultCore) overviewCache = { at: Date.now(), value: overview };
  return overview;
}

/** Provider-gated news, sanitized as DATA before it can reach the model. */
async function fetchOverviewNews(
  query: string,
  limit: number,
  userId: number | null,
): Promise<MarketOverviewNews> {
  const p = getMarketProvider();
  if (!p.connected || !p.features.news) {
    return { connected: false, provider: p.name, items: [] };
  }
  try {
    const r = await p.getMarketNews(query, limit);
    const items = Array.isArray(r.items)
      ? r.items.map((i) => ({
          ...i,
          headline: sanitizeExternalText(i.headline, {
            source: "market_news",
            field: "headline",
            userId,
          }),
          source: sanitizeExternalText(i.source, {
            source: "market_news",
            field: "source",
            userId,
          }),
          summary:
            typeof i.summary === "string"
              ? sanitizeExternalText(i.summary, {
                  source: "market_news",
                  field: "summary",
                  userId,
                })
              : i.summary,
        }))
      : [];
    return {
      connected: r.connected === true,
      provider: r.provider ?? p.name,
      items,
    };
  } catch {
    return { connected: false, provider: p.name, items: [] };
  }
}

/** Test-only: clear the short-TTL overview cache between deterministic runs. */
export function __resetMarketOverviewCacheForTest(): void {
  overviewCache = null;
}

// ── Bounded concurrency helper ──────────────────────────────────────────────

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}
