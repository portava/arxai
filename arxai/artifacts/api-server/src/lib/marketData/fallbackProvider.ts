// Build DD — Fallback (synthetic) market data provider.
//
// HONESTY CONTRACT (R7 step 1c). This provider INVENTS bars. It previously
// stamped its output `dataQuality.status: "GOOD"` and re-timed the quote to
// `Date.now()` — explicitly to dodge the stale blocker. Both are gone:
//
//   - status is "SYNTHETIC" (never GOOD), and computeBlockers in
//     marketDataService emits a CRITICAL blocker for it, so no decision-capable
//     consumer can act on this output;
//   - the quote timestamp is the last synthetic bar's own time — this provider
//     never claims freshness it did not observe, so the stale blocker fires
//     naturally on top of the synthetic blocker;
//   - the unified service no longer serves this provider's candles to its
//     (decision-capable) consumers at all — it returns honest-empty instead.
//     This class remains ONLY for explicitly display-labeled synthetic use and
//     for the health surface's "fallback exists" report.
//
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

export function sessionContextFor(symbol: string, candles: MarketCandle[]): SessionContext {
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

export const SYNTHETIC_DATA_WARNING =
  "SYNTHETIC data — these bars were invented in-process, not observed on any market. " +
  "Never decision-grade. Display only, clearly labeled.";

export class FallbackMarketDataProvider implements MarketDataProvider {
  readonly name = "synthetic-fallback";
  readonly source = "FALLBACK" as const;

  isConfigured(): boolean {
    return true; // always available
  }

  async fetch(req: { symbol: string; timeframe: string; limit: number }): Promise<MarketDataSnapshot> {
    const start = Date.now();
    // Explicit opt-in to the production synthetic fence: this provider IS the
    // explicitly-synthetic context, and its output is labeled SYNTHETIC +
    // blocked for decisions by computeBlockers.
    const raw = generateSyntheticCandles(req.symbol, Math.max(50, req.limit), { allowSynthetic: true });
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
      // Quote timestamp = the last synthetic bar's own time. This provider
      // observed nothing "now"; forging freshness to dodge the stale blocker
      // is exactly the dishonesty this fix removes. The stale blocker firing
      // on synthetic output is correct behavior.
      timestamp: last.time,
      timeframe: req.timeframe as MarketDataSnapshot["timeframe"],
      candles,
      sessionContext: session,
      dataQuality: {
        status: "SYNTHETIC",
        latencyMs,
        candlesAvailable: candles.length,
        warnings: [SYNTHETIC_DATA_WARNING],
      },
    };
  }

  async health(): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
    // In-process generator; no probe call needed (and the production synthetic
    // fence makes an un-opted probe throw). "ok" means only "the fallback
    // class exists" — never that its data is usable for decisions.
    return { ok: true, detail: "Synthetic generator present (SYNTHETIC-labeled, never decision-grade)", latencyMs: 0 };
  }
}

export const fallbackMarketDataProvider = new FallbackMarketDataProvider();
