import type { Candle, CandleResult, MarketQuote } from "./marketProvider.js";

// Explicit fiat pairs only: never interpret an arbitrary six-letter stock as FX.
const PAIRS = new Set(["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD"]);
export const FX_INTERVALS: Record<string, { name: string; ms: number }> = {
  M1: { name: "1min", ms: 60_000 }, M5: { name: "5min", ms: 300_000 },
  M15: { name: "15min", ms: 900_000 }, M30: { name: "30min", ms: 1_800_000 },
  H1: { name: "60min", ms: 3_600_000 },
};
export function alphaFxPair(symbol: string): { from: string; to: string } | null {
  return PAIRS.has(symbol) ? { from: symbol.slice(0, 3), to: symbol.slice(3) } : null;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function positive(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
// The contract supplies a timezone separately. Do not parse timezone-less values
// in the server's local timezone or silently normalize impossible dates.
export function alphaUtcTimestamp(value: unknown, zone: unknown): string | null {
  if (zone !== "UTC" || typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const iso = value.replace(" ", "T") + "Z";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms <= 0 || new Date(ms).toISOString() !== iso.replace("Z", ".000Z")) return null;
  return new Date(ms).toISOString();
}
export function parseAlphaFxQuote(symbol: string, payload: unknown): MarketQuote | null {
  const pair = alphaFxPair(symbol);
  const q = record(record(payload)["Realtime Currency Exchange Rate"]);
  if (!pair || q["1. From_Currency Code"] !== pair.from || q["3. To_Currency Code"] !== pair.to) return null;
  const price = positive(q["5. Exchange Rate"]);
  const bid = positive(q["8. Bid Price"]), ask = positive(q["9. Ask Price"]);
  if (price === null || (bid !== null && ask !== null && bid > ask)) return null;
  return { symbol, price, bid, ask, asOf: alphaUtcTimestamp(q["6. Last Refreshed"], q["7. Time Zone"]),
    change: null, changePct: null, high: null, low: null, open: null, previousClose: null,
    freshness: "REALTIME", source: "alpha_vantage", stale: false };
}
export function parseAlphaFxCandles(symbol: string, timeframe: string, limit: number, payload: unknown, now = Date.now()): CandleResult {
  const pair = alphaFxPair(symbol), interval = FX_INTERVALS[timeframe];
  const data = record(payload), meta = record(data["Meta Data"]);
  const empty: CandleResult = { connected: true, source: "alpha_vantage", symbol, timeframe,
    candles: [], freshness: "UNAVAILABLE", asOf: null, notes: "FX candles unavailable or invalid; provider access may be required." };
  if (!pair || !interval || meta["2. From Symbol"] !== pair.from || meta["3. To Symbol"] !== pair.to
    || meta["5. Interval"] !== interval.name || meta["7. Time Zone"] !== "UTC") return empty;
  const candles: Candle[] = [];
  for (const [timestamp, value] of Object.entries(record(data[`Time Series FX (${interval.name})`]))) {
    const t = alphaUtcTimestamp(timestamp, meta["7. Time Zone"]), row = record(value);
    const o = positive(row["1. open"]), h = positive(row["2. high"]), l = positive(row["3. low"]), c = positive(row["4. close"]);
    if (!t || Date.parse(t) > now || o === null || h === null || l === null || c === null
      || h < Math.max(o, c, l) || l > Math.min(o, c, h)) continue;
    // FX contract has no volume; zero is the existing Candle missing-volume convention.
    candles.push({ t, o, h, l, c, v: 0 });
  }
  candles.sort((a, b) => a.t.localeCompare(b.t));
  const bounded = candles.slice(-Math.max(1, Math.min(100, Number.isFinite(limit) ? Math.floor(limit) : 30)));
  const last = bounded.at(-1);
  if (!last) return empty;
  return { ...empty, candles: bounded, asOf: last.t,
    freshness: now - Date.parse(last.t) <= interval.ms * 2 ? "REALTIME" : "DELAYED",
    notes: "Provider observation times preserved. FX volume is not supplied; consumer freshness and integrity checks still apply." };
}
