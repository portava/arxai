// positionActions — close / reverse an OPEN position on the account it lives on.
//
// Every chart surface lists live AND demo positions side by side
// (/api/me/positions/all returns both). A row's `scope` decides the route —
// never the session's account mode:
//
//   live → instant-trade router /api/trades/instant/close (positionId, and
//          closeVolume for a partial close). Reduce-only; every server gate runs.
//   demo → governed demo queue CLOSE_POSITION (brokerTicket + volume), run to a
//          terminal status. The instant router refuses accountMode "demo"
//          (UNSUPPORTED_ACCOUNT_MODE_FOR_INSTANT_LIVE), so demo rows never go there.
//
// SL/TP changes use tradeActions.modifyPosition, which already splits by scope.
import { executeInstantTrade, type InstantTradeResponse, type InstantTradeSource } from "@/lib/instantTradeRouter";
import { runDemoCommand } from "@/lib/oneClickMode";
import type { TradeActionResult, TradeScope } from "@/lib/tradeActions";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function fromInstant(res: InstantTradeResponse): TradeActionResult {
  return {
    ok: res.ok,
    status: res.ok ? "sent" : (res.primaryReason || res.error || "REJECTED"),
    reason: res.ok ? null : (res.primaryReason || res.error || null),
    commandId: res.commandId ?? null,
    via: "instant",
  };
}

export interface ClosePositionArgs {
  scope: TradeScope;
  ticket: string;
  symbol: string;
  side: "BUY" | "SELL" | null;
  /** The position's full size (demo needs it for a full close). */
  positionVolume: number | null;
  /** Partial close: lots to close (already rounded to the symbol's step). Absent = full close. */
  closeVolume?: number | null;
  source: InstantTradeSource;
  sourcePage?: string;
  /** Stable key for a retried close (demo queue attribution). */
  idempotencyKey?: string;
  fetchImpl?: FetchLike;
  /** Demo poll tuning (tests). */
  demoPoll?: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> };
}

export async function closePositionByScope(a: ClosePositionArgs): Promise<TradeActionResult> {
  const partial = typeof a.closeVolume === "number" && a.closeVolume > 0
    && (a.positionVolume == null || a.closeVolume < a.positionVolume);
  if (a.scope === "live") {
    const res = await executeInstantTrade({
      source: a.source, action: "CLOSE", accountMode: "live", positionId: a.ticket,
      ...(partial ? { closeVolume: a.closeVolume! } : {}),
      oneClick: true,
    });
    return fromInstant(res);
  }
  const sourcePage = a.sourcePage ?? `${a.source.toUpperCase()}_${partial ? "PARTIAL_CLOSE" : "CLOSE"}`;
  const volume = partial ? a.closeVolume! : a.positionVolume ?? undefined;
  const out = await runDemoCommand(BASE, "CLOSE_POSITION", {
    symbol: a.symbol, side: a.side ?? undefined, volume, lotSize: volume,
    brokerTicket: a.ticket, ticket: a.ticket, positionTicket: a.ticket,
    source: sourcePage, sourcePage,
    idempotencyKey: a.idempotencyKey ?? `close-${a.ticket}-${Date.now()}`,
  }, { fetchImpl: a.fetchImpl, ...(a.demoPoll ?? {}) });
  return { ...out, via: "demo" };
}

export interface OpenMarketArgs {
  scope: TradeScope;
  symbol: string;
  side: "BUY" | "SELL";
  volume: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  source: InstantTradeSource;
  sourcePage?: string;
  fetchImpl?: FetchLike;
  demoPoll?: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> };
}

/**
 * A market order on the given account, one click (used by Reverse's second leg).
 * Live goes through the instant router with oneClick:true, so it is refused
 * with LIVE_ONE_CLICK_DISABLED unless one-click is on — the caller says so.
 */
export async function openMarketByScope(a: OpenMarketArgs): Promise<TradeActionResult> {
  const orderType = a.side === "BUY" ? "MARKET_BUY" : "MARKET_SELL";
  if (a.scope === "live") {
    const res = await executeInstantTrade({
      source: a.source, action: a.side, accountMode: "live", symbol: a.symbol, volume: a.volume,
      orderType, stopLoss: a.stopLoss ?? null, takeProfit: a.takeProfit ?? null, oneClick: true,
    });
    return fromInstant(res);
  }
  const sourcePage = a.sourcePage ?? `${a.source.toUpperCase()}_OPEN`;
  const out = await runDemoCommand(BASE, "PLACE_MARKET_ORDER", {
    symbol: a.symbol, volume: a.volume, lotSize: a.volume, side: a.side, orderType,
    stopLoss: a.stopLoss ?? null, takeProfit: a.takeProfit ?? null, notes: null,
    idempotencyKey: `${a.source}-${a.symbol}-${a.side}-${Date.now()}`, source: sourcePage, sourcePage,
  }, { fetchImpl: a.fetchImpl, ...(a.demoPoll ?? {}) });
  return { ...out, via: "demo" };
}
