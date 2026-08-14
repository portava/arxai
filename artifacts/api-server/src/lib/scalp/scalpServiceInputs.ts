// Ruby Scalp — shared live-input loaders.
//
// These gather the per-user, real-market inputs the flame read + engine need.
// Extracted so BOTH the entry surface (scalpService) and the manage surface
// (scalpManageService) read inputs identically.
//
// SAFETY:
//  - Per-user isolation: specs + execution + account are read scoped by userId.
//  - No fabrication: candles/prices are real or null (caller reads blind).

import { db, arxSymbolSpecsTable, mt5ConnectionTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { routeQuote, routeCandles } from "../data/marketDataRouter.js";
import { getUserAllocationView } from "../live/masterBridgePool.js";
import { getSymbolInfo } from "../../brain/symbols/symbolRegistry.js";
import type {
  ScalpAccountInput,
  ScalpCandle,
  ScalpExecutionInput,
  ScalpSpecInput,
} from "./scalpTypes.js";

/** Timeframe used for scalp reads. Short structure, fast refresh. */
export const SCALP_TIMEFRAME = "M5";
/** Candle window length for the flame read. Enough for stage/runway/decay. */
export const SCALP_CANDLE_LIMIT = 60;

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Read per-user broker symbol truth straight from arx_symbol_specs. */
export async function loadSpecInput(userId: number, symbol: string): Promise<ScalpSpecInput> {
  const rows = await db.select().from(arxSymbolSpecsTable)
    .where(and(eq(arxSymbolSpecsTable.userId, userId), eq(arxSymbolSpecsTable.symbol, symbol)))
    .limit(1);
  const row = rows[0];
  const registry = getSymbolInfo(symbol) ?? null;
  if (!row) {
    return {
      hasBrokerTruth: false,
      tradeMode: null, tradeAllowed: null, visible: null, marketOpen: null,
      digits: null, point: null, minLot: null, maxLot: null, lotStep: null,
      contractSize: null, tickSize: null, tickValue: null,
      stopsLevelPoints: null, spreadPoints: null,
      category: registry?.category ?? null,
      displayName: registry?.displayName ?? symbol,
    };
  }
  return {
    hasBrokerTruth: true,
    tradeMode: row.tradeMode ?? null,
    tradeAllowed: row.tradeAllowed ?? null,
    visible: row.visible ?? null,
    marketOpen: row.marketOpen ?? null,
    digits: num(row.digits) ? row.digits : null,
    point: num(row.point) ? row.point : null,
    minLot: num(row.minVolume) ? row.minVolume : null,
    maxLot: num(row.maxVolume) ? row.maxVolume : null,
    lotStep: num(row.volumeStep) ? row.volumeStep : null,
    contractSize: num(row.contractSize) ? row.contractSize : null,
    tickSize: num(row.tickSize) ? row.tickSize : null,
    tickValue: num(row.tickValue) ? row.tickValue : null,
    stopsLevelPoints: num(row.stopsLevelPoints) ? row.stopsLevelPoints : null,
    spreadPoints: num(row.spreadPoints) ? row.spreadPoints : null,
    category: row.category ?? registry?.category ?? null,
    displayName: row.displaySymbol ?? registry?.displayName ?? symbol,
  };
}

/** Map the per-user shared-live allocation into the engine's account shape. */
export async function loadAccountInput(userId: number): Promise<ScalpAccountInput> {
  try {
    const view = await getUserAllocationView(userId);
    return {
      balance: num(view.assignedAllocation) ? view.assignedAllocation : null,
      equity: num(view.assignedAllocation) ? view.assignedAllocation : null,
      freeMargin: num(view.availableAllocation) ? view.availableAllocation : null,
      leverage: null,
    };
  } catch {
    return { balance: null, equity: null, freeMargin: null, leverage: null };
  }
}

/**
 * Live OHLC window for the flame read. Real candles only — on any miss/empty
 * we return null and the caller reads blind (honest NONE), never fabricated.
 */
export async function candleWindowFor(symbol: string): Promise<ScalpCandle[] | null> {
  try {
    const res = await routeCandles(symbol, SCALP_TIMEFRAME, SCALP_CANDLE_LIMIT);
    if (!res.ok || !Array.isArray(res.candles) || res.candles.length === 0) return null;
    const mapped: ScalpCandle[] = [];
    for (const c of res.candles) {
      if (num(c.open) && num(c.high) && num(c.low) && num(c.close)) {
        mapped.push({
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: num(c.volume) ? c.volume : null,
        });
      }
    }
    return mapped.length ? mapped : null;
  } catch {
    return null;
  }
}

/**
 * Per-user execution-quality signals from the user's MT5 bridge heartbeat.
 * Scoped by userId. Null heartbeat → unknown (engine treats as no-signal),
 * never assumed healthy.
 */
export async function loadExecutionInput(userId: number): Promise<ScalpExecutionInput | null> {
  try {
    const rows = await db.select({ lastHeartbeat: mt5ConnectionTable.lastHeartbeat })
      .from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.userId, userId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const ts = row.lastHeartbeat ? new Date(row.lastHeartbeat).getTime() : null;
    if (ts === null || !Number.isFinite(ts)) {
      return { heartbeatAgeSeconds: null, bridgeConnected: false };
    }
    const ageSeconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
    return {
      heartbeatAgeSeconds: ageSeconds,
      bridgeConnected: ageSeconds <= 60,
    };
  } catch {
    return null;
  }
}

/** Live current price for a symbol (last trade or bid/ask mid). Null on miss. */
export async function currentPriceFor(symbol: string): Promise<number | null> {
  try {
    const q = await routeQuote(symbol);
    const quote = q.quote;
    if (!quote) return null;
    if (num(quote.last) && quote.last > 0) return quote.last;
    if (num(quote.bid) && num(quote.ask) && quote.bid > 0 && quote.ask > 0) {
      return (quote.bid + quote.ask) / 2;
    }
    if (num(quote.bid) && quote.bid > 0) return quote.bid;
    if (num(quote.ask) && quote.ask > 0) return quote.ask;
    return null;
  } catch {
    return null;
  }
}

/**
 * Cheap higher-timeframe directional bias from the candle window's own drift
 * (no extra provider call). Null when there's not enough real data to be honest.
 */
export function deriveHtfBias(candles: ScalpCandle[] | null): "bullish" | "bearish" | "neutral" | null {
  if (!candles || candles.length < 20) return null;
  const recent = candles.slice(-10);
  const older = candles.slice(0, 10);
  const avg = (cs: ScalpCandle[]) => cs.reduce((s, c) => s + c.close, 0) / cs.length;
  const recentAvg = avg(recent);
  const olderAvg = avg(older);
  if (!Number.isFinite(recentAvg) || !Number.isFinite(olderAvg) || olderAvg === 0) return null;
  const driftPct = ((recentAvg - olderAvg) / olderAvg) * 100;
  if (driftPct > 0.05) return "bullish";
  if (driftPct < -0.05) return "bearish";
  return "neutral";
}
