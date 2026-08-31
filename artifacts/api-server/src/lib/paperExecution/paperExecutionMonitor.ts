// Build EE — Paper Execution Monitor.
//
// SAFETY (strict freeze): READ-ONLY for market data; never calls live broker.
// Manually-triggered (no infinite loops). For each open paper trade:
//   1. Fetch DD market data
//   2. Compute unrealized P&L
//   3. If SL or TP crossed → close paper order + sync paper_executions row
//   4. Trigger Build BB auto-debrief (existing runAutoDebrief)
//
// All state-mutations are scoped to paper_orders + paper_executions + paper_trade_events.
// Live execution surfaces are NEVER touched.

import {
  db,
  paperOrdersTable,
  paperExecutionsTable,
  paperTradeEventsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "../logger.js";
import { getMarketData } from "../marketData/marketDataService.js";
import { runAutoDebrief } from "../autoDebriefService.js";
import { linkTradeToActiveSession, usdToCents, closeResultForPnl } from "../paperSession/manager.js";

const SIMULATED_TAG = "Simulated — paper trading does not guarantee live results.";

// Exported: the trading-cockpit summary prices open paper trades at read time
// with this exact formula, so the two surfaces can never disagree on scale.
//
// P&L UNIT: "sim points" — dir × (current − entry) × lotSize × 100,
// symbol-blind. The fixed ×100 corresponds to no real currency amount for ANY
// instrument (no contract size, pip value, or per-symbol scaling), so every
// surface that renders this figure must label it sim pts, never dollars/cents.
export function unrealizedPnl(direction: string, lotSize: number, entry: number, current: number): number {
  const dir = direction === "BUY" ? 1 : -1;
  return dir * (current - entry) * lotSize * 100;
}

function detectHit(direction: string, current: number, sl: number, tp: number): "TP" | "SL" | null {
  if (direction === "BUY") {
    if (current <= sl) return "SL";
    if (current >= tp) return "TP";
  } else {
    if (current >= sl) return "SL";
    if (current <= tp) return "TP";
  }
  return null;
}

export interface MonitorSummary {
  scanned: number;
  closed: number;
  stillOpen: number;
  closures: Array<{
    paperOrderId: number;
    decisionId: number | null;
    symbol: string;
    direction: string;
    hit: "TP" | "SL";
    exitPrice: number;
    pnl: number;
    bbStatus?: string;
    bbDebriefId?: number;
  }>;
  updates: Array<{
    paperOrderId: number;
    decisionId: number | null;
    symbol: string;
    currentPrice: number;
    unrealizedPnl: number;
    mdSource: string;
    mdQuality: string;
  }>;
  warnings: string[];
}

export async function runPaperMonitor(opts?: {
  forcePrice?: number; // test-only: override DD price to force TP/SL
  forceSymbol?: string;
}): Promise<MonitorSummary> {
  const log = logger.child({ system: "paperExecutionMonitor" });
  const summary: MonitorSummary = { scanned: 0, closed: 0, stillOpen: 0, closures: [], updates: [], warnings: [] };

  // Pull all open paper orders (across accounts).
  const openOrders = await db.select().from(paperOrdersTable)
    .where(eq(paperOrdersTable.status, "OPEN"));

  for (const order of openOrders) {
    summary.scanned++;
    let currentPrice: number;
    let mdSource = "FALLBACK";
    let mdQuality = "GOOD";
    try {
      if (opts?.forcePrice != null && (!opts.forceSymbol || opts.forceSymbol === order.symbol)) {
        currentPrice = opts.forcePrice;
        mdSource = "FORCED";
      } else {
        const { snapshot } = await getMarketData({ symbol: order.symbol, timeframe: "M5", limit: 100 });
        currentPrice = snapshot.mid;
        mdSource = snapshot.source;
        mdQuality = snapshot.dataQuality.status;
      }
    } catch (err) {
      summary.warnings.push(`order=${order.id}: market data failed (${String(err).slice(0, 120)})`);
      log.warn({ err: String(err), orderId: order.id }, "Build EE monitor: market data fetch failed");
      continue;
    }

    const hit = detectHit(order.direction, currentPrice, order.stopLoss, order.takeProfit);
    const u = unrealizedPnl(order.direction, order.lotSize, order.entryPrice, currentPrice);
    summary.updates.push({
      paperOrderId: order.id, decisionId: order.decisionId,
      symbol: order.symbol, currentPrice: Number(currentPrice.toFixed(5)),
      unrealizedPnl: Number(u.toFixed(2)), mdSource, mdQuality,
    });

    if (!hit) { summary.stillOpen++; continue; }

    // FILL MODEL (same contract as SIMULATED_FILL_ASSUMPTIONS.gapRisk in
    // @workspace/domain/profit-mission): a stop or target is modelled as
    // filling EXACTLY at its level. Gap risk and slippage are NOT modelled —
    // when `currentPrice` has already run past the level, a real fill would be
    // worse than this one, so realized P&L here is an optimistic bound, not a
    // measured outcome. Every surface that totals these rows must say so; the
    // cockpit does it via TodayPerformance.fillModel.
    const exitPrice = hit === "SL" ? order.stopLoss : order.takeProfit;
    const realized = unrealizedPnl(order.direction, order.lotSize, order.entryPrice, exitPrice);
    const status = hit === "SL" ? "CLOSED_SL" : "CLOSED_TP";

    // Close the paper order (Build Q table).
    await db.update(paperOrdersTable).set({
      status, closedAt: new Date(), exitPrice, profitLoss: realized, updatedAt: new Date(),
    }).where(eq(paperOrdersTable.id, order.id));

    await db.insert(paperTradeEventsTable).values({
      paperOrderId: order.id, eventType: status,
      message: `${SIMULATED_TAG} EE-monitor ${hit} hit at ${exitPrice.toFixed(5)}, P&L ${realized.toFixed(2)} sim pts`,
    }).catch(() => {});

    // Session accounting (Build PP): record this close against the owner's
    // ACTIVE paper session so the session Net P&L / closed counters and the
    // session loss-limit guard track real closes. Orders with no user_id
    // (legacy sandbox rows placed with no authenticated caller) cannot be
    // attributed to a session and are honestly left uncounted.
    if (order.userId != null) {
      await linkTradeToActiveSession(order.userId, {
        tradeId: String(order.id),
        decisionId: order.decisionId != null ? String(order.decisionId) : undefined,
        symbol: order.symbol,
        action: "CLOSE",
        result: closeResultForPnl(realized),
        pnl: usdToCents(realized),
      });
    }

    // Sync paper_executions row (if one exists for this decision_id).
    if (order.decisionId != null) {
      const eeStatus = hit === "TP" ? "PAPER_CLOSED_WIN"
                     : (realized < 0 ? "PAPER_CLOSED_LOSS" : "PAPER_CLOSED_BREAK_EVEN");
      await db.update(paperExecutionsTable)
        .set({ status: eeStatus, updatedAt: new Date() })
        .where(and(
          eq(paperExecutionsTable.decisionId, order.decisionId),
          eq(paperExecutionsTable.orderId, order.id),
        ))
        .catch((err) => log.warn({ err: String(err) }, "EE monitor: paper_executions sync failed (non-fatal)"));
    }

    // Trigger Build BB.
    let bbStatus: string | undefined;
    let bbDebriefId: number | undefined;
    try {
      const bb = await runAutoDebrief(order.id, { triggeredBy: "build_ee_monitor" });
      bbStatus = bb.status;
      bbDebriefId = bb.debriefId;
      log.info({ orderId: order.id, bbStatus, bbDebriefId }, "Build EE monitor: BB auto-debrief triggered");
    } catch (err) {
      summary.warnings.push(`order=${order.id}: BB trigger failed (${String(err).slice(0, 120)})`);
      log.warn({ err: String(err), orderId: order.id }, "Build EE monitor: BB trigger failed");
    }

    summary.closed++;
    summary.closures.push({
      paperOrderId: order.id, decisionId: order.decisionId,
      symbol: order.symbol, direction: order.direction,
      hit, exitPrice: Number(exitPrice.toFixed(5)), pnl: Number(realized.toFixed(2)),
      bbStatus, bbDebriefId,
    });
  }

  log.info({ scanned: summary.scanned, closed: summary.closed, stillOpen: summary.stillOpen },
    "Build EE monitor complete");
  return summary;
}

export async function closePaperManually(orderId: number, opts?: { exitPrice?: number }) {
  const log = logger.child({ system: "paperExecutionMonitor", orderId });
  const order = (await db.select().from(paperOrdersTable)
    .where(eq(paperOrdersTable.id, orderId)).limit(1))[0];
  if (!order) return { ok: false, error: "Paper order not found" };
  if (order.status !== "OPEN") return { ok: false, error: `Order not open (status=${order.status})` };

  let exitPrice = opts?.exitPrice;
  if (exitPrice == null) {
    const { snapshot } = await getMarketData({ symbol: order.symbol, timeframe: "M5", limit: 100 });
    exitPrice = snapshot.mid;
  }
  const pnl = unrealizedPnl(order.direction, order.lotSize, order.entryPrice, exitPrice);

  await db.update(paperOrdersTable).set({
    status: "CLOSED_MANUAL", closedAt: new Date(), exitPrice, profitLoss: pnl, updatedAt: new Date(),
  }).where(eq(paperOrdersTable.id, orderId));
  await db.insert(paperTradeEventsTable).values({
    paperOrderId: orderId, eventType: "CLOSED_MANUAL",
    message: `${SIMULATED_TAG} EE manual close @ ${exitPrice.toFixed(5)}, P&L ${pnl.toFixed(2)} sim pts`,
  }).catch(() => {});

  // Session accounting (Build PP) — same contract as the monitor close above.
  if (order.userId != null) {
    await linkTradeToActiveSession(order.userId, {
      tradeId: String(order.id),
      decisionId: order.decisionId != null ? String(order.decisionId) : undefined,
      symbol: order.symbol,
      action: "CLOSE",
      result: closeResultForPnl(pnl),
      pnl: usdToCents(pnl),
    });
  }

  if (order.decisionId != null) {
    await db.update(paperExecutionsTable)
      .set({ status: "PAPER_CLOSED_MANUAL", updatedAt: new Date() })
      .where(eq(paperExecutionsTable.decisionId, order.decisionId))
      .catch(() => {});
  }

  let bb;
  try {
    bb = await runAutoDebrief(orderId, { triggeredBy: "build_ee_manual" });
  } catch (err) {
    log.warn({ err: String(err) }, "Build EE manual close: BB trigger failed");
  }
  return { ok: true, orderId, exitPrice: Number(exitPrice.toFixed(5)), pnl: Number(pnl.toFixed(2)), bb };
}
