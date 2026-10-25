// Trade Action Center → the one governed pipeline (Tier 1 Trade Engine).
//
// A confirmed action is submitted to lib/tradeEngine/pipeline.ts
// (submitTrade, mode DEMO or LIVE), which hands it to its venue's governed
// queue:
//   DEMO OPEN   → demoCommandQueue draft → confirm → dispatch
//   LIVE OPEN   → liveCommandPipeline createLiveDraft → confirm → dispatch
//                 (per-user arming, kill switch, the Risk Governor, the
//                 dispatch gates; the "CONFIRM LIVE" phrase is checked by
//                 confirmAction before this runs)
//   CLOSE / PARTIAL_CLOSE / MOVE_STOP / TRAIL_STOP / MODIFY_TP_SL
//               → lib/positions/governedOps on the trader's own governed
//                 position (a position opened outside ARX is refused)
//   SIMULATED OPEN → one PAPER order through the pipeline (owner decision
//                 13): lib/tradeEngine/simulatedOpen.ts, submitTrade mode
//                 PAPER, Risk Governor venue PAPER, a real current quote,
//                 idempotent on the action id. No broker command.
//   other SIMULATED actions → no broker command, nothing booked.
// It used to write the legacy mt5_commands mailbox, which forces every row
// to BLOCKED, so DEMO and LIVE actions read "queued" and never executed.
// Owner decision 2026-10-24: Trade Action DEMO and LIVE go through the
// pipeline. Nothing here relaxes a gate; every refusal is returned as-is.

import { demoPositionLedger, demoPositionColumns } from "../positions/ledger.js";
import { and, eq } from "drizzle-orm";
import { db, sharedTradeAttributionTable } from "@workspace/db";
import { isOrderType, isPendingOrder, directionOf } from "./orderTypes.js";
import type { ActionType } from "./types.js";
import { submitTrade } from "../tradeEngine/pipeline.js";
import type { SimulatedOpenReceipt } from "../tradeEngine/simulatedOpen.js";

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
  /** Overrides the venue command's source (a caller other than the Trade Action Center). */
  sourcePage?: string;
  /** The action row id: the idempotency key of a SIMULATED open's paper order. */
  actionId?: number;
  /** Ruby / decision-engine origin for the PAPER governor intent. */
  origin?: "manual" | "ruby" | "automation";
}

export type RouteResult =
  | { ok: true; venue: "DEMO" | "LIVE" | "PAPER" | null; commandId: string | null; sent: boolean; paper?: SimulatedOpenReceipt }
  | { ok: false; venue: "DEMO" | "LIVE" | "PAPER" | null; commandId: string | null; reason: string; message?: string };

/** The source stamped on the venue command; Ruby-suggested actions keep the ruby origin. */
export function sourceFor(a: Pick<RoutableAction, "source" | "sourcePage">): string {
  if (a.sourcePage) return a.sourcePage;
  return a.source === "ai_suggested" ? TRADE_ACTION_RUBY_SOURCE : TRADE_ACTION_SOURCE;
}

export interface TradeRef { ticket: string; stopLoss: number | null; takeProfit: number | null }

/** The broker ticket (and current protection) behind a trader's trade key ("lp_<id>" | "att_<id>"), scoped to the trader. */
export async function tradeRefFor(userId: number, tradeKey: string | null): Promise<TradeRef | null> {
  if (!tradeKey) return null;
  const id = Number(tradeKey.replace(/^(lp|att)_/, ""));
  if (!Number.isInteger(id) || id <= 0) return null;
  if (tradeKey.startsWith("lp_")) {
    const [r] = await demoPositionLedger.select(
      {
        t: demoPositionColumns.brokerPositionId,
        sl: demoPositionColumns.stopLoss,
        tp: demoPositionColumns.takeProfit,
      },
      { where: and(eq(demoPositionColumns.id, id), eq(demoPositionColumns.userId, userId)), limit: 1 },
    );
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
  if (a.requestedMode === "SIMULATED" && a.actionType === "OPEN") return routeSimulatedOpen(a);
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

  // A shared-master live entry needs its virtual-account attribution written
  // before dispatch; only the shared live ticket (tradesLiveShared) does that.
  if (venue === "LIVE" && await sharedMasterRouting()) {
    return { ok: false, venue, commandId: null, reason: "SHARED_LIVE_ORDERS_USE_THE_SHARED_LIVE_TICKET" };
  }
  const r = await submitTrade({
    mode: venue, intent: "OPEN", userId: a.userId,
    symbol: a.symbol, side, lots: a.lotSize,
    pending: pending ? { orderType: orderType!, price: a.requestedPrice! } : null,
    orderType,
    stopLoss: a.stopLoss, takeProfit: a.takeProfit, sourcePage,
  });
  return r.ok
    ? { ok: true, venue, commandId: r.commandId, sent: r.sent }
    : { ok: false, venue, commandId: r.commandId, reason: r.reason };
}

/** Owner decision 13: a confirmed SIMULATED open books one PAPER order, keyed on the action id. */
async function routeSimulatedOpen(a: RoutableAction): Promise<RouteResult> {
  if (!(a.actionId && a.actionId > 0)) return { ok: false, venue: "PAPER", commandId: null, reason: "IDEMPOTENCY_KEY_REQUIRED" };
  const orderType = isOrderType(a.orderType) ? a.orderType : null;
  const side = orderType ? directionOf(orderType) : a.side;
  const { openSimulatedPaperOrder } = await import("../tradeEngine/simulatedOpen.js");
  const r = await openSimulatedPaperOrder({
    userId: a.userId, surface: "TRADE_ACTION_CENTER", requestKey: String(a.actionId),
    symbol: a.symbol, side, lots: a.lotSize, stopLoss: a.stopLoss, takeProfit: a.takeProfit,
    pending: orderType != null && isPendingOrder(orderType),
    origin: a.origin ?? "manual", intentRef: `trade_action:${a.actionId}`, sourcePage: sourceFor(a),
  });
  return r.ok
    ? { ok: true, venue: "PAPER", commandId: `paper_order:${r.receipt.paperOrderId}`, sent: false, paper: r.receipt }
    : { ok: false, venue: "PAPER", commandId: null, reason: r.reason, message: r.message };
}

async function sharedMasterRouting(): Promise<boolean> {
  const { getGlobalSettings } = await import("../adminTrading/safetyEnvelope.js");
  const g = await getGlobalSettings();
  return g?.accountRoutingMode === "SHARED_MASTER_MT5";
}

async function routePositionOp(a: RoutableAction, venue: "DEMO" | "LIVE"): Promise<RouteResult> {
  const ref = await tradeRefFor(a.userId, a.tradeKey);
  if (!ref) return { ok: false, venue, commandId: null, reason: "TRADE_NOT_FOUND" };
  const partial = a.actionType === "PARTIAL_CLOSE" && a.lotSize != null && a.lotSize > 0 ? a.lotSize : null;
  const target = { ticket: ref.ticket, lots: partial };
  const sourcePage = sourceFor(a);
  const r = a.actionType === "CLOSE" || a.actionType === "PARTIAL_CLOSE"
    ? await submitTrade({ mode: venue, intent: "CLOSE", userId: a.userId, target, sourcePage })
    // A field the action leaves empty keeps its current value (a stop move
    // never drops the target); the Risk Governor decides whether it may move.
    : await submitTrade({
      mode: venue, intent: "MODIFY", userId: a.userId, target, sourcePage,
      stopLoss: a.stopLoss ?? ref.stopLoss,
      takeProfit: a.actionType === "MODIFY_TP_SL" ? a.takeProfit ?? ref.takeProfit : ref.takeProfit,
    });
  return r.ok
    ? { ok: true, venue, commandId: r.commandId, sent: true }
    : { ok: false, venue, commandId: r.commandId, reason: r.reason ?? "REFUSED" };
}
