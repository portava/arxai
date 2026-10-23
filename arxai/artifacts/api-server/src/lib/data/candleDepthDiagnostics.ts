// ARX AI — Admin candle-depth diagnostics (Task #434).
//
// Read-only operator probe that answers, per symbol × timeframe, EXACTLY how
// much candle history exists and how it would route — proving the deep/cached
// history layer (Task #432) and the truth contract (Task #433) behave honestly.
//
// For a symbol it runs the six canonical chart timeframes (1m/5m/15m/1h/4h/1D)
// through the SAME getCandleHistory() service a real chart-history scroll uses,
// and projects each result into a depth row: source, requested vs returned
// count, oldest/newest bar, history depth (coverage vs target), candle age,
// live-quote availability, provider errors, cache count, can-load-more,
// execution mapping, and broker-symbol resolution. It also derives a pass/fail
// verdict and the exact oldest candle per timeframe for the "Test Candle Depth"
// runner.
//
// Honesty / safety:
//   - Adds NO new data source. Every row is a real probe through the existing
//     router → cache → history service. An unavailable feed yields an honest
//     UNAVAILABLE row, never fabricated data.
//   - NEVER labels historical/stale data as live: the status comes verbatim from
//     getCandleHistory (live | stale | historical_only | unavailable). `pass`
//     means "real candles flowed from a coherent source", never "live".
//   - `executionSource` is DESCRIPTIVE (where a live order WOULD route). This
//     module touches no execution path, no arx_live_* table, no balance/fill,
//     and no safety gate.

import { classifySymbol, type AssetClass } from "./marketDataRouter.js";
import { getCandleHistory, type CandleHistoryStatus } from "./candleHistoryService.js";
import { getCacheCoverage } from "./candleCache.js";
import {
  getProviderRoute,
  depthTargetDaysFor,
  type HistoryDepthSupport,
} from "./providerRoutingMap.js";
import { getMt5QuoteAvailability } from "./providers/mt5Provider.js";
import {
  resolveBrokerSymbolName,
  getBrokerSymbolDirectoryStatus,
} from "../mt5/brokerSymbolName.js";

// The six canonical timeframes the spec's "Test Candle Depth" runner probes,
// with the operator-facing label and the canonical engine timeframe.
export const CANDLE_DEPTH_TIMEFRAMES: ReadonlyArray<{ label: string; timeframe: string }> = [
  { label: "1m", timeframe: "M1" },
  { label: "5m", timeframe: "M5" },
  { label: "15m", timeframe: "M15" },
  { label: "1h", timeframe: "H1" },
  { label: "4h", timeframe: "H4" },
  { label: "1D", timeframe: "D1" },
];

// One page per timeframe probe. Coverage depth is read from the FULL cached
// series via getCacheCoverage, so this page size only bounds the returned bars,
// not the measured history depth.
const DEPTH_PROBE_LIMIT = 500;

// How many timeframe probes run at once. Keeps the provider burst gentle on
// free-tier upstreams while still finishing the six-timeframe matrix quickly.
const DEPTH_PROBE_CONCURRENCY = 3;

export interface CandleDepthRow {
  label: string;
  timeframe: string;
  depthTargetDays: number;

  /** The single coherent source this page was served from (null ⇒ none answered). */
  source: string | null;
  /** Verbatim honesty verdict from getCandleHistory — never upgraded here. */
  status: CandleHistoryStatus;

  requested: number;
  returned: number;
  oldest: string | null;
  newest: string | null;

  /** Total cached span for the winning source, in days (null ⇒ unknown). */
  coverageDays: number | null;
  depthTargetMet: boolean;
  /** Age of the newest returned bar, ms (null ⇒ no bar). */
  candleAgeMs: number | null;

  /** More history is pageable (older cached bars or a deep-cursor provider). */
  hasMoreHistory: boolean;
  /** Provider honestly cannot page deeper from here (ceiling reached). */
  providerLimitReached: boolean;
  /** Provider/limit message, pre-redacted upstream (null ⇒ none). */
  providerMessage: string | null;

  /** Distinct cached bars for (symbol, timeframe, winning source). */
  cacheCount: number;
  historyDepthSupport: HistoryDepthSupport;
  /** DESCRIPTIVE: where a live order for this asset class would route. */
  executionSource: string;

  /** True when real candles flowed from a coherent source (NOT "is live"). */
  pass: boolean;
  note: string;
}

export interface CandleDepthReport {
  generatedAt: string;
  symbol: string;
  assetClass: AssetClass;
  /** DESCRIPTIVE routing context (no execution performed). */
  liveQuoteSource: string;
  executionSource: string;

  /** Broker-symbol resolution at the diagnostics boundary (read-only). */
  brokerSymbol: string;
  brokerSymbolMapped: boolean;
  brokerDirectoryLoaded: boolean;
  brokerDirectoryEntryCount: number;

  /**
   * Live broker quote availability for this symbol (heartbeat-only EA ⇒ false).
   * `ageMs` is the age of the latest pushed quote (null ⇒ no quote ever pushed).
   */
  liveQuote: { present: boolean; fresh: boolean; hasPrice: boolean; ageMs: number | null };

  rows: CandleDepthRow[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    depthTargetsMet: number;
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function buildNote(row: {
  status: CandleHistoryStatus;
  returned: number;
  source: string | null;
  coverageDays: number | null;
  depthTargetDays: number;
  depthTargetMet: boolean;
  providerLimitReached: boolean;
  providerMessage: string | null;
}): string {
  if (row.returned === 0 || row.source == null || row.status === "unavailable") {
    return row.providerMessage ?? "No coherent source returned candles for this timeframe.";
  }
  const covered = row.coverageDays != null ? `${row.coverageDays.toFixed(1)}d` : "unknown depth";
  const target = `${row.depthTargetDays}d target`;
  if (row.depthTargetMet) {
    return `Depth target met (${covered} ≥ ${target}). Status: ${row.status}.`;
  }
  if (row.providerLimitReached) {
    return `Honest provider limit — ${covered} of ${target}. ${row.providerMessage ?? "Deeper history unavailable from this source."}`;
  }
  return `Data flowing — ${covered} of ${target}. More history pageable: ${row.providerMessage ?? "scroll back to deepen."}`;
}

async function probeTimeframe(
  symbol: string,
  label: string,
  timeframe: string,
  executionSource: string,
): Promise<CandleDepthRow> {
  const depthTargetDays = depthTargetDaysFor(timeframe);
  let history;
  try {
    history = await getCandleHistory({ symbol, timeframe, limit: DEPTH_PROBE_LIMIT });
  } catch (err) {
    return {
      label,
      timeframe,
      depthTargetDays,
      source: null,
      status: "unavailable",
      requested: DEPTH_PROBE_LIMIT,
      returned: 0,
      oldest: null,
      newest: null,
      coverageDays: null,
      depthTargetMet: false,
      candleAgeMs: null,
      hasMoreHistory: false,
      providerLimitReached: false,
      providerMessage: `Probe failed: ${String((err as Error).message ?? err).slice(0, 200)}`,
      cacheCount: 0,
      historyDepthSupport: getProviderRoute(classifySymbol(symbol)).historyDepthSupport,
      executionSource,
      pass: false,
      note: "Probe threw — see provider message.",
    };
  }

  // Distinct cached bars for the winning source (0 when nothing answered).
  let cacheCount = 0;
  if (history.source) {
    const coverage = await getCacheCoverage(symbol, timeframe, history.source).catch(() => null);
    cacheCount = coverage?.count ?? 0;
  }

  const candleAgeMs = history.newest ? Date.now() - new Date(history.newest).getTime() : null;
  const route = getProviderRoute(history.assetClass);

  const pass = history.returnedCount > 0 && history.source != null && history.status !== "unavailable";

  const note = buildNote({
    status: history.status,
    returned: history.returnedCount,
    source: history.source,
    coverageDays: history.coverageDays,
    depthTargetDays: history.depthTargetDays,
    depthTargetMet: history.depthTargetMet,
    providerLimitReached: history.providerLimitReached,
    providerMessage: history.providerMessage,
  });

  return {
    label,
    timeframe,
    depthTargetDays: history.depthTargetDays,
    source: history.source,
    status: history.status,
    requested: DEPTH_PROBE_LIMIT,
    returned: history.returnedCount,
    oldest: history.oldest,
    newest: history.newest,
    coverageDays: history.coverageDays,
    depthTargetMet: history.depthTargetMet,
    candleAgeMs: candleAgeMs != null && Number.isFinite(candleAgeMs) ? candleAgeMs : null,
    hasMoreHistory: history.hasMoreHistory,
    providerLimitReached: history.providerLimitReached,
    providerMessage: history.providerMessage,
    cacheCount,
    historyDepthSupport: route.historyDepthSupport,
    executionSource: route.executionSource,
    pass,
    note,
  };
}

/**
 * Build the per-symbol candle-depth report across the six canonical timeframes.
 * Read-only; runs the same getCandleHistory path a real chart scroll uses. Pass
 * an explicit timeframe list to narrow the probe (defaults to all six).
 */
export async function buildCandleDepthReport(
  rawSymbol: string,
  timeframes: ReadonlyArray<{ label: string; timeframe: string }> = CANDLE_DEPTH_TIMEFRAMES,
): Promise<CandleDepthReport> {
  const symbol = rawSymbol.trim().toUpperCase();
  const assetClass = classifySymbol(symbol);
  const route = getProviderRoute(assetClass);

  const [brokerSymbol, directory] = await Promise.all([
    resolveBrokerSymbolName(symbol).catch(() => symbol),
    getBrokerSymbolDirectoryStatus().catch(() => ({ loaded: false, entryCount: 0 })),
  ]);
  const liveQuote = getMt5QuoteAvailability(symbol);

  const rows = await mapWithConcurrency(timeframes, DEPTH_PROBE_CONCURRENCY, (tf) =>
    probeTimeframe(symbol, tf.label, tf.timeframe, route.executionSource),
  );

  const passed = rows.filter((r) => r.pass).length;
  const depthTargetsMet = rows.filter((r) => r.depthTargetMet).length;

  return {
    generatedAt: new Date().toISOString(),
    symbol,
    assetClass,
    liveQuoteSource: route.liveQuoteSource,
    executionSource: route.executionSource,
    brokerSymbol,
    brokerSymbolMapped: brokerSymbol !== symbol,
    brokerDirectoryLoaded: directory.loaded,
    brokerDirectoryEntryCount: directory.entryCount,
    liveQuote: {
      present: liveQuote.hasQuote,
      fresh: liveQuote.fresh,
      hasPrice: liveQuote.hasPrice,
      ageMs: liveQuote.ageMs,
    },
    rows,
    summary: {
      total: rows.length,
      passed,
      failed: rows.length - passed,
      depthTargetsMet,
    },
  };
}
