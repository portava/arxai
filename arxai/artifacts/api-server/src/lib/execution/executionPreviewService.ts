// Shared per-user execution-preview gathering (Task #197 / Part 52).
//
// Gathers the real, per-user inputs the execution estimator needs — broker
// symbol spec, live quote, recent ATR, account balance/leverage, and existing
// open exposure — and runs `estimateExecutionPreview`. Every input degrades
// honestly to null when unavailable; the estimator says so and never fabricates
// a cost. This is the single source of truth used by both the live-shared
// execution-preview endpoint and the Smart Chart execution-cost overlay.
//
// Advisory / read-only: nothing here places, modifies, or gates a trade.

import { and, eq, desc, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  virtualTradingAccountsTable,
  mt5ConnectionTable,
  arxLivePositionsTable,
} from "@workspace/db/schema";
import { routeCandles, routeQuote } from "../data/marketDataRouter.js";
import { computeATR, type Candle } from "@workspace/domain/market";
import {
  estimateExecutionPreview,
  type ExecutionPreview,
  type ExecutionPreviewSide,
  type ExecutionOrderType,
} from "@workspace/domain/execution-preview";
import { getBrokerSymbolSpec } from "../mt5/brokerSymbolSpec.js";

export interface BuildExecutionPreviewParams {
  /** Broker symbol (already canonicalized by the caller where possible). */
  symbol: string;
  side: ExecutionPreviewSide;
  orderType: ExecutionOrderType;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  lots: number;
  maxSpreadPoints: number;
}

/**
 * Build the execution preview for a user's prospective trade. Per-user isolated:
 * every DB read is scoped by `userId`. All upstream reads are best-effort and
 * degrade to null on failure so the estimate stays honest.
 */
export async function buildExecutionPreviewForUser(
  userId: number,
  params: BuildExecutionPreviewParams,
): Promise<ExecutionPreview> {
  const { symbol, side, orderType, entry, stopLoss, takeProfit, lots, maxSpreadPoints } =
    params;

  // Broker truth (per-user) — point/volume bounds/trade mode. All-null when the
  // EA has not reported this symbol yet; the estimator degrades honestly.
  const brokerSpec = await getBrokerSymbolSpec(userId, symbol);

  // Live quote (best-effort) → bid/ask/age for spread + fill range.
  let bid: number | null = null;
  let ask: number | null = null;
  let quoteAgeMs: number | null = null;
  // Which venue actually priced this preview. The router may fall back across
  // providers for a DISPLAY read; that is allowed here (this surface is
  // advisory and must keep rendering), but a spread/ATR estimate sourced from
  // a venue the user is NOT executing on is misleading unless it says so.
  let quoteSource: string | null = null;
  let atrSource: string | null = null;
  try {
    const q = await routeQuote(symbol);
    if (q.ok) quoteSource = q.provenance?.providerId ?? q.primaryProvider ?? null;
    if (q.ok && q.quote) {
      bid = typeof q.quote.bid === "number" ? q.quote.bid : null;
      ask = typeof q.quote.ask === "number" ? q.quote.ask : null;
      const ts = Date.parse(q.quote.timestamp);
      quoteAgeMs = Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : null;
    }
  } catch { /* honest null quote — estimator degrades + says so */ }

  // Recent volatility (ATR, in price) from M15 candles (best-effort).
  let atrPrice: number | null = null;
  try {
    const routed = await routeCandles(symbol, "M15", 200);
    if (routed.ok) atrSource = routed.provenance?.providerId ?? routed.primaryProvider ?? null;
    const candles: Candle[] = (routed.candles ?? []).map((c) => ({
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      time: typeof c.time === "number" ? c.time : Date.parse(String(c.time)) || 0,
    }));
    if (routed.ok && candles.length >= 15) {
      const atr = computeATR(candles, 14);
      if (Number.isFinite(atr) && atr > 0) atrPrice = atr;
    }
  } catch { /* honest null ATR — slippage falls back to spread */ }

  // Account balance (per-user virtual ledger) + leverage (best-effort).
  let accountBalance: number | null = null;
  try {
    const vrows = await db.select({ bal: virtualTradingAccountsTable.virtualBalance })
      .from(virtualTradingAccountsTable)
      .where(and(
        eq(virtualTradingAccountsTable.userId, userId),
        eq(virtualTradingAccountsTable.status, "active"),
      ))
      .orderBy(desc(virtualTradingAccountsTable.updatedAt))
      .limit(1);
    if (vrows[0] && Number.isFinite(vrows[0].bal) && vrows[0].bal > 0) accountBalance = vrows[0].bal;
  } catch { /* null balance — account impact degrades honestly */ }

  let leverage: number | null = null;
  try {
    const crows = await db.select({ lev: mt5ConnectionTable.leverage })
      .from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.userId, userId))
      .limit(1);
    if (crows[0]?.lev != null && crows[0].lev > 0) leverage = crows[0].lev;
  } catch { /* null leverage — margin omitted honestly */ }

  // Existing open exposure on this symbol for this user (multi-entry awareness).
  let openExposure: Parameters<typeof estimateExecutionPreview>[0]["openExposure"] = null;
  try {
    const prows = await db.select({
      volume: arxLivePositionsTable.volume,
      side: arxLivePositionsTable.side,
    }).from(arxLivePositionsTable)
      .where(and(
        eq(arxLivePositionsTable.userId, userId),
        eq(arxLivePositionsTable.symbol, symbol),
        isNull(arxLivePositionsTable.closedAt),
      ));
    if (prows.length > 0) {
      let openLots = 0;
      const sides = new Set<string>();
      for (const p of prows) {
        if (Number.isFinite(p.volume)) openLots += p.volume ?? 0;
        if (p.side) sides.add(String(p.side).toUpperCase());
      }
      const netSide = sides.size === 1
        ? ([...sides][0] === "BUY" ? "BUY" : [...sides][0] === "SELL" ? "SELL" : null)
        : null;
      openExposure = {
        openLots: Math.round(openLots * 100) / 100,
        positionCount: prows.length,
        netSide: netSide as ExecutionPreviewSide | null,
      };
    }
  } catch { /* null exposure — multi-entry omitted honestly */ }

  const preview = estimateExecutionPreview({
    symbol,
    side,
    orderType,
    entry,
    stopLoss,
    takeProfit,
    lots,
    spec: brokerSpec.spec,
    hasBrokerTruth: brokerSpec.hasBrokerTruth,
    quote: { bid, ask, quoteAgeMs },
    atrPrice,
    slippageHistory: null, // no realised-slippage history store yet — honest fallback
    accountBalance,
    leverage,
    riskPercent: null,
    openExposure,
    maxSpreadPoints,
  });

  // Provenance honesty: name the pricing venue whenever it is not the MT5
  // bridge the user executes through. Appended as a WARNING (never a blocker)
  // — the preview stays viable, the trader just learns the estimate was priced
  // elsewhere. Costs quoted from another venue's book can differ materially.
  const foreignSources = Array.from(
    new Set(
      [quoteSource, atrSource].filter(
        (src): src is string => typeof src === "string" && src !== "mt5_broker",
      ),
    ),
  );
  if (foreignSources.length > 0) {
    return {
      ...preview,
      warnings: [
        ...preview.warnings,
        `Costs estimated from ${foreignSources.join(" + ")} data, not your execution broker's book — actual spread and fill may differ.`,
      ],
    };
  }
  return preview;
}
