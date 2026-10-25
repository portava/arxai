// Confirmed SIMULATED opens → PAPER orders (owner decision 13, 2026-10-25).
//
// The Trade Action Center and My Trades used to record a confirmed SIMULATED
// open without booking anything. A confirmed SIMULATED open now books ONE
// PAPER order through the Trade Engine pipeline (submitTrade, mode PAPER),
// which runs the pre-trade Risk Governor (venue PAPER) before it books. This
// module is the one place both surfaces call; it never reaches a broker.
//
// Rules, in order:
//   1. explicit and well-formed: BUY/SELL, positive size, a stop AND a target
//      (a paper order carries both), market only — a pending order would be
//      "filled" at a price the market never traded, so it is refused;
//   2. retry-safe: one order per (user, request key). A repeat of the same
//      confirm returns the order it already booked (replayed), before any
//      price read or governor decision, so a retry never books twice;
//   3. the trader's own active paper account (never created implicitly);
//   4. valid price provenance: a REAL market quote with no CRITICAL/HIGH
//      market-data blocker (missing, stale, synthetic, closed market, …). No
//      quote → refused. The fill is the quote's ask (BUY) or bid (SELL) at
//      its observation time; no fill is ever fabricated or back-dated;
//   5. the pipeline's PAPER venue: Risk Governor, SL/TP geometry, the book.
//
// Previews and drafts never reach this module; only a confirmed action does.

import { and, desc, eq } from "drizzle-orm";
import { db, paperAccountsTable } from "@workspace/db";
import { getMarketData } from "../marketData/marketDataService.js";
import type { IntentOrigin } from "../riskGovernor/preTrade.js";
import { submitTrade } from "./pipeline.js";
import { MARKET_PRICED_SIMULATED_OPEN, paperOrderByRequestKey, type PaperOrderRow } from "./paperVenue.js";

export const SIMULATED_MODE = "SIMULATED" as const;
export const SIMULATED_VENUE = "PAPER" as const;
export const SIMULATED_LABEL = "Simulated — a paper order in your paper account. No broker order was sent.";

export type SimulatedSurface = "TRADE_ACTION_CENTER" | "MY_TRADES";
const KEY_PREFIX: Record<SimulatedSurface, string> = { TRADE_ACTION_CENTER: "trade_action", MY_TRADES: "my_trades" };

/** The stored idempotency key of a surface's request key. */
export function simulatedRequestKey(surface: SimulatedSurface, key: string): string {
  return `${KEY_PREFIX[surface]}:${key}`;
}

export interface SimulatedOpenRequest {
  userId: number;
  surface: SimulatedSurface;
  /** The surface's own idempotency key (Trade Action Center: the action id; My Trades: the client key). */
  requestKey: string;
  symbol: string;
  side: string | null;
  lots: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** True for a pending order type (BUY_LIMIT, …): refused. */
  pending?: boolean;
  origin?: IntentOrigin;
  /** The surface's own in-flight row (Trade Action Center: "trade_action:<id>"), excluded from the duplicate scan. */
  intentRef?: string;
  sourcePage: string;
}

export interface SimulatedOpenReceipt {
  mode: typeof SIMULATED_MODE;
  venue: typeof SIMULATED_VENUE;
  label: string;
  paperOrderId: number;
  paperAccountId: number;
  symbol: string;
  side: string;
  lots: number;
  fillPrice: number;
  stopLoss: number;
  takeProfit: number;
  /** Where the fill price came from ("REAL:<provider>") and when it was observed. */
  priceSource: string | null;
  quoteAt: string | null;
  /** True when this request key had already booked the order (nothing new was booked). */
  replayed: boolean;
}

export type SimulatedOpenResult =
  | { ok: true; receipt: SimulatedOpenReceipt }
  | { ok: false; mode: typeof SIMULATED_MODE; venue: typeof SIMULATED_VENUE; reason: string; message: string;
      detail?: { primaryReason?: string | null; blockedBy?: string[]; auditEventId?: number | null; priceBlockers?: string[] } };

const refuse = (reason: string, message: string, detail?: Extract<SimulatedOpenResult, { ok: false }>["detail"]): SimulatedOpenResult =>
  ({ ok: false, mode: SIMULATED_MODE, venue: SIMULATED_VENUE, reason, message, ...(detail ? { detail } : {}) });

function receipt(order: PaperOrderRow, replayed: boolean, quote: { source: string; at: Date } | null): SimulatedOpenReceipt {
  return {
    mode: SIMULATED_MODE, venue: SIMULATED_VENUE, label: SIMULATED_LABEL,
    paperOrderId: order.id, paperAccountId: order.paperAccountId,
    symbol: order.symbol, side: order.direction, lots: order.lotSize, fillPrice: order.entryPrice,
    stopLoss: order.stopLoss, takeProfit: order.takeProfit,
    priceSource: quote?.source ?? null, quoteAt: quote?.at.toISOString() ?? null,
    replayed,
  };
}

/** The trader's active paper account (most recent), or null. Never creates one. */
async function activePaperAccount(userId: number): Promise<number | null> {
  const [row] = await db.select({ id: paperAccountsTable.id }).from(paperAccountsTable)
    .where(and(eq(paperAccountsTable.userId, userId), eq(paperAccountsTable.isActive, 1)))
    .orderBy(desc(paperAccountsTable.createdAt)).limit(1);
  return row?.id ?? null;
}

/** A current, real quote for the symbol, or the reasons there is none. */
export async function currentQuote(symbol: string): Promise<
  { ok: true; bid: number; ask: number; at: Date; source: string } | { ok: false; reasons: string[] }
> {
  let md: Awaited<ReturnType<typeof getMarketData>>;
  try {
    md = await getMarketData({ symbol, timeframe: "M5", limit: 100 });
  } catch (err) {
    return { ok: false, reasons: [`market data unavailable: ${String(err).slice(0, 120)}`] };
  }
  const { snapshot, blockers } = md;
  const reasons = blockers.filter((b) => b.blocked && (b.severity === "CRITICAL" || b.severity === "HIGH")).map((b) => b.reason);
  const at = new Date(snapshot.timestamp);
  if (snapshot.source !== "REAL") reasons.push(`price source is ${snapshot.source}, not a real provider`);
  if (!Number.isFinite(snapshot.bid) || !Number.isFinite(snapshot.ask) || snapshot.bid <= 0 || snapshot.ask <= 0) reasons.push("no valid bid/ask");
  if (!Number.isFinite(at.getTime())) reasons.push("quote has no valid observation time");
  if (reasons.length) return { ok: false, reasons: [...new Set(reasons)] };
  return { ok: true, bid: snapshot.bid, ask: snapshot.ask, at, source: `${snapshot.source}:${snapshot.provider}` };
}

/** Book a confirmed SIMULATED open as one PAPER order through the pipeline. */
export async function openSimulatedPaperOrder(r: SimulatedOpenRequest): Promise<SimulatedOpenResult> {
  if (r.side !== "BUY" && r.side !== "SELL") return refuse("INVALID_SIDE", "A simulated open needs a BUY or SELL side.");
  if (!(r.lots != null && Number.isFinite(r.lots) && r.lots > 0)) return refuse("INVALID_VOLUME", "A simulated open needs a positive size.");
  if (r.pending) {
    return refuse("SIMULATED_PENDING_NOT_SUPPORTED",
      "Simulated pending orders are not supported: a paper fill at a price the market has not traded would be fabricated. Use a market order.");
  }
  if (!(r.stopLoss != null && r.stopLoss > 0 && r.takeProfit != null && r.takeProfit > 0)) {
    return refuse("SIMULATED_REQUIRES_STOP_AND_TARGET", "A simulated open needs both a stop loss and a take profit.");
  }
  if (!r.requestKey) return refuse("IDEMPOTENCY_KEY_REQUIRED", "A simulated open needs a request key so a retry cannot book twice.");
  const key = simulatedRequestKey(r.surface, r.requestKey);

  // Retry-safe: the same request key returns the order it already booked.
  const prior = await paperOrderByRequestKey(r.userId, key);
  if (prior) return { ok: true, receipt: receipt(prior, true, null) };

  const paperAccountId = await activePaperAccount(r.userId);
  if (paperAccountId == null) {
    return refuse("NO_ACTIVE_PAPER_ACCOUNT", "You have no active paper account. Create one on the Paper Trading page, then confirm again.");
  }

  const quote = await currentQuote(r.symbol);
  if (!quote.ok) {
    return refuse("NO_VALID_PRICE_SOURCE",
      `No valid current price for ${r.symbol}, so no simulated fill was made: ${quote.reasons.join("; ")}.`,
      { priceBlockers: quote.reasons });
  }

  const res = await submitTrade({
    mode: "PAPER", intent: "OPEN", userId: r.userId, paperAccountId,
    symbol: r.symbol, side: r.side, lots: r.lots, orderType: "MARKET", entryPrice: null,
    stopLoss: r.stopLoss, takeProfit: r.takeProfit,
    strategyId: MARKET_PRICED_SIMULATED_OPEN,
    sourcePage: r.sourcePage,
    origin: r.origin ?? "manual",
    quote: { bid: quote.bid, ask: quote.ask, at: quote.at, source: quote.source },
    clientRequestKey: key,
    ...(r.intentRef ? { intentRef: r.intentRef } : {}),
  });
  if (!res.ok) {
    const message = res.reason === "RISK_GOVERNOR_BLOCK"
      ? `The Risk Governor refused this simulated order${res.detail?.primaryReason ? `: ${res.detail.primaryReason}` : "."}`
      : res.reason === "INVALID_SLTP_GEOMETRY"
        ? `The stop and target are on the wrong side of the fill price${res.detail?.entryPrice != null ? ` ${res.detail.entryPrice}` : ""}.`
        : `The paper venue refused this simulated order (${res.reason}).`;
    return refuse(res.reason, message, res.detail);
  }
  if (!res.paperOrder) return refuse("PAPER_ORDER_NOT_BOOKED", "The paper venue booked no order.");
  return { ok: true, receipt: receipt(res.paperOrder, res.replayed === true, res.replayed ? null : quote) };
}
