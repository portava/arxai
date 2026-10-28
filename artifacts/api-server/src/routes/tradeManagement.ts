import { Router, type Request, type Response } from "express";
import { db, tradesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { evaluateTrade, paperCloseOutcome } from "../lib/tradeManagement/tradeManager.js";
import { createAlert } from "../lib/alerts/alertManager.js";
import { ownerScope } from "../lib/auth/ownerScope.js";
import { guardianPaperManage, type GuardianPaperOp } from "../lib/positionGuardian/manage.js";
import { readScopedMt5State } from "../lib/brokerHub/mt5StateReader.js";

type Trade = typeof tradesTable.$inferSelect;

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

// Position Guardian rule "trade-management": every change goes through the
// guardian, which refuses a break-even or trail that would widen the stop.
async function manage(res: Response, trade: Trade, op: GuardianPaperOp): Promise<Trade | null> {
  const r = await guardianPaperManage({ ruleId: "trade-management", trade, op });
  if (r.ok) return r.trade;
  if (r.code === "TRADE_NOT_FOUND") res.status(404).json({ error: "Trade not found" });
  else res.status(409).json({ error: r.code, message: r.reason });
  return null;
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
  const updated = await manage(res, trade, { kind: "MOVE_STOP", newStop: trade.entryPrice });
  if (!updated) return;
  res.json({
    success: true,
    message: `Stop loss moved to break-even at ${trade.entryPrice} (mock).`,
    trade: serialiseTrade(updated),
  });
});

router.post("/trade-management/:id/trail", async (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const trade = await getTrade(id, req);
  if (!trade) { res.status(404).json({ error: "Trade not found" }); return; }
  const snap = await evaluateTrade(trade);
  // No quote: a trail distance cannot be placed behind an unknown price.
  if (snap.currentPrice == null) {
    res.status(409).json({ error: "NO_CURRENT_QUOTE", message: snap.priceUnavailableReason });
    return;
  }
  const newStop = snap.suggestions.trail.newStop ?? trade.stopLoss;
  const updated = await manage(res, trade, { kind: "MOVE_STOP", newStop });
  if (!updated) return;
  res.json({
    success: true,
    message: `Trailing stop moved to ${newStop.toFixed(5)} (mock).`,
    trade: serialiseTrade(updated),
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
  const updated = await manage(res, trade, { kind: "PARTIAL_CLOSE", newLot });
  if (!updated) return;
  res.json({
    success: true,
    message: `Closed ${closePct}% — lot reduced from ${trade.lot} to ${newLot} (mock).`,
    trade: serialiseTrade(updated),
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
  // No quote: closing would book the entry price and $0.00 as the result.
  // Refuse instead of recording an invented close. A priced close whose P&L
  // cannot be sized is recorded with pnl null / pnlStatus UNKNOWN.
  const outcome = paperCloseOutcome(trade, snap);
  if (!outcome.ok) {
    res.status(409).json({ error: "NO_CURRENT_QUOTE", message: outcome.reason });
    return;
  }
  const { status } = outcome;
  const updated = await manage(res, trade, {
    kind: "CLOSE", status, pnl: outcome.pnl, closedAt: new Date(),
    pnlStatus: outcome.pnlStatus, dataQualityFlag: outcome.dataQualityFlag,
  });
  if (!updated) return;

  const closedText = `${trade.symbol} ${trade.direction} closed at ${outcome.exitPrice.toFixed(5)} ${outcome.resultText} (mock).`;
  await createAlert({
    userId: trade.userId,
    type: "TRADE_CLOSED",
    severity: status === "CLOSED_WIN" ? "success" : "warning",
    title: `Trade closed (${status === "CLOSED_WIN" ? "win" : "loss"})`,
    message: closedText,
    symbol: trade.symbol,
  });

  res.json({
    success: true,
    message: `Trade closed at ${outcome.exitPrice.toFixed(5)} ${outcome.resultText} (mock).`,
    trade: serialiseTrade(updated),
  });
});

function serialiseTrade(t: Trade) {
  return {
    ...t,
    createdAt: t.createdAt?.toISOString() ?? new Date().toISOString(),
    closedAt: t.closedAt?.toISOString() ?? null,
  };
}

export default router;
