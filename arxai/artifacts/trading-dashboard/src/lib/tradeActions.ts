// tradeActions — the ONE place the MT5-style order ticket and the in-trade
// SL/TP editor send an order from. Nothing here bypasses a gate: every path
// is an existing, server-gated route.
//
//   placeOrder()
//     live, one-click ON  → instant-trade router (/api/trades/instant/execute).
//                           The server re-checks the MT5 side rules, freshness
//                           and all Phase B gates; the click is the confirmation.
//     live, one-click OFF → standard live command: draft → confirm → dispatch
//                           (/api/me/live/commands). Same gates; the ticket's
//                           "Place" button is the explicit confirmation step.
//     demo                → governed demo queue (/api/me/demo-commands):
//                           PLACE_MARKET_ORDER or PLACE_PENDING_ORDER, polled to
//                           a terminal status. NOTE: the demo EA (v1.31) still
//                           answers PLACE_PENDING_ORDER with
//                           REJECTED_COMMAND_TYPE_NOT_IMPLEMENTED; the ticket
//                           says so up front instead of letting the click fail.
//
//   modifyPosition()
//     live → instant-trade router MODIFY_SL_TP (positionId + new levels).
//     demo → demo queue MODIFY_SLTP (ticket + stopLoss/takeProfit).
//
// MT5 semantics (see orderTicketRules.ts): market Buy at Ask / Sell at Bid;
// Buy Limit below Ask; Sell Limit above Bid; Buy Stop above Ask; Sell Stop
// below Bid; Stop Limit = stop then a limit leg; SL/TP on the correct side;
// expiration GTC or a specified time. The server's pendingOrderRules.ts is
// the authority; the client rules only save a round trip.
import { executeInstantTrade, type InstantTradeResponse, type InstantTradeSource } from "@/lib/instantTradeRouter";
import { runDemoCommand } from "@/lib/oneClickMode";
import { expirationIso, isPendingType, orderTypeInfo, type TicketDraft } from "@/lib/orderTicketRules";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export type TradeScope = "live" | "demo";

export type TradeActionResult = {
  ok: boolean;
  /** "sent" (live accepted), a demo terminal status, or the refusing code. */
  status: string;
  reason: string | null;
  commandId: string | null;
  /** Which route carried the order; shown in the toast so the trader knows what confirmed it. */
  via: "instant" | "standard" | "demo";
};

export const DEMO_PENDING_UNSUPPORTED_NOTE =
  "The demo terminal bridge (v1.31) does not accept pending orders yet; it answers them REJECTED_COMMAND_TYPE_NOT_IMPLEMENTED. Place pending orders on live, or use a market order on demo.";

export function demoSupportsOrderType(orderType: TicketDraft["orderType"]): boolean {
  return !isPendingType(orderType);
}

function fromInstant(res: InstantTradeResponse, via: TradeActionResult["via"]): TradeActionResult {
  return {
    ok: res.ok,
    status: res.ok ? "sent" : (res.primaryReason || res.error || "REJECTED"),
    reason: res.ok ? null : (res.primaryReason || res.error || null),
    commandId: res.commandId ?? null,
    via,
  };
}

async function json(r: Response): Promise<Record<string, unknown>> {
  try { return (await r.json()) as Record<string, unknown>; } catch { return {}; }
}

export interface PlaceOrderArgs {
  scope: TradeScope;
  symbol: string;
  draft: TicketDraft;
  source: InstantTradeSource;
  /** Live only: one-click armed → instant router; otherwise the standard draft/confirm/dispatch command. */
  oneClickOn: boolean;
  /** Demo queue attribution. */
  sourcePage?: string;
  fetchImpl?: typeof fetch;
}

export async function placeOrder(a: PlaceOrderArgs): Promise<TradeActionResult> {
  const f = a.fetchImpl ?? ((i: string, init?: RequestInit) => fetch(i, init));
  const info = orderTypeInfo(a.draft.orderType);
  const pending = info.kind !== "MARKET";
  const volume = a.draft.lot ?? 0;
  const expiration = pending ? expirationIso(a.draft) : null;
  const sourcePage = a.sourcePage ?? `ORDER_TICKET_${a.source.toUpperCase()}`;

  if (a.scope === "demo") {
    if (pending) {
      return { ok: false, status: "DEMO_PENDING_UNSUPPORTED", reason: DEMO_PENDING_UNSUPPORTED_NOTE, commandId: null, via: "demo" };
    }
    const out = await runDemoCommand(BASE, "PLACE_MARKET_ORDER", {
      symbol: a.symbol, volume, lotSize: volume, side: info.side, orderType: info.id,
      stopLoss: a.draft.stopLoss, takeProfit: a.draft.takeProfit,
      notes: null, idempotencyKey: `ticket-${a.symbol}-${info.id}-${Date.now()}`, source: sourcePage, sourcePage,
    }, { fetchImpl: f });
    return { ...out, via: "demo" };
  }

  if (a.oneClickOn) {
    const res = await executeInstantTrade({
      source: a.source, action: info.side, accountMode: "live", symbol: a.symbol, volume,
      orderType: info.id,
      price: pending ? a.draft.price : null,
      stopLimitPrice: info.kind === "STOP_LIMIT" ? a.draft.stopLimitPrice : null,
      expiration,
      stopLoss: a.draft.stopLoss, takeProfit: a.draft.takeProfit,
      oneClick: true,
    });
    return fromInstant(res, "instant");
  }

  // Standard live path: draft → confirm → dispatch. The pending fields ride in
  // `payload` (the server's EA mirror reads price / stopLimitPrice /
  // expirationEpoch from there — liveCommandPipeline.buildBridgedMt5CommandPayload).
  const headers = { "Content-Type": "application/json" };
  const expEpoch = expiration ? Math.floor(Date.parse(expiration) / 1000) : null;
  const draftRes = await f(`${BASE}/api/me/live/commands`, {
    method: "POST", credentials: "include", headers,
    body: JSON.stringify({
      commandType: pending ? "PLACE_LIVE_PENDING_ORDER" : "PLACE_LIVE_MARKET_ORDER",
      symbol: a.symbol, side: info.side, orderType: info.id,
      requestedVolume: volume, stopLoss: a.draft.stopLoss, takeProfit: a.draft.takeProfit,
      sourcePage,
      payload: pending
        ? { price: a.draft.price, stopLimitPrice: info.kind === "STOP_LIMIT" ? a.draft.stopLimitPrice : null, expiration, expirationEpoch: expEpoch }
        : {},
    }),
  });
  const d = await json(draftRes);
  const cmd = d.command as { commandId?: string } | undefined;
  if (!d.ok || !cmd?.commandId) {
    const reason = String(d.reason ?? d.error ?? d.blockReason ?? `HTTP ${draftRes.status}`);
    return { ok: false, status: reason, reason, commandId: null, via: "standard" };
  }
  const id = encodeURIComponent(cmd.commandId);
  const conf = await json(await f(`${BASE}/api/me/live/commands/${id}/confirm`, { method: "POST", credentials: "include", headers, body: "{}" }));
  if (conf.ok === false) {
    const reason = `CONFIRM_FAILED: ${conf.reason ?? conf.error ?? "unknown"}`;
    return { ok: false, status: "CONFIRM_FAILED", reason, commandId: cmd.commandId, via: "standard" };
  }
  const disp = await json(await f(`${BASE}/api/me/live/commands/${id}/dispatch`, { method: "POST", credentials: "include", headers, body: "{}" }));
  const ok = disp.ok === true;
  const reason = ok ? null : String(disp.reason ?? disp.blockReason ?? disp.primaryReason ?? disp.error ?? "BLOCKED");
  return { ok, status: ok ? "sent" : (reason ?? "BLOCKED"), reason, commandId: cmd.commandId, via: "standard" };
}

export interface ModifyPositionArgs {
  scope: TradeScope;
  ticket: string;
  symbol: string;
  side: "BUY" | "SELL" | null;
  newStopLoss: number | null;
  newTakeProfit: number | null;
  source: InstantTradeSource;
  sourcePage?: string;
  fetchImpl?: typeof fetch;
}

export async function modifyPosition(a: ModifyPositionArgs): Promise<TradeActionResult> {
  if (a.scope === "live") {
    const res = await executeInstantTrade({
      source: a.source, action: "MODIFY_SL_TP", accountMode: "live", symbol: a.symbol,
      positionId: a.ticket, newStopLoss: a.newStopLoss, newTakeProfit: a.newTakeProfit,
    });
    return fromInstant(res, "instant");
  }
  const sourcePage = a.sourcePage ?? `ORDER_TICKET_${a.source.toUpperCase()}_MODIFY`;
  const out = await runDemoCommand(BASE, "MODIFY_SLTP", {
    symbol: a.symbol, side: a.side ?? undefined,
    ticket: a.ticket, positionTicket: a.ticket, brokerTicket: a.ticket,
    stopLoss: a.newStopLoss, takeProfit: a.newTakeProfit,
    source: sourcePage, sourcePage, idempotencyKey: `ticket-modify-${a.ticket}-${Date.now()}`,
  }, { fetchImpl: a.fetchImpl ?? ((i: string, init?: RequestInit) => fetch(i, init)) });
  return { ...out, via: "demo" };
}
