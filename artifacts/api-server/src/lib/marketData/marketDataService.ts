// Build DD — Unified Market Data Service.
//
// One entry point that returns a {source, provider, bid, ask, mid, spread,
// timestamp, candles, sessionContext, dataQuality} snapshot regardless of
// where the data comes from.
//
// Selection order:
//   1. Real provider if isConfigured() AND fetch succeeds.
//   2. Fallback (synthetic) provider — always available.
//
// Computes safety blockers (missing/stale/wide-spread/extreme/closed) so
// Build AA can convert them directly into HOLD reasons. Service NEVER
// places trades, NEVER mutates safetyCore, and NEVER touches MT5 surfaces.

import { logger } from "../logger.js";
import { fallbackMarketDataProvider } from "./fallbackProvider.js";
import { realMarketDataProvider } from "./realProvider.js";
import type {
  MarketDataBlocker,
  MarketDataProvider,
  MarketDataRequest,
  MarketDataSnapshot,
  Severity,
  Timeframe,
} from "./types.js";

// Tuning constants — bounded, conservative.
const MAX_QUOTE_AGE_MS = 60_000;        // older than 60s = stale
const MAX_LATENCY_MS = 1_500;           // > 1.5s round trip = degraded
const MAX_SPREAD_PCT = 0.01;            // > 1% of mid = wide spread
const MIN_CANDLES_FOR_DECISION = 50;    // AA needs at least this many

const SUPPORTED_SYMBOLS = new Set<string>([
  "Volatility 75 Index",
  "Volatility 75 1s Index",
  "Volatility 25 1s Index",
  "Volatility 100 Index",
  "Volatility 50 Index",
  "Volatility 25 Index",
  "Volatility 10 Index",
  "Boom 1000 Index",
  "Crash 1000 Index",
]);

function isSymbolSupported(symbol: string): boolean {
  if (SUPPORTED_SYMBOLS.has(symbol)) return true;
  const s = symbol.toLowerCase();
  if (s.includes("volatility") || s.includes("boom") || s.includes("crash")) return true;
  return false;
}

function pickProvider(): MarketDataProvider {
  if (realMarketDataProvider.isConfigured()) return realMarketDataProvider;
  return fallbackMarketDataProvider;
}

export interface GetMarketDataResult {
  snapshot: MarketDataSnapshot;
  blockers: MarketDataBlocker[];
  usedFallback: boolean;
  providerError?: string;
}

export async function getMarketData(req: MarketDataRequest): Promise<GetMarketDataResult> {
  const symbol = req.symbol;
  const timeframe: Timeframe = req.timeframe ?? "M5";
  const limit = req.limit ?? 100;

  if (!isSymbolSupported(symbol)) {
    const snapshot = await fallbackMarketDataProvider.fetch({ symbol, timeframe, limit });
    snapshot.dataQuality.status = "MISSING";
    snapshot.dataQuality.warnings.push(`Symbol "${symbol}" is not in the supported list.`);
    const blockers = computeBlockers(snapshot);
    blockers.push({ blocked: true, reason: `Symbol "${symbol}" unsupported`, severity: "HIGH" });
    logRequest(symbol, snapshot, true, "symbol unsupported");
    return { snapshot, blockers, usedFallback: true, providerError: "symbol unsupported" };
  }

  const primary = pickProvider();
  let snapshot: MarketDataSnapshot;
  let usedFallback = false;
  let providerError: string | undefined;

  try {
    snapshot = await primary.fetch({ symbol, timeframe, limit });
  } catch (err) {
    providerError = String(err);
    if (primary.source !== "FALLBACK") {
      logger.warn({ symbol, provider: primary.name, err: providerError },
        "Build DD: real provider failed — falling back to synthetic");
    }
    snapshot = await fallbackMarketDataProvider.fetch({ symbol, timeframe, limit });
    usedFallback = true;
  }

  const blockers = computeBlockers(snapshot);
  logRequest(symbol, snapshot, usedFallback, providerError);
  return { snapshot, blockers, usedFallback, providerError };
}

export function computeBlockers(snap: MarketDataSnapshot): MarketDataBlocker[] {
  const out: MarketDataBlocker[] = [];

  // Missing bid/ask
  if (!Number.isFinite(snap.bid) || !Number.isFinite(snap.ask) || snap.bid <= 0 || snap.ask <= 0) {
    out.push({ blocked: true, reason: "Missing or invalid bid/ask", severity: "CRITICAL" });
  }

  // Missing candles
  if (snap.candles.length < MIN_CANDLES_FOR_DECISION) {
    out.push({
      blocked: true,
      reason: `Insufficient candles (${snap.candles.length} < ${MIN_CANDLES_FOR_DECISION})`,
      severity: "HIGH",
    });
  }

  // Stale quote
  const ageMs = Date.now() - new Date(snap.timestamp).getTime();
  if (!Number.isFinite(ageMs) || ageMs > MAX_QUOTE_AGE_MS) {
    out.push({
      blocked: true,
      reason: `Stale quote: ${Math.round(ageMs / 1000)}s old (max ${MAX_QUOTE_AGE_MS / 1000}s)`,
      severity: "HIGH",
    });
  }

  // Wide spread
  if (snap.mid > 0 && snap.spread / snap.mid > MAX_SPREAD_PCT) {
    out.push({
      blocked: true,
      reason: `Spread too wide: ${((snap.spread / snap.mid) * 100).toFixed(3)}% > ${MAX_SPREAD_PCT * 100}%`,
      severity: "HIGH",
    });
  }

  // Latency
  if (snap.dataQuality.latencyMs > MAX_LATENCY_MS) {
    out.push({
      blocked: true,
      reason: `Provider latency ${snap.dataQuality.latencyMs}ms > ${MAX_LATENCY_MS}ms`,
      severity: "MEDIUM",
    });
  }

  // Volatility extreme
  if (snap.sessionContext.volatilityLevel === "EXTREME") {
    out.push({ blocked: true, reason: "Volatility EXTREME", severity: "HIGH" });
  }

  // Market closed
  if (!snap.sessionContext.isMarketOpen) {
    out.push({ blocked: true, reason: "Market closed", severity: "HIGH" });
  }

  // Provider degraded
  if (snap.dataQuality.status === "DEGRADED") {
    out.push({ blocked: true, reason: "Market data provider DEGRADED", severity: "MEDIUM" });
  }
  if (snap.dataQuality.status === "MISSING") {
    out.push({ blocked: true, reason: "Market data MISSING", severity: "CRITICAL" });
  }

  return out;
}

function logRequest(
  symbol: string,
  snap: MarketDataSnapshot,
  usedFallback: boolean,
  providerError: string | undefined,
): void {
  logger.info({
    system: "marketData",
    symbol,
    provider: snap.provider,
    source: snap.source,
    realVsFallback: snap.source === "REAL" ? "REAL" : "FALLBACK",
    latencyMs: snap.dataQuality.latencyMs,
    candlesReturned: snap.candles.length,
    dataQualityStatus: snap.dataQuality.status,
    warnings: snap.dataQuality.warnings,
    usedFallback,
    providerError,
  }, "Build DD: market data request served");
}

export async function marketDataHealthCheck(): Promise<{
  realProvider: { name: string; configured: boolean; ok: boolean; detail: string; latencyMs: number };
  fallbackProvider: { name: string; configured: boolean; ok: boolean; detail: string; latencyMs: number };
  active: { name: string; source: string };
  envMode: string;
}> {
  const [realH, fbH] = await Promise.all([
    realMarketDataProvider.health(),
    fallbackMarketDataProvider.health(),
  ]);
  const active = pickProvider();
  return {
    realProvider: {
      name: realMarketDataProvider.name,
      configured: realMarketDataProvider.isConfigured(),
      ok: realH.ok,
      detail: realH.detail,
      latencyMs: realH.latencyMs,
    },
    fallbackProvider: {
      name: fallbackMarketDataProvider.name,
      configured: fallbackMarketDataProvider.isConfigured(),
      ok: fbH.ok,
      detail: fbH.detail,
      latencyMs: fbH.latencyMs,
    },
    active: { name: active.name, source: active.source },
    envMode: process.env.MARKET_DATA_MODE ?? "read_only",
  };
}

export function summarizeForAA(snap: MarketDataSnapshot, blockers: MarketDataBlocker[]): {
  source: string;
  provider: string;
  symbol: string;
  mid: number;
  spread: number;
  timestamp: string;
  timeframe: string;
  dataQualityStatus: string;
  candlesAvailable: number;
  volatilityLevel: string;
  liquidityLevel: string;
  warnings: string[];
  blockers: { reason: string; severity: Severity }[];
} {
  return {
    source: snap.source,
    provider: snap.provider,
    symbol: snap.symbol,
    mid: snap.mid,
    spread: snap.spread,
    timestamp: snap.timestamp,
    timeframe: snap.timeframe,
    dataQualityStatus: snap.dataQuality.status,
    candlesAvailable: snap.dataQuality.candlesAvailable,
    volatilityLevel: snap.sessionContext.volatilityLevel,
    liquidityLevel: snap.sessionContext.liquidityLevel,
    warnings: snap.dataQuality.warnings,
    blockers: blockers.filter((b) => b.blocked).map((b) => ({ reason: b.reason, severity: b.severity })),
  };
}
