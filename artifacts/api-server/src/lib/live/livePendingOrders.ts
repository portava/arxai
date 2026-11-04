// Live pending orders — the user's MT5 pending orders (Buy/Sell Limit, Stop,
// Stop Limit) that ARX placed through the live pipeline.
//
// There is no EA snapshot of working pending orders yet, so this list is built
// from the command ledger (arx_live_commands): a PLACE_LIVE_PENDING_ORDER whose
// last EA result reported a broker order ticket. It is read-only and per-user.
//
// What "working" means here, and why each exclusion is honest:
//   • status LIVE_FILLED / LIVE_ACKNOWLEDGED / LIVE_PARTIALLY_FILLED with a broker
//     ticket — the EA answered the PLACE_PENDING with the order ticket
//     (mapBridgedLiveOutcome maps a ticketed PLACED to LIVE_FILLED; for a
//     pending order that means "placed at the broker", not "a position opened").
//   • NOT when a live position carries the same ticket — MT5 gives the position
//     opened by a pending order the order's ticket, so the order has filled.
//   • NOT after its own expiration time.
// Each row says the basis of its state (`stateBasis: "LAST_EA_RESULT"`) so the
// screen can say the order may since have filled, expired or been removed in
// the terminal.
import { db, arxLiveCommandsTable } from "@workspace/db";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { livePositionLedger, livePositionColumns } from "../positions/ledger.js";

import { WORKING_PENDING_STATUSES, selectWorkingPendingOrders, type LivePendingOrderView } from "./livePendingOrdersView.js";
import { MODIFY_LIVE_PENDING_ORDER, PENDING_CONTROL_COMMAND_TYPES, PENDING_CONTROL_IN_FLIGHT_STATUSES, currentPendingLevels } from "./livePendingControl.js";
export { WORKING_PENDING_STATUSES, selectWorkingPendingOrders, type LivePendingOrderView };

/** The user's working live pending orders (last 30 days of ledger rows). */
export async function listMyLivePendingOrders(userId: number, nowMs: number = Date.now()): Promise<LivePendingOrderView[]> {
  const rows = await db.select({
    commandId: arxLiveCommandsTable.commandId,
    status: arxLiveCommandsTable.status,
    symbol: arxLiveCommandsTable.symbol,
    side: arxLiveCommandsTable.side,
    orderType: arxLiveCommandsTable.orderType,
    requestedVolume: arxLiveCommandsTable.requestedVolume,
    stopLoss: arxLiveCommandsTable.stopLoss,
    takeProfit: arxLiveCommandsTable.takeProfit,
    brokerTicket: arxLiveCommandsTable.brokerTicket,
    payload: arxLiveCommandsTable.payload,
    createdAt: arxLiveCommandsTable.createdAt,
  }).from(arxLiveCommandsTable)
    .where(and(
      eq(arxLiveCommandsTable.userId, userId),
      eq(arxLiveCommandsTable.commandType, "PLACE_LIVE_PENDING_ORDER"),
      inArray(arxLiveCommandsTable.status, [...WORKING_PENDING_STATUSES]),
      isNotNull(arxLiveCommandsTable.brokerTicket),
    ))
    .orderBy(desc(arxLiveCommandsTable.id))
    .limit(200);
  const cutoff = nowMs - 30 * 24 * 3600 * 1000;
  const recent = rows.filter((r) => !r.createdAt || r.createdAt.getTime() >= cutoff);
  const tickets = [...new Set(recent.map((r) => r.brokerTicket).filter((t): t is string => !!t))];
  const positionTickets = new Set<string>();
  if (tickets.length > 0) {
    const pos = await livePositionLedger.select(
      { brokerTicket: livePositionColumns.brokerTicket },
      { where: and(eq(livePositionColumns.userId, userId), inArray(livePositionColumns.brokerTicket, tickets)) },
    );
    for (const p of pos) if (p.brokerTicket) positionTickets.add(String(p.brokerTicket));
  }
  // Cancel / modify from ARX: the latest broker-confirmed modify of each order
  // (its tracked levels) and any control still in flight.
  const ids = recent.map((r) => r.commandId);
  const latestModify = new Map<string, { price: number | null; stopLoss: number | null; takeProfit: number | null }>();
  const inFlight = new Set<string>();
  if (ids.length > 0) {
    const target = sql<string>`${arxLiveCommandsTable.payload} ->> 'targetCommandId'`;
    const controls = await db.select({
      commandType: arxLiveCommandsTable.commandType,
      status: arxLiveCommandsTable.status,
      payload: arxLiveCommandsTable.payload,
      target,
    }).from(arxLiveCommandsTable)
      .where(and(
        eq(arxLiveCommandsTable.userId, userId),
        inArray(arxLiveCommandsTable.commandType, [...PENDING_CONTROL_COMMAND_TYPES]),
        inArray(target, ids),
      ))
      .orderBy(desc(arxLiveCommandsTable.id))
      .limit(500);
    const byId = new Map(recent.map((r) => [r.commandId, r]));
    for (const c of controls) {
      if (!c.target) continue;
      if ((PENDING_CONTROL_IN_FLIGHT_STATUSES as readonly string[]).includes(c.status)) inFlight.add(c.target);
      const orig = byId.get(c.target);
      if (orig && c.commandType === MODIFY_LIVE_PENDING_ORDER && c.status === "LIVE_FILLED" && !latestModify.has(c.target)) {
        const lv = currentPendingLevels(orig, { payload: c.payload });
        latestModify.set(c.target, { price: lv.price, stopLoss: lv.stopLoss, takeProfit: lv.takeProfit });
      }
    }
  }
  return selectWorkingPendingOrders(recent, positionTickets, nowMs, { latestModify, inFlight });
}
