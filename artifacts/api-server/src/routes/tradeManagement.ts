import { Router, type Request, type Response } from "express";
import { db, tradesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { evaluateTrade } from "../lib/tradeManagement/tradeManager.js";
import { createAlert } from "../lib/alerts/alertManager.js";
import { ownerScope } from "../lib/auth/ownerScope.js";
import { isStopWidened } from "../lib/riskGovernor/preTrade.js";
import { readScopedMt5State } from "../lib/brokerHub/mt5StateReader.js";

const router = Router();

const TradeIdParam = z.object({ id: z.coerce.number().int().positive() });
const PartialCloseBodySchema = z.object({
  closePct: z.number().min(1).max(99).optional(),
});

function parseId(req: Request, res: Response): number | null {
  const r = TradeIdParam.safeParse(req.params);
  if (!r.success) {
    res.status(400).json({ error: "Invalid trade id" });
    return null;
  }
  return r.data.id;
}

// Only the trade's owner (or an operator, for legacy ownerless trades) may read
// or manage it; anyone else gets the same 404 as a missing id.
async function getTrade(id: number, req: Request) {
  const rows = await db.select().from(tradesTable)
    .where(and(eq(tradesTable.id, id), ownerScope(tradesTable.userId, req.authUser)))
    .limit(1);
  return rows[0] ?? null;
}

// Position Guardian: break-even and trailing only ever tighten a stop. A
// break-even below a stop already locked in profit would widen it.
function refuseWidening(res: Response, trade: { direction: string; stopLoss: number }, next: number): boolean {
  const side = trade.direction === "SELL" ? "SELL" : "BUY";
  if (!isStopWidened(side, trade.stopLoss, next)) return false;
  res.status(409).json({
    error: "STOP_WOULD_WIDEN",
    message: `Moving the stop from ${trade.stopLoss} to ${next} would add risk; break-even and trailing only tighten.`,
  });
  return true;
}

router.get("/trade-management/:id/snapshot", async (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const trade = await getTrade(id, req);
  if (!trade) { res.status(404).json({ error: "Trade not found" }); return; }
  res.json(await evaluateTrade(trade));
});

router.post("/trade-management/:id/breakeven", async (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const trade = await getTrade(id, req);
  if (!trade) { res.status(404).json({ error: "Trade not found" }); return; }
  if (refuseWidening(res, trade, trade.entryPrice)) return;
  const updated = await db.update(tradesTable).set({ stopLoss: trade.entryPrice }).where(eq(tradesTable.id, id)).returning();
  res.json({
    success: true,
    message: `Stop loss moved to break-even at ${trade.entryPrice} (mock).`,
    trade: serialiseTrade(updated[0]),
  });
});

router.post("/trade-management/:id/trail", async (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const trade = await getTrade(id, req);
  if (!trade) { res.status(404).json({ error: "Trade not found" }); return; }
  const snap = await evaluateTrade(trade);
  const newStop = snap.suggestions.trail.newStop ?? trade.stopLoss;
  if (refuseWidening(res, trade, newStop)) return;
  const updated = await db.update(tradesTable).set({ stopLoss: newStop }).where(eq(tradesTable.id, id)).returning();
  res.json({
    success: true,
    message: `Trailing stop moved to ${newStop.toFixed(5)} (mock).`,
    trade: serialiseTrade(updated[0]),
  });
});

router.post("/trade-management/:id/partial-close", async (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const trade = await getTrade(id, req);
  if (!trade) { res.status(404).json({ error: "Trade not found" }); return; }
  const parsed = PartialCloseBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "closePct must be between 1 and 99" }); return; }
  const closePct = parsed.data.closePct ?? 50;
  const newLot = Math.max(0.01, Number((trade.lot * (1 - closePct / 100)).toFixed(2)));
  const updated = await db.update(tradesTable).set({ lot: newLot }).where(eq(tradesTable.id, id)).returning();
  res.json({
    success: true,
    message: `Closed ${closePct}% — lot reduced from ${trade.lot} to ${newLot} (mock).`,
    trade: serialiseTrade(updated[0]),
  });
});

router.post("/trade-management/:id/close", async (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const trade = await getTrade(id, req);
  if (!trade) { res.status(404).json({ error: "Trade not found" }); return; }

  // If MT5 connected, queue a CLOSE_ALL command (in real bridge we'd send ticket)
  const state = await readScopedMt5State((col) => ownerScope(col, req.authUser));
  const liveAllowed = !!state?.liveAllowed;
  void liveAllowed;

  const snap = await evaluateTrade(trade);
  const status: "CLOSED_WIN" | "CLOSED_LOSS" = snap.floatingPnl >= 0 ? "CLOSED_WIN" : "CLOSED_LOSS";
  const updated = await db.update(tradesTable).set({
    status, pnl: Number(snap.floatingPnl.toFixed(2)), closedAt: new Date(),
  }).where(eq(tradesTable.id, id)).returning();

  await createAlert({
    userId: trade.userId,
    type: "TRADE_CLOSED",
    severity: status === "CLOSED_WIN" ? "success" : "warning",
    title: `Trade closed (${status === "CLOSED_WIN" ? "win" : "loss"})`,
    message: `${trade.symbol} ${trade.direction} closed at ${snap.currentPrice.toFixed(5)} for ${snap.floatingPnl.toFixed(2)} (mock).`,
    symbol: trade.symbol,
  });

  res.json({
    success: true,
    message: `Trade closed at ${snap.currentPrice.toFixed(5)} for ${snap.floatingPnl.toFixed(2)} (mock).`,
    trade: serialiseTrade(updated[0]),
  });
});

function serialiseTrade(t: typeof tradesTable.$inferSelect) {
  return {
    ...t,
    createdAt: t.createdAt?.toISOString() ?? new Date().toISOString(),
    closedAt: t.closedAt?.toISOString() ?? null,
  };
}

export default router;
