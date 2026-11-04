// OMS dashboard summary for one owner scope.
//
// lib/oms.ts omsDashboardSummary() reads the whole process-wide simulator
// book (every operator's orders and positions) and its list reads stop at
// 200 rows. The HTTP surfaces that show a summary to one person
// (/oms/dashboard-summary, the TESTER export) use this instead: the same
// figures over the caller's own rows only, uncapped. An empty scope
// ({}) is the whole book and is for operators only, labeled as such.

import { listOrders, listPositions, getOrder, type OmsOwnerScope } from "./oms.js";

export type OmsSummaryScope = "own_simulator_book" | "platform_all_users";

export const OMS_SCOPE_NOTE: Record<OmsSummaryScope, string> = {
  own_simulator_book: "Your own simulator orders and positions only. Other users' simulator activity is not included. Simulator only, not a broker account.",
  platform_all_users: "The whole simulator book: every user's simulator orders and positions on this server. Simulator only, not a broker account.",
};

const ALL = Number.POSITIVE_INFINITY;

export function omsDashboardSummaryFor(scope: OmsOwnerScope) {
  const rows = listPositions({ ...scope, limit: ALL });
  const open = rows.filter((p) => p.status === "OPEN");
  const closed = rows.filter((p) => p.status !== "OPEN");
  const today = new Date().toISOString().slice(0, 10);
  const closedToday = closed.filter((p) => (p.closedAt ?? p.openedAt).slice(0, 10) === today);
  const best = closedToday.reduce<(typeof closed)[number] | null>((acc, p) => (!acc || p.realizedPnL > acc.realizedPnL) ? p : acc, null);
  const worst = closedToday.reduce<(typeof closed)[number] | null>((acc, p) => (!acc || p.realizedPnL < acc.realizedPnL) ? p : acc, null);
  const ownOrders = listOrders({ ...scope, limit: ALL });
  const sourceOf = (orderId: string) => getOrder(orderId)?.source;
  return {
    openPositions: open.length,
    pendingOrders: ownOrders.filter((o) => o.status === "APPROVED_FOR_SIMULATION" || o.status === "PENDING_MT5_CONNECTION").length,
    todayPnL: Number(closedToday.reduce((a, b) => a + b.realizedPnL, 0).toFixed(2)),
    bestTradeToday: best ? { symbol: best.symbol, pnl: best.realizedPnL } : null,
    worstTradeToday: worst ? { symbol: worst.symbol, pnl: worst.realizedPnL } : null,
    pendingMt5Intents: ownOrders.filter((o) => o.status === "PENDING_MT5_CONNECTION").length,
    aiVsManual: {
      ai: closed.filter((p) => { const s = sourceOf(p.orderId); return s === "AI_ASSIST" || s === "AI_AUTO"; }).reduce((a, b) => a + b.realizedPnL, 0),
      manual: closed.filter((p) => sourceOf(p.orderId) === "MANUAL").reduce((a, b) => a + b.realizedPnL, 0),
    },
    orderSystemStatus: "RUNNING" as const,
    dataSource: "SIMULATOR" as const,
  };
}
