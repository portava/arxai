// Shared GET /api/chart/candles query — the ONE honest market source for the
// scanner (Task #391). Both ScannerChartPanel and useScannerTruth use this same
// query key so React Query dedupes to a single network call and every surface
// reads identical candles + feedStatus. Never falls back to the simulator quote.

import type { ChartFeedStatus } from "@workspace/api-client-react";
import { adaptChartCandles, type Candle } from "@/components/scanner/scannerCandleAdapter";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

// Chart timeframe ids (1m/5m/…) → the backend candles contract enum (M1/M5/…).
// Covers the full 21 MT5 timeframe set (M1…MN1). The month id is "1mo" (never
// "1m", which is one minute) and maps to MN1.
export function toApiTimeframe(tf: string): string {
  switch (tf.trim().toLowerCase()) {
    case "1m": return "M1";
    case "2m": return "M2";
    case "3m": return "M3";
    case "4m": return "M4";
    case "5m": return "M5";
    case "6m": return "M6";
    case "10m": return "M10";
    case "12m": return "M12";
    case "15m": return "M15";
    case "20m": return "M20";
    case "30m": return "M30";
    case "1h": return "H1";
    case "2h": return "H2";
    case "3h": return "H3";
    case "4h": return "H4";
    case "6h": return "H6";
    case "8h": return "H8";
    case "12h": return "H12";
    case "1d": return "D1";
    case "1w": return "W1";
    case "1mo": return "MN1";
    default: return "M5";
  }
}

// Accepts EITHER a canonical lowercase chart id ("15m") OR a backend candles
// enum ("M15") and returns the canonical lowercase id ("15m"). Scanner signals
// carry backend-format timeframes (M1/M5/M15/H1/H4 — DEFAULT_TIMEFRAMES), so
// feeding signal.timeframe straight into useScannerTruth would miss BOTH
// toApiTimeframe's lowercase switch (→ wrong candles) AND the lowercase
// TIMEFRAME_THRESHOLDS keys (→ strict 1m budget), flagging genuinely-live coarse
// bars as "stale". Normalize at the call boundary first. Covers the full 21 MT5
// set. NOTE: the month label "1M" (MN1) collides with "1m" (one minute) once
// lowercased, so the raw "1M" label is disambiguated to "1mo" BEFORE lowercasing.
export function normalizeChartTimeframe(tf: string | null | undefined): string {
  const raw = (tf ?? "").trim();
  if (raw === "1M") return "1mo"; // month label, not one-minute
  switch (raw.toLowerCase()) {
    case "1m": case "m1": return "1m";
    case "2m": case "m2": return "2m";
    case "3m": case "m3": return "3m";
    case "4m": case "m4": return "4m";
    case "5m": case "m5": return "5m";
    case "6m": case "m6": return "6m";
    case "10m": case "m10": return "10m";
    case "12m": case "m12": return "12m";
    case "15m": case "m15": return "15m";
    case "20m": case "m20": return "20m";
    case "30m": case "m30": return "30m";
    case "1h": case "h1": return "1h";
    case "2h": case "h2": return "2h";
    case "3h": case "h3": return "3h";
    case "4h": case "h4": return "4h";
    case "6h": case "h6": return "6h";
    case "8h": case "h8": return "8h";
    case "12h": case "h12": return "12h";
    case "1d": case "d1": return "1d";
    case "1w": case "w1": return "1w";
    case "1mo": case "mn1": return "1mo";
    default: return "5m";
  }
}

export interface ChartCandlesResult {
  candles: Candle[];
  feedStatus: ChartFeedStatus | null;
}

export function chartCandlesQueryKey(symbol: string, apiTf: string, limit: number) {
  return ["chart-candles", symbol, apiTf, limit] as const;
}

export async function fetchChartCandles(
  symbol: string,
  apiTf: string,
  limit: number,
): Promise<ChartCandlesResult> {
  const res = await fetch(
    `${BASE}/api/chart/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(apiTf)}&limit=${limit}`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: unknown = await res.json();
  const obj = data as Record<string, unknown> | null;
  const arr = Array.isArray(data) ? data : (obj?.candles as unknown[] | undefined) ?? [];
  const candles = adaptChartCandles(arr as Array<Record<string, unknown>>);
  const feedStatus = (obj?.feedStatus as ChartFeedStatus | undefined) ?? null;
  return { candles, feedStatus };
}

// ── Deep history (Task #438) ────────────────────────────────────────────────
// One page of scrollable candle HISTORY from GET /api/chart/history. Candles are
// adapted to the same epoch-ms Candle shape used by both charts. The metadata is
// passed through honestly: a page reached via the `before` cursor is
// historical_only by definition, and a forward-only provider reports its real
// ceiling via providerLimitReached + limitationReason (never fabricated).
export type ChartHistoryStatus = "live" | "stale" | "historical_only" | "unavailable";

export interface ChartHistoryPage {
  ok: boolean;
  source: string | null;
  candles: Candle[];
  status: ChartHistoryStatus;
  returnedCount: number;
  oldest: string | null;
  newest: string | null;
  hasMoreHistory: boolean;
  nextBefore: string | null;
  providerLimitReached: boolean;
  providerMessage: string | null;
  limitationReason: string | null;
  cacheHit: boolean;
  depthTargetDays: number;
  coverageDays: number | null;
  depthTargetMet: boolean;
  sourcePriorityUsed: string[];
  userMessage: string;
}

export async function fetchChartHistory(args: {
  symbol: string;
  apiTf: string;
  limit?: number;
  before?: string | null;
  source?: string | null;
}): Promise<ChartHistoryPage> {
  const params = new URLSearchParams({
    symbol: args.symbol,
    timeframe: args.apiTf,
    limit: String(args.limit ?? 500),
  });
  if (args.before) params.set("before", args.before);
  if (args.source) params.set("source", args.source);
  const res = await fetch(`${BASE}/api/chart/history?${params.toString()}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const obj = (await res.json()) as Record<string, unknown>;
  const rawCandles = Array.isArray(obj.candles) ? (obj.candles as unknown[]) : [];
  return {
    ok: Boolean(obj.ok),
    source: (obj.source as string | null) ?? null,
    candles: adaptChartCandles(rawCandles as Array<Record<string, unknown>>),
    status: (obj.status as ChartHistoryStatus) ?? "unavailable",
    returnedCount: Number(obj.returnedCount ?? 0),
    oldest: (obj.oldest as string | null) ?? null,
    newest: (obj.newest as string | null) ?? null,
    hasMoreHistory: Boolean(obj.hasMoreHistory),
    nextBefore: (obj.nextBefore as string | null) ?? null,
    providerLimitReached: Boolean(obj.providerLimitReached),
    providerMessage: (obj.providerMessage as string | null) ?? null,
    limitationReason: (obj.limitationReason as string | null) ?? null,
    cacheHit: Boolean(obj.cacheHit),
    depthTargetDays: Number(obj.depthTargetDays ?? 0),
    coverageDays: obj.coverageDays == null ? null : Number(obj.coverageDays),
    depthTargetMet: Boolean(obj.depthTargetMet),
    sourcePriorityUsed: Array.isArray(obj.sourcePriorityUsed)
      ? (obj.sourcePriorityUsed as string[])
      : [],
    userMessage: String(obj.userMessage ?? ""),
  };
}
