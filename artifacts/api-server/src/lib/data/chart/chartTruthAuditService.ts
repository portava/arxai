// ARX Chart Truth Health audit service.
//
// Turns the static Phase 5 per-timeframe QA table (docs/CHART_TRUTH_QA_AUDIT.md)
// into a live, admin-facing health probe. For a curated matrix of representative
// symbols × timeframes it runs a LIGHTWEIGHT candle probe (limit=10) through the
// EXISTING chart data service (getChartCandles → market-data router + candle
// truth engine) and projects each result into the Phase 5 column set.
//
// Honesty / safety:
//   - Adds NO new data source. Each row is a real probe through the same router
//     a normal chart load uses; an unavailable feed yields an honest
//     UNAVAILABLE row, never fabricated data.
//   - Result is cached for AUDIT_TTL_MS (5 min) and rebuilt under a single-flight
//     lock, so concurrent admin requests share one rebuild and the live provider
//     is never hit more often than a normal chart load.
//   - The probe deliberately requests only 10 bars, so the truth engine's
//     history-minimum check (≥150 bars) would always fail. We therefore derive a
//     dedicated audit status that IGNORES the small-probe history shortfall and
//     keys only on real health signals (provider up, OHLC valid, no mock data,
//     feed not stale, no sequence/precision/seam anomalies).

import { getChartCandles } from "./chartDataService.js";
import { CHART_TIMEFRAMES, type ChartTimeframe } from "./timeframes.js";
import { classifySymbol, type AssetClass } from "../marketDataRouter.js";
import { isMergeSeamMeasured } from "./chartTruthScore.js";

// Small probe window — enough to assess source, freshness, integrity and the
// forming/merge seam without pulling a full chart payload. Intentionally well
// below MIN_CANDLE_HISTORY_COUNT so we never depend on deep history here.
const AUDIT_PROBE_LIMIT = 10;

// At most one rebuild every 5 minutes. Admin requests inside the window get the
// cached snapshot instantly.
const AUDIT_TTL_MS = 5 * 60 * 1000;

// How many probes run concurrently. Keeps the burst gentle on free-tier
// providers while still finishing the matrix quickly.
const AUDIT_PROBE_CONCURRENCY = 3;

// Representative symbols — one (or two) per asset class, mirroring the Phase 5
// audit doc (EURUSD + V75 were the documented representatives; we widen to one
// per family so a single provider outage is visible per asset class).
export const CHART_TRUTH_AUDIT_SYMBOLS: string[] = [
  "EURUSD", // forex major
  "XAUUSD", // metals
  "US30", // indices
  "V75", // synthetic (Deriv)
  "BTCUSDT", // crypto
];

// Audit every supported chart timeframe.
export const CHART_TRUTH_AUDIT_TIMEFRAMES: readonly ChartTimeframe[] = CHART_TIMEFRAMES;

export type ChartTruthAuditStatus = "CLEAN" | "PARTIAL" | "STALE" | "DEGRADED" | "UNAVAILABLE";

export interface ChartTruthAuditRow {
  symbol: string;
  displaySymbol: string;
  assetClass: AssetClass;
  timeframe: ChartTimeframe;

  // ── Phase 5 column set ──────────────────────────────────────────────────
  /** Candles returned by the probe (limit=10). 0 ⇒ feed unavailable/empty. */
  candleCount: number;
  /** Winning provider id, or chain-exhausted null. */
  source: string | null;
  /** high ≥ max(O,C) and low ≤ min(O,C) for every returned bar. */
  ohlcPass: boolean;
  /** Bar bucket duration matches timeframeMs(tf): no missing/out-of-order bars. */
  aggregationPass: boolean;
  /** Last bar isComplete=false when its closeTime > now (forming bar present). */
  formingCandlePresent: boolean;
  /** The seam was measured (closed-to-forming bar pair) AND has no gap/overlap.
   *  False when it could not be measured — see `mergeChecked`. */
  mergePass: boolean;
  /** Additive: true only when a closed-to-forming bar pair let the seam be measured. */
  mergeChecked: boolean;
  /** Advisory outlier flags (never degrade the verdict on their own). */
  outlierSpikeCount: number;
  outlierWickCount: number;
  historicalPeriodShiftCount: number;
  /** Response symbol + timeframe match the requested values (an echo check,
   *  not a broker-price mirror comparison). */
  mirrorPass: boolean;
  /** Price decimal count consistent with symbolProfile.pricePrecision. False
   *  when no precision profile was known — see `priceChecked`. */
  priceAlignPass: boolean;
  /** Additive: true only when a precision profile let price scale be checked. */
  priceChecked: boolean;
  /** Additive: the served feed was confirmed live (false = closed market or
   *  stored data; null = not reported). */
  feedLive: boolean | null;
  /** Feed aiUsable (quality clean). This is NOT Ruby's full read gate, which
   *  also needs Chart Truth ≥ 75 and a handshake PASS (not checked here). */
  rubyAllowed: boolean;

  // ── Derived health verdict (small-probe aware) ──────────────────────────
  status: ChartTruthAuditStatus;
  /** Truth-engine assessment as-is (PARTIAL is expected here due to limit=10). */
  rawAssessment: string;
  /** HTTP-surface quality from the chart data service. */
  quality: string;
  /** Human-readable health notes for this row (admin-facing). */
  reasons: string[];
  /** Admin-only reason when mock/dev data is detected; otherwise null. */
  mockDataAdminReason: string | null;
  newestBarTime: string | null;
  latencyMs: number | null;
}

export interface ChartTruthAuditSummary {
  total: number;
  clean: number;
  partial: number;
  stale: number;
  degraded: number;
  unavailable: number;
  /** Worst status across all rows (UNAVAILABLE/DEGRADED > STALE > PARTIAL > CLEAN). */
  worstStatus: ChartTruthAuditStatus;
}

export interface ChartTruthAuditReport {
  generatedAt: string;
  cached: boolean;
  ttlSeconds: number;
  ageSeconds: number;
  nextRefreshInSeconds: number;
  probeLimit: number;
  symbols: string[];
  timeframes: ChartTimeframe[];
  rows: ChartTruthAuditRow[];
  summary: ChartTruthAuditSummary;
}

const STATUS_SEVERITY: Record<ChartTruthAuditStatus, number> = {
  CLEAN: 0,
  PARTIAL: 1,
  STALE: 2,
  DEGRADED: 3,
  UNAVAILABLE: 4,
};

interface CacheEntry {
  builtAt: number;
  report: Omit<ChartTruthAuditReport, "cached" | "ageSeconds" | "nextRefreshInSeconds">;
}

let cache: CacheEntry | null = null;
let inflight: Promise<CacheEntry> | null = null;

async function mapWithConcurrency<T, R>(
  items: T[],
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

async function probeRow(symbol: string, timeframe: ChartTimeframe): Promise<ChartTruthAuditRow> {
  let resp;
  try {
    resp = await getChartCandles(symbol, timeframe, AUDIT_PROBE_LIMIT);
  } catch (err) {
    let assetClass: AssetClass;
    try { assetClass = classifySymbol(symbol); } catch { assetClass = "unknown" as AssetClass; }
    return {
      symbol,
      displaySymbol: symbol,
      assetClass,
      timeframe,
      candleCount: 0,
      source: null,
      ohlcPass: false,
      aggregationPass: false,
      formingCandlePresent: false,
      mergePass: false,
      mergeChecked: false,
      outlierSpikeCount: 0,
      outlierWickCount: 0,
      historicalPeriodShiftCount: 0,
      mirrorPass: false,
      priceAlignPass: false,
      priceChecked: false,
      feedLive: null,
      rubyAllowed: false,
      status: "UNAVAILABLE",
      rawAssessment: "UNAVAILABLE",
      quality: "unavailable",
      reasons: [`Probe could not be loaded: ${String((err as Error).message ?? err).slice(0, 200)}`],
      mockDataAdminReason: null,
      newestBarTime: null,
      latencyMs: null,
    };
  }

  const tr = resp.truthResult;
  const candleCount = resp.candleCount;

  const ohlcPass = candleCount > 0 && (tr?.invalidOhlcCount ?? 1) === 0;
  const aggregationPass =
    candleCount > 0 &&
    (tr?.missingCandleCount ?? 1) === 0 &&
    (tr?.outOfOrderCount ?? 1) === 0 &&
    (tr?.duplicateCount ?? 1) === 0;
  // A check that did not run is "not checked", never a pass: the seam needs a
  // closed-to-forming bar pair, price scale needs a known precision profile.
  const mergeChecked = isMergeSeamMeasured(tr);
  const seamFailed = mergeChecked && (tr!.mergeSeam.gapAtSeam || tr!.mergeSeam.overlapAtSeam);
  const mergePass = mergeChecked && !seamFailed;
  const priceChecked = candleCount > 0 && tr?.pricePrecision != null && Number.isSafeInteger(tr.pricePrecision);
  const precisionViolations = priceChecked ? (tr?.precisionViolationCount ?? 0) : 0;
  const priceAlignPass = priceChecked && precisionViolations === 0;
  const mirrorPass = resp.symbol === symbol && resp.timeframe === timeframe;
  const feedLive = typeof resp.feedStatus?.isLive === "boolean" ? resp.feedStatus.isLive : null;

  // Derive a small-probe-aware status. We do NOT use truthResult.assessment
  // directly because limit=10 always trips its ≥150-bar history-minimum check
  // (→ PARTIAL). Instead we key on real health signals only.
  const reasons: string[] = [];
  let status: ChartTruthAuditStatus;

  if (candleCount === 0 || resp.quality === "unavailable" || resp.quality === "empty") {
    status = "UNAVAILABLE";
    reasons.push(resp.warning ?? `No candles returned for ${symbol} ${timeframe}.`);
  } else if (tr?.mockDataDetected) {
    status = "DEGRADED";
    reasons.push("Mock/simulated data detected — not safe as tradable truth.");
  } else if (!ohlcPass) {
    status = "DEGRADED";
    reasons.push(`${tr?.invalidOhlcCount ?? 0} bar(s) with invalid OHLC.`);
  } else if (resp.quality === "stale" || tr?.assessment === "STALE") {
    status = "STALE";
    reasons.push(resp.warning ?? "Feed is stale.");
  } else if (!aggregationPass || seamFailed || precisionViolations > 0) {
    status = "PARTIAL";
    if (!aggregationPass) {
      reasons.push(
        `Sequence anomalies: ${tr?.missingCandleCount ?? 0} missing, ${tr?.duplicateCount ?? 0} duplicate, ${tr?.outOfOrderCount ?? 0} out-of-order.`,
      );
    }
    if (seamFailed) reasons.push("Seam gap/overlap between last complete bar and forming bar.");
    if (precisionViolations > 0) reasons.push(`${precisionViolations} bar(s) with wrong price scale.`);
  } else if (resp.quality === "delayed") {
    status = "PARTIAL";
    reasons.push(resp.warning ?? "Feed is delayed — newest bar is not the current bar.");
  } else if (feedLive !== true) {
    // Clean bars from a closed market or a stored mirror are not "fresh".
    status = "PARTIAL";
    reasons.push("Feed is not confirmed live (market closed, or stored data) — the newest bar is not confirmed current.");
  } else {
    status = "CLEAN";
  }
  if (candleCount > 0 && !mergeChecked) reasons.push("Merge seam not checked (no closed-to-forming bar pair in the probe).");
  if (candleCount > 0 && !priceChecked) reasons.push("Price scale not checked (no precision profile for this symbol).");

  // Advisory outlier context (never escalates the verdict).
  if ((tr?.historicalPeriodShiftCount ?? 0) > 0) {
    reasons.push(`${tr!.historicalPeriodShiftCount} bar(s) from a different price epoch (real history).`);
  }

  return {
    symbol,
    displaySymbol: resp.displaySymbol,
    assetClass: resp.assetClass,
    timeframe,
    candleCount,
    source: resp.source,
    ohlcPass,
    aggregationPass,
    formingCandlePresent: tr?.formingCandlePresent ?? false,
    mergePass,
    mergeChecked,
    outlierSpikeCount: tr?.outlierSpikeCount ?? 0,
    outlierWickCount: tr?.outlierWickCount ?? 0,
    historicalPeriodShiftCount: tr?.historicalPeriodShiftCount ?? 0,
    mirrorPass,
    priceAlignPass,
    priceChecked,
    feedLive,
    rubyAllowed: resp.aiUsable,
    status,
    rawAssessment: tr?.assessment ?? "UNAVAILABLE",
    quality: resp.quality,
    reasons,
    mockDataAdminReason: tr?.mockDataAdminReason ?? null,
    newestBarTime: tr?.newestBarTime ?? null,
    latencyMs: resp.latencyMs,
  };
}

function summarize(rows: ChartTruthAuditRow[]): ChartTruthAuditSummary {
  let clean = 0;
  let partial = 0;
  let stale = 0;
  let degraded = 0;
  let unavailable = 0;
  let worst: ChartTruthAuditStatus = "CLEAN";
  for (const r of rows) {
    switch (r.status) {
      case "CLEAN": clean++; break;
      case "PARTIAL": partial++; break;
      case "STALE": stale++; break;
      case "DEGRADED": degraded++; break;
      case "UNAVAILABLE": unavailable++; break;
    }
    if (STATUS_SEVERITY[r.status] > STATUS_SEVERITY[worst]) worst = r.status;
  }
  return { total: rows.length, clean, partial, stale, degraded, unavailable, worstStatus: worst };
}

async function buildReport(): Promise<CacheEntry> {
  const pairs: Array<{ symbol: string; timeframe: ChartTimeframe }> = [];
  for (const symbol of CHART_TRUTH_AUDIT_SYMBOLS) {
    for (const timeframe of CHART_TRUTH_AUDIT_TIMEFRAMES) {
      pairs.push({ symbol, timeframe });
    }
  }

  const rows = await mapWithConcurrency(pairs, AUDIT_PROBE_CONCURRENCY, (p) =>
    probeRow(p.symbol, p.timeframe),
  );

  const builtAt = Date.now();
  return {
    builtAt,
    report: {
      generatedAt: new Date(builtAt).toISOString(),
      ttlSeconds: Math.round(AUDIT_TTL_MS / 1000),
      probeLimit: AUDIT_PROBE_LIMIT,
      symbols: [...CHART_TRUTH_AUDIT_SYMBOLS],
      timeframes: [...CHART_TRUTH_AUDIT_TIMEFRAMES],
      rows,
      summary: summarize(rows),
    },
  };
}

/**
 * Return the Chart Truth Health audit report. Cached for AUDIT_TTL_MS and
 * rebuilt under a single-flight lock so concurrent admin requests share one
 * rebuild. Pass `force` to bypass the cache (still single-flight).
 */
export async function getChartTruthAudit(force = false): Promise<ChartTruthAuditReport> {
  const now = Date.now();
  if (!force && cache && now - cache.builtAt < AUDIT_TTL_MS) {
    return decorate(cache, true);
  }

  if (!inflight) {
    inflight = buildReport().finally(() => {
      inflight = null;
    });
    inflight.then((entry) => { cache = entry; }).catch(() => { /* surfaced to awaiter */ });
  }

  const entry = await inflight;
  return decorate(entry, false);
}

function decorate(entry: CacheEntry, cached: boolean): ChartTruthAuditReport {
  const ageMs = Date.now() - entry.builtAt;
  return {
    ...entry.report,
    cached,
    ageSeconds: Math.max(0, Math.round(ageMs / 1000)),
    nextRefreshInSeconds: Math.max(0, Math.round((AUDIT_TTL_MS - ageMs) / 1000)),
  };
}
