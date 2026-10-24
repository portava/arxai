// Trade Action Center → the one governed pipeline (Tier 1 Trade Engine).
//
// A confirmed action becomes a command in its venue's governed queue:
//   DEMO OPEN   → demoCommandQueue draft → confirm → dispatch
//   LIVE OPEN   → liveCommandPipeline createLiveDraft → confirm → dispatch
//                 (per-user arming, kill switch, the Risk Governor, the
//                 dispatch gates; the "CONFIRM LIVE" phrase is checked by
//                 confirmAction before this runs)
//   CLOSE / PARTIAL_CLOSE / MOVE_STOP / TRAIL_STOP / MODIFY_TP_SL
//               → lib/positions/governedOps on the trader's own governed
//                 position (a position opened outside ARX is refused)
//   SIMULATED   → no broker command.
// It used to write the legacy mt5_commands mailbox, which forces every row
// to BLOCKED, so DEMO and LIVE actions read "queued" and never executed.
// Owner decision 2026-10-24: Trade Action DEMO and LIVE go through the
// pipeline. Nothing here relaxes a gate; every refusal is returned as-is.

import { and, eq } from "drizzle-orm";
import { db, livePositionsTable, sharedTradeAttributionTable } from "@workspace/db";
import { isOrderType, isPendingOrder, directionOf } from "./orderTypes.js";
import type { ActionType } from "./types.js";

export const TRADE_ACTION_SOURCE = "TRADE_ACTION_CENTER";
export const TRADE_ACTION_RUBY_SOURCE = "TRADE_ACTION_RUBY";

export interface RoutableAction {
  userId: number;
  actionType: ActionType;
  requestedMode: string;
  tradeKey: string | null;
  symbol: string;
  side: string | null;
  orderType: string | null;
  lotSize: number | null;
  requestedPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  source: string | null;
}

export type RouteResult =
  | { ok: true; venue: "DEMO" | "LIVE" | null; commandId: string | null; sent: boolean }
  | { ok: false; venue: "DEMO" | "LIVE" | null; commandId: string | null; reason: string };

/** The source stamped on the venue command; Ruby-suggested actions keep the ruby origin. */
export function sourceFor(a: Pick<RoutableAction, "source">): string {
  return a.source === "ai_suggested" ? TRADE_ACTION_RUBY_SOURCE : TRADE_ACTION_SOURCE;
}

export interface TradeRef { ticket: string; stopLoss: number | null; takeProfit: number | null }

/** The broker ticket (and current protection) behind a trader's trade key ("lp_<id>" | "att_<id>"), scoped to the trader. */
export async function tradeRefFor(userId: number, tradeKey: string | null): Promise<TradeRef | null> {
  if (!tradeKey) return null;
  const id = Number(tradeKey.replace(/^(lp|att)_/, ""));
  if (!Number.isInteger(id) || id <= 0) return null;
  if (tradeKey.startsWith("lp_")) {
    const [r] = await db.select({ t: livePositionsTable.brokerPositionId, sl: livePositionsTable.stopLoss, tp: livePositionsTable.takeProfit })
      .from(livePositionsTable).where(and(eq(livePositionsTable.id, id), eq(livePositionsTable.userId, userId))).limit(1);
    return r?.t ? { ticket: r.t, stopLoss: r.sl ?? null, takeProfit: r.tp ?? null } : null;
  }
  if (tradeKey.startsWith("att_")) {
    const [r] = await db.select({ t: sharedTradeAttributionTable.mt5PositionTicket, sl: sharedTradeAttributionTable.stopLoss, tp: sharedTradeAttributionTable.takeProfit })
      .from(sharedTradeAttributionTable).where(and(eq(sharedTradeAttributionTable.id, id), eq(sharedTradeAttributionTable.userId, userId))).limit(1);
    return r?.t ? { ticket: r.t, stopLoss: r.sl ?? null, takeProfit: r.tp ?? null } : null;
  }
  return null;
}

export async function routeConfirmedAction(a: RoutableAction): Promise<RouteResult> {
  const venue = a.requestedMode === "DEMO" || a.requestedMode === "LIVE" ? a.requestedMode : null;
  if (!venue) return { ok: true, venue: null, commandId: null, sent: false };
  if (a.actionType === "CANCEL_ORDER") return { ok: false, venue, commandId: null, reason: "CANCEL_NOT_ROUTED" };
  return a.actionType === "OPEN" ? routeOpen(a, venue) : routePositionOp(a, venue);
}

async function routeOpen(a: RoutableAction, venue: "DEMO" | "LIVE"): Promise<RouteResult> {
  const orderType = isOrderType(a.orderType) ? a.orderType : null;
  const side = orderType ? directionOf(orderType) : a.side === "BUY" || a.side === "SELL" ? a.side : null;
  if (!side) return { ok: false, venue, commandId: null, reason: "INVALID_SIDE" };
  if (!(a.lotSize != null && a.lotSize > 0)) return { ok: false, venue, commandId: null, reason: "INVALID_VOLUME" };
  const pending = orderType != null && isPendingOrder(orderType);
  if (pending && !(a.requestedPrice != null && a.requestedPrice > 0)) {
    return { ok: false, venue, commandId: null, reason: "PENDING_PRICE_REQUIRED" };
  }
  const sourcePage = sourceFor(a);

  if (venue === "DEMO") {
    const queue = await import("../mt5/demoCommandQueue.js");
    const draft = await queue.createDraftCommand({
      userId: a.userId, commandType: pending ? "PLACE_PENDING_ORDER" : "PLACE_MARKET_ORDER",
      payload: {
        symbol: a.symbol, side, lotSize: a.lotSize, stopLoss: a.stopLoss, takeProfit: a.takeProfit, sourcePage,
        ...(pending ? { orderType, price: a.requestedPrice } : {}),
      },
    });
    if (!draft.ok || !draft.command) return { ok: false, venue, commandId: null, reason: draft.reason ?? "DRAFT_REFUSED" };
    const commandId = draft.command.commandId;
    const confirmed = await queue.confirmCommand({ userId: a.userId, commandId });
    if (!confirmed.ok) return { ok: false, venue, commandId, reason: confirmed.reason ?? "CONFIRM_REFUSED" };
    if (confirmed.command?.status === "SENT_TO_MT5_DEMO") return { ok: true, venue, commandId, sent: true };
    const sent = await queue.dispatchApprovedCommand({ userId: a.userId, commandId });
    return sent.ok && sent.command?.status === "SENT_TO_MT5_DEMO"
      ? { ok: true, venue, commandId, sent: true }
      : { ok: false, venue, commandId, reason: sent.reason ?? sent.command?.status ?? "DISPATCH_REFUSED" };
  }

  const pipe = await import("../live/liveCommandPipeline.js");
  const draft = await pipe.createLiveDraft({
    userId: a.userId,
    commandType: pending ? "PLACE_LIVE_PENDING_ORDER" : "PLACE_LIVE_MARKET_ORDER",
    symbol: a.symbol, side,
    orderType: orderType ?? (side === "SELL" ? "MARKET_SELL" : "MARKET_BUY"),
    requestedVolume: a.lotSize,
    stopLoss: a.stopLoss, takeProfit: a.takeProfit,
    sourcePage,
    payload: pending ? { price: a.requestedPrice } : {},
  });
  if (!draft.ok) return { ok: false, venue, commandId: null, reason: draft.reason };
  const commandId = draft.command.commandId;
  const confirmed = await pipe.confirmLiveCommand({ userId: a.userId, commandId });
  if (!confirmed.ok) return { ok: false, venue, commandId, reason: confirmed.reason };
  const sent = await pipe.dispatchLiveCommand({ userId: a.userId, commandId });
  const status = (sent as { command?: { status?: string } }).command?.status ?? null;
  return sent.ok && status !== "LIVE_BLOCKED"
    ? { ok: true, venue, commandId, sent: true }
    : { ok: false, venue, commandId, reason: (sent as { reason?: string }).reason ?? status ?? "DISPATCH_REFUSED" };
}

async function routePositionOp(a: RoutableAction, venue: "DEMO" | "LIVE"): Promise<RouteResult> {
  const ref = await tradeRefFor(a.userId, a.tradeKey);
  if (!ref) return { ok: false, venue, commandId: null, reason: "TRADE_NOT_FOUND" };
  const ticket = ref.ticket;
  const ops = await import("../positions/governedOps.js");
  const partial = a.actionType === "PARTIAL_CLOSE" && a.lotSize != null && a.lotSize > 0 ? a.lotSize : null;
  const pos = await ops.findGovernedPosition(a.userId, ticket, partial);
  if (!pos) return { ok: false, venue, commandId: null, reason: "NOT_AN_ARX_GOVERNED_POSITION" };
  if (pos.venue !== venue) return { ok: false, venue, commandId: null, reason: `POSITION_IS_${pos.venue}` };
  const sourcePage = sourceFor(a);
  const r = a.actionType === "CLOSE" || a.actionType === "PARTIAL_CLOSE"
    ? await ops.submitGovernedClose(a.userId, pos, sourcePage)
    // A field the action leaves empty keeps its current value (a stop move
    // never drops the target); the Risk Governor decides whether it may move.
    : await ops.submitGovernedModify(a.userId, pos, a.stopLoss ?? ref.stopLoss,
      a.actionType === "MODIFY_TP_SL" ? a.takeProfit ?? ref.takeProfit : ref.takeProfit, sourcePage);
  return r.ok
    ? { ok: true, venue, commandId: r.commandId, sent: true }
    : { ok: false, venue, commandId: r.commandId, reason: r.reason ?? "REFUSED" };
}
