// Phase UX6 — Market Context builder.
//
// Provider-backed multi-timeframe context. Uses the existing marketProvider
// (TwelveData + Finnhub) with its 60s candle cache. NEVER fabricates: when
// the provider returns no/insufficient candles for a TF, that TF is marked
// `unavailable` and its derived fields are null.

import { getMarketProvider, type Candle, type MarketQuote } from "../assistant/marketProvider.js";
import { getSymbolSnapshot, type SymbolSnapshot } from "../data/marketOverview.js";

export const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"] as const;
export type Timeframe = typeof TIMEFRAMES[number];

export type TrendDirection = "UP" | "DOWN" | "FLAT" | "UNKNOWN";

export interface TimeframeContext {
  timeframe: Timeframe;
  available: boolean;
  source: string;
  asOf: string | null;
  candleCount: number;
  lastClose: number | null;
  trendDirection: TrendDirection;
  trendStrengthScore: number | null;     // 0..100
  atr: number | null;
  swingHigh: number | null;
  swingLow: number | null;
  rangeHigh: number | null;              // breakout-up reference
  rangeLow: number | null;               // breakout-down reference
  supportLevels: number[];
  resistanceLevels: number[];
  notes?: string;
}

export interface MarketContext {
  symbol: string;
  source: string;
  builtAtIso: string;
  asOf: string | null;
  currentPrice: number | null;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  freshness: MarketQuote["freshness"] | "UNAVAILABLE";
  session: "ASIA" | "LONDON" | "NEWYORK" | "OVERLAP" | "WEEKEND" | "UNKNOWN";
  timeframes: Record<Timeframe, TimeframeContext>;
  dataQuality: {
    hasQuote: boolean;
    hasAnyCandles: boolean;
    timeframesAvailable: Timeframe[];
    timeframesMissing: Timeframe[];
    missing: string[];
    quality: "good" | "partial" | "insufficient";
  };
  /**
   * Shared chart-truth feed status for this symbol (the SAME resolver the chart
   * uses). Populated ONLY when BuildContextOptions.includeSharedFeed is set, so
   * advisory surfaces report identical source/quality/freshness to the chart.
   * When present its `source`/`freshness` are overlaid onto the top-level
   * `source`/`freshness` too. The decision orchestrator never sets the flag and
   * never reads this field, so its context is byte-for-byte unchanged. null when
   * not requested or on resolver error.
   */
  sharedFeed?: SymbolSnapshot | null;
}

const round = (n: number, p = 5) => Math.round(n * Math.pow(10, p)) / Math.pow(10, p);

function detectSession(date = new Date()): MarketContext["session"] {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return "WEEKEND";
  const h = date.getUTCHours();
  // Rough FX sessions (UTC).
  if (h >= 0 && h < 7) return "ASIA";
  if (h >= 7 && h < 12) return "LONDON";
  if (h >= 12 && h < 16) return "OVERLAP";        // London/NY overlap
  if (h >= 16 && h < 21) return "NEWYORK";
  return "ASIA";
}

// ATR (Wilder simple) over last `period` candles. Returns null if not enough data.
function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const recent = candles.slice(-period - 1);
  let sum = 0;
  for (let i = 1; i < recent.length; i++) {
    const c = recent[i]!;
    const prev = recent[i - 1]!;
    const tr = Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c));
    sum += tr;
  }
  return round(sum / period, 7);
}

// Simple SMA of closes.
function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// Pivot swing detection: a candle is a swing high if its high > the highs of
// `lookback` candles on each side. Returns the most recent swing.
function findSwings(candles: Candle[], lookback = 3): { high: number | null; low: number | null } {
  if (candles.length < lookback * 2 + 1) return { high: null, low: null };
  let high: number | null = null;
  let low: number | null = null;
  for (let i = candles.length - lookback - 1; i >= lookback; i--) {
    const c = candles[i]!;
    let isHigh = true, isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j]!.h >= c.h || candles[i + j]!.h >= c.h) isHigh = false;
      if (candles[i - j]!.l <= c.l || candles[i + j]!.l <= c.l) isLow = false;
    }
    if (isHigh && high == null) high = c.h;
    if (isLow && low == null) low = c.l;
    if (high != null && low != null) break;
  }
  return { high: high != null ? round(high) : null, low: low != null ? round(low) : null };
}

// Build a small S/R cluster list from pivot swings (top 3 of each).
function findLevels(candles: Candle[], lookback = 3): { supports: number[]; resistances: number[] } {
  const supports: number[] = [];
  const resistances: number[] = [];
  if (candles.length < lookback * 2 + 1) return { supports, resistances };
  for (let i = candles.length - lookback - 1; i >= lookback; i--) {
    const c = candles[i]!;
    let isHigh = true, isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j]!.h >= c.h || candles[i + j]!.h >= c.h) isHigh = false;
      if (candles[i - j]!.l <= c.l || candles[i + j]!.l <= c.l) isLow = false;
    }
    if (isHigh && resistances.length < 6) resistances.push(round(c.h));
    if (isLow && supports.length < 6) supports.push(round(c.l));
  }
  return { supports, resistances };
}

function classifyTrend(candles: Candle[]): { direction: TrendDirection; strength: number | null } {
  if (candles.length < 20) return { direction: "UNKNOWN", strength: null };
  const closes = candles.map((c) => c.c);
  const fast = sma(closes, 8);
  const slow = sma(closes, 20);
  const last = closes[closes.length - 1]!;
  if (fast == null || slow == null) return { direction: "UNKNOWN", strength: null };
  const sep = (fast - slow) / (slow || 1);          // signed normalized separation
  const lastVsSlow = (last - slow) / (slow || 1);
  // Direction
  let dir: TrendDirection = "FLAT";
  if (sep > 0.0005 && lastVsSlow > 0) dir = "UP";
  else if (sep < -0.0005 && lastVsSlow < 0) dir = "DOWN";
  // Strength: bigger separation + more candles agreeing → higher score.
  const recent = closes.slice(-10);
  let agrees = 0;
  for (let i = 1; i < recent.length; i++) {
    if (dir === "UP" && recent[i]! > recent[i - 1]!) agrees++;
    else if (dir === "DOWN" && recent[i]! < recent[i - 1]!) agrees++;
  }
  const sepScore = Math.min(100, Math.abs(sep) * 50_000);
  const agreeScore = (agrees / 9) * 100;
  const strength = dir === "FLAT"
    ? Math.max(0, 30 - Math.abs(sep) * 50_000)
    : Math.round(sepScore * 0.6 + agreeScore * 0.4);
  return { direction: dir, strength: Math.max(0, Math.min(100, Math.round(strength))) };
}

function buildEmptyTf(tf: Timeframe, source: string, notes?: string): TimeframeContext {
  return {
    timeframe: tf, available: false, source, asOf: null, candleCount: 0,
    lastClose: null, trendDirection: "UNKNOWN", trendStrengthScore: null,
    atr: null, swingHigh: null, swingLow: null, rangeHigh: null, rangeLow: null,
    supportLevels: [], resistanceLevels: [], notes,
  };
}

function buildTf(tf: Timeframe, source: string, asOf: string | null, candles: Candle[]): TimeframeContext {
  if (candles.length < 5) return buildEmptyTf(tf, source, `Only ${candles.length} candle(s) available`);
  const lastClose = candles[candles.length - 1]!.c;
  const trend = classifyTrend(candles);
  const { high: swingHigh, low: swingLow } = findSwings(candles, 3);
  const { supports, resistances } = findLevels(candles, 3);
  const window = candles.slice(-20);
  const rangeHigh = round(Math.max(...window.map((c) => c.h)));
  const rangeLow = round(Math.min(...window.map((c) => c.l)));
  return {
    timeframe: tf, available: true, source, asOf,
    candleCount: candles.length, lastClose: round(lastClose),
    trendDirection: trend.direction, trendStrengthScore: trend.strength,
    atr: atr(candles, 14),
    swingHigh, swingLow,
    rangeHigh, rangeLow,
    supportLevels: supports.slice(0, 3),
    resistanceLevels: resistances.slice(0, 3),
  };
}

export interface BuildContextOptions {
  symbol: string;
  timeframes?: Timeframe[];
  candleLimit?: number;
  /**
   * Advisory surfaces only: also resolve the shared chart-truth snapshot and
   * overlay its source/quality/freshness so Ruby reports exactly what the chart
   * shows. The decision orchestrator leaves this unset (default false) → no
   * extra fetch, identical context.
   */
  includeSharedFeed?: boolean;
}

export async function buildMarketContext(opts: BuildContextOptions): Promise<MarketContext> {
  const symbol = opts.symbol.trim().toUpperCase();
  const tfs = opts.timeframes ?? [...TIMEFRAMES];
  const limit = opts.candleLimit ?? 50;
  const provider = getMarketProvider();

  // Quote first (cheap, gives spread/bid/ask).
  let quote: MarketQuote | null = null;
  try {
    if (provider.features.quotes) quote = await provider.getLiveQuote(symbol);
  } catch { quote = null; }

  // Candles per TF in parallel.
  const tfResults = await Promise.all(tfs.map(async (tf) => {
    if (!provider.features.candles) {
      return [tf, buildEmptyTf(tf, provider.name, "Provider has no candle support")] as const;
    }
    try {
      const r = await provider.getCandles(symbol, tf, limit);
      if (!r || !r.connected || !r.candles || r.candles.length === 0) {
        return [tf, buildEmptyTf(tf, r?.source ?? provider.name, r?.notes ?? "No candles returned")] as const;
      }
      return [tf, buildTf(tf, r.source, r.asOf, r.candles)] as const;
    } catch (e) {
      return [tf, buildEmptyTf(tf, provider.name, `Provider error: ${(e as Error).message.slice(0, 80)}`)] as const;
    }
  }));

  const byTf = Object.fromEntries(tfResults) as Record<Timeframe, TimeframeContext>;
  // Make sure every requested TF exists in the record (TS-friendly).
  for (const t of TIMEFRAMES) {
    if (!byTf[t]) byTf[t] = buildEmptyTf(t, provider.name, "Not requested");
  }

  const available = tfs.filter((t) => byTf[t]!.available);
  const missing = tfs.filter((t) => !byTf[t]!.available);
  const hasAnyCandles = available.length > 0;
  const hasQuote = !!quote && quote.price != null;

  const quality: "good" | "partial" | "insufficient" =
    !hasAnyCandles ? "insufficient"
      : available.length >= Math.max(3, Math.floor(tfs.length * 0.6)) ? "good"
        : "partial";

  const currentPrice = quote?.price
    ?? (byTf.M1?.lastClose ?? byTf.M5?.lastClose ?? byTf.M15?.lastClose ?? null);
  const bid = quote?.bid ?? null;
  const ask = quote?.ask ?? null;
  const spread = (bid != null && ask != null) ? round(ask - bid, 7) : null;

  // Shared chart-truth overlay (advisory surfaces only). Never set on the
  // decision-orchestrator path, so its context — including source/freshness —
  // is identical to before. On resolver error we keep the provider-derived
  // values rather than fabricating a feed status.
  let sharedFeed: SymbolSnapshot | null = null;
  if (opts.includeSharedFeed) {
    try {
      sharedFeed = await getSymbolSnapshot(symbol);
    } catch {
      sharedFeed = null;
    }
  }

  return {
    symbol,
    source: sharedFeed?.source ?? provider.name,
    builtAtIso: new Date().toISOString(),
    asOf: quote?.asOf ?? (available.length ? byTf[available[0]!]!.asOf : null),
    currentPrice, bid, ask, spread,
    freshness: sharedFeed
      ? sharedFeed.freshness
      : (quote?.freshness ?? (hasAnyCandles ? "DELAYED" : "UNAVAILABLE")),
    session: detectSession(),
    timeframes: byTf,
    dataQuality: {
      hasQuote, hasAnyCandles,
      timeframesAvailable: available,
      timeframesMissing: missing,
      missing: [
        ...(hasQuote ? [] : ["quote"]),
        ...missing.map((t) => `candles_${t}`),
      ],
      quality,
    },
    sharedFeed,
  };
}
