// Build DD — Fallback (synthetic) market data provider.
//
// Always available. Used when no real provider is configured or when the
// real provider fails. Wraps the existing strategyEngine synthetic candle
// generator and synthesizes a plausible bid/ask spread for downstream use.
// Output is ALWAYS labeled source="FALLBACK" so callers cannot mistake it
// for live data.

import {
  generateSyntheticCandles,
  detectSession,
} from "../strategyEngine.js";
import type {
  MarketCandle,
  MarketDataProvider,
  MarketDataSnapshot,
  SessionContext,
  VolatilityLevel,
} from "./types.js";

function timeframeMinutes(tf: string): number {
  switch (tf) {
    case "M1": return 1;
    case "M5": return 5;
    case "M15": return 15;
    case "M30": return 30;
    case "H1": return 60;
    case "H4": return 240;
    case "D1": return 1440;
    default: return 5;
  }
}

function classifyVolatility(candles: MarketCandle[]): VolatilityLevel {
  if (candles.length < 20) return "NORMAL";
  const recent = candles.slice(-20);
  const ranges = recent.map((c) => Math.abs(c.high - c.low));
  const avgRange = ranges.reduce((s, r) => s + r, 0) / ranges.length;
  const lastPrice = recent[recent.length - 1]!.close;
  const pct = lastPrice > 0 ? avgRange / lastPrice : 0;
  if (pct < 0.001) return "LOW";
  if (pct < 0.005) return "NORMAL";
  if (pct < 0.015) return "HIGH";
  return "EXTREME";
}

function sessionContextFor(symbol: string, candles: MarketCandle[]): SessionContext {
  const session = detectSession();
  const isSynthetic = symbol.toLowerCase().includes("volatility")
    || symbol.toLowerCase().includes("boom")
    || symbol.toLowerCase().includes("crash");
  // Deriv synthetic indices are 24/7. Other symbols follow the session.
  const isMarketOpen = isSynthetic ? true : session !== "Closed";
  const liquidityLevel: SessionContext["liquidityLevel"] =
    session === "London/NY Overlap" ? "HIGH"
    : session === "Closed" ? "LOW"
    : "NORMAL";
  return {
    sessionName: session,
    isMarketOpen,
    liquidityLevel,
    volatilityLevel: classifyVolatility(candles),
  };
}

export class FallbackMarketDataProvider implements MarketDataProvider {
  readonly name = "synthetic-fallback";
  readonly source = "FALLBACK" as const;

  isConfigured(): boolean {
    return true; // always available
  }

  async fetch(req: { symbol: string; timeframe: string; limit: number }): Promise<MarketDataSnapshot> {
    const start = Date.now();
    const raw = generateSyntheticCandles(req.symbol, Math.max(50, req.limit));
    const tfMs = timeframeMinutes(req.timeframe) * 60_000;
    // Re-stamp times so spacing matches the requested timeframe.
    const baseTime = Date.now() - raw.length * tfMs;
    const candles: MarketCandle[] = raw.map((c, i) => ({
      time: new Date(baseTime + i * tfMs).toISOString(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume ?? 100,
    }));
    const last = candles[candles.length - 1]!;
    // Plausible synthetic spread: ~3 bps of price for synthetics.
    const spreadBps = req.symbol.toLowerCase().includes("volatility") ? 0.0003 : 0.0001;
    const spread = Math.max(last.close * spreadBps, 0.0001);
    const mid = last.close;
    const bid = mid - spread / 2;
    const ask = mid + spread / 2;
    const session = sessionContextFor(req.symbol, candles);
    const latencyMs = Date.now() - start;
    return {
      symbol: req.symbol,
      source: "FALLBACK",
      provider: this.name,
      bid: Number(bid.toFixed(5)),
      ask: Number(ask.toFixed(5)),
      mid: Number(mid.toFixed(5)),
      spread: Number(spread.toFixed(5)),
      // Quote timestamp = "now" (live tick); the candles array still uses
      // their own per-bar open times. Without this, an M5 fallback quote
      // would be ~5 minutes old by definition and trigger the stale blocker.
      timestamp: new Date().toISOString(),
      timeframe: req.timeframe as MarketDataSnapshot["timeframe"],
      candles,
      sessionContext: session,
      dataQuality: {
        status: "GOOD",
        latencyMs,
        candlesAvailable: candles.length,
        warnings: ["Using synthetic FALLBACK data — no real provider configured."],
      },
    };
  }

  async health(): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
    const t = Date.now();
    // synthetic generator is in-process; "health" is just a no-op probe
    void generateSyntheticCandles("Volatility 75 Index", 5);
    return { ok: true, detail: "Synthetic generator OK", latencyMs: Date.now() - t };
  }
}

export const fallbackMarketDataProvider = new FallbackMarketDataProvider();
