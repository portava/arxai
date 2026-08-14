// Build DD — Real market data provider (placeholder adapter).
//
// SAFETY: this adapter is READ-ONLY by construction.
//   • It only ever performs HTTP GET requests against MARKET_DATA_BASE_URL.
//   • It refuses to initialize unless MARKET_DATA_MODE === "read_only".
//   • API secrets are read from process.env, never logged, never returned
//     in any response, and never stored.
//   • If credentials are missing or the network call fails, the unified
//     service falls back to the synthetic provider.
//
// Wiring a concrete vendor (Deriv WS/REST, Polygon, OANDA, etc.) is left
// for a follow-up build — this file ships the safe scaffolding so the
// service can switch sources without touching Build AA.

import type {
  MarketCandle,
  MarketDataProvider,
  MarketDataSnapshot,
  Timeframe,
} from "./types.js";

interface RealProviderConfig {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  apiSecret?: string;
  mode: "read_only" | string;
}

function loadConfig(): RealProviderConfig | null {
  const providerName = process.env.MARKET_DATA_PROVIDER?.trim();
  const baseUrl = process.env.MARKET_DATA_BASE_URL?.trim();
  const apiKey = process.env.MARKET_DATA_API_KEY?.trim();
  const apiSecret = process.env.MARKET_DATA_API_SECRET?.trim();
  const mode = (process.env.MARKET_DATA_MODE ?? "read_only").trim();
  if (!providerName || !baseUrl || !apiKey) return null;
  return { providerName, baseUrl, apiKey, apiSecret, mode };
}

export class RealMarketDataProvider implements MarketDataProvider {
  readonly name: string;
  readonly source = "REAL" as const;
  private cfg: RealProviderConfig | null;

  constructor() {
    this.cfg = loadConfig();
    this.name = this.cfg?.providerName ?? "real-unconfigured";
  }

  isConfigured(): boolean {
    if (!this.cfg) return false;
    if (this.cfg.mode !== "read_only") return false; // refuse non-read-only
    return true;
  }

  async fetch(req: { symbol: string; timeframe: Timeframe; limit: number }): Promise<MarketDataSnapshot> {
    if (!this.isConfigured()) {
      throw new Error("RealMarketDataProvider is not configured (missing env or non-read_only mode).");
    }
    const cfg = this.cfg!;
    const start = Date.now();
    // Generic GET — concrete vendor mapping is intentionally not implemented
    // here. The service falls back when this throws.
    const url = `${cfg.baseUrl.replace(/\/$/, "")}/quote?symbol=${encodeURIComponent(req.symbol)}&tf=${req.timeframe}&limit=${req.limit}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          "X-API-Key": cfg.apiKey,
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(3_000),
      });
    } catch (err) {
      throw new Error(`Real provider network error: ${String(err)}`);
    }
    if (!res.ok) throw new Error(`Real provider HTTP ${res.status}`);
    const json = (await res.json()) as {
      bid?: number; ask?: number; timestamp?: string;
      candles?: MarketCandle[];
    };
    const latencyMs = Date.now() - start;
    const bid = json.bid ?? 0;
    const ask = json.ask ?? 0;
    const mid = (bid + ask) / 2;
    const candles = json.candles ?? [];
    return {
      symbol: req.symbol,
      source: "REAL",
      provider: cfg.providerName,
      bid, ask, mid,
      spread: Math.max(0, ask - bid),
      timestamp: json.timestamp ?? new Date().toISOString(),
      timeframe: req.timeframe,
      candles,
      sessionContext: {
        sessionName: "Live",
        isMarketOpen: true,
        liquidityLevel: "NORMAL",
        volatilityLevel: "NORMAL",
      },
      dataQuality: {
        status: candles.length >= req.limit / 2 ? "GOOD" : "DEGRADED",
        latencyMs,
        candlesAvailable: candles.length,
        warnings: [],
      },
    };
  }

  async health(): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
    const t = Date.now();
    if (!this.isConfigured()) {
      return { ok: false, detail: "Real provider not configured (missing env or mode != read_only)", latencyMs: 0 };
    }
    try {
      const cfg = this.cfg!;
      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/health`, {
        method: "GET",
        headers: { "X-API-Key": cfg.apiKey },
        signal: AbortSignal.timeout(2_000),
      });
      return { ok: res.ok, detail: `HTTP ${res.status}`, latencyMs: Date.now() - t };
    } catch (err) {
      return { ok: false, detail: `Health probe failed: ${String(err)}`, latencyMs: Date.now() - t };
    }
  }
}

export const realMarketDataProvider = new RealMarketDataProvider();
