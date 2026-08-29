import { Router, type Request, type Response } from "express";
import { db, tradesTable, mt5StateTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { evaluateTrade } from "../lib/tradeManagement/tradeManager.js";
import { createAlert } from "../lib/alerts/alertManager.js";
import { PNL_FLAG_SIMULATED_CLOSE } from "@workspace/domain/safety-contracts/eaCloseFill";

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

async function getTrade(id: number) {
  const rows = await db.select().from(tradesTable).where(eq(tradesTable.id, id)).limit(1);
  return rows[0] ?? null;
}

router.get("/trade-management/:id/snapshot", async (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const trade = await getTrade(id);
  if (!trade) { res.status(404).json({ error: "Trade not found" }); return; }
  res.json(await evaluateTrade(trade));
});

router.post("/trade-management/:id/breakeven", async (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const trade = await getTrade(id);
  if (!trade) { res.status(404).json({ error: "Trade not found" }); return; }
  const updated = await db.update(tradesTable).set({ stopLoss: trade.entryPrice }).where(eq(tradesTable.id, id)).returning();
  res.json({
    success: true,
    message: `Stop loss moved to break-even at ${trade.entryPrice} (mock).`,
    trade: serialiseTrade(updated[0]),
  });
});

router.post("/trade-management/:id/trail", async (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const trade = await getTrade(id);
  if (!trade) { res.status(404).json({ error: "Trade not found" }); return; }
  const snap = await evaluateTrade(trade);
  const newStop = snap.suggestions.trail.newStop ?? trade.stopLoss;
  const updated = await db.update(tradesTable).set({ stopLoss: newStop }).where(eq(tradesTable.id, id)).returning();
  res.json({
    success: true,
    message: `Trailing stop moved to ${newStop.toFixed(5)} (mock).`,
    trade: serialiseTrade(updated[0]),
  });
});

router.post("/trade-management/:id/partial-close", async (req, res) => {
  const id = parseId(req, res); if (id == null) return;
  const trade = await getTrade(id);
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
  const trade = await getTrade(id);
  if (!trade) { res.status(404).json({ error: "Trade not found" }); return; }

  // If MT5 connected, queue a CLOSE_ALL command (in real bridge we'd send ticket)
  const stateRows = await db.select().from(mt5StateTable).limit(1);
  const liveAllowed = !!stateRows[0]?.liveAllowed;
  void liveAllowed;

  const snap = await evaluateTrade(trade);
  // Win/loss direction is honest — it is the SIGN of the price move, which
  // needs no contract size. The DOLLAR amount is not: this path has no pip
  // value or quote-currency conversion, so it writes NO pnl and marks the row
  // pnlStatus="UNKNOWN". Every money aggregate (/performance/summary,
  // /performance/daily, /performance/strategy-breakdown, /portfolio/exposure)
  // already excludes UNKNOWN rows and the Trade Logs UI renders
  // "P/L unavailable" for them. A number labelled "(mock)" in its own
  // response must never enter a money aggregate.
  const status: "CLOSED_WIN" | "CLOSED_LOSS" = snap.priceMove >= 0 ? "CLOSED_WIN" : "CLOSED_LOSS";
  const updated = await db.update(tradesTable).set({
    status,
    pnl: null,
    pnlStatus: "UNKNOWN",
    // Shared constant: the Trade Logs P/L cell reads this exact flag to decide
    // that the row's missing P/L is NOT an EA-age problem, so it must never
    // show the "EA too old — upgrade to v1.28" nudge for a close that had no
    // EA and no broker in it. See @workspace/domain/safety-contracts/eaCloseFill.
    dataQualityFlag: PNL_FLAG_SIMULATED_CLOSE,
    closedAt: new Date(),
  }).where(eq(tradesTable.id, id)).returning();

  const detail =
    `${trade.symbol} ${trade.direction} closed at ${snap.currentPrice.toFixed(5)} ` +
    `(${snap.priceMove >= 0 ? "+" : ""}${snap.priceMove.toFixed(5)} from entry). ` +
    `P/L unavailable — this simulated close is not priced in account currency.`;

  await createAlert({
    type: "TRADE_CLOSED",
    severity: status === "CLOSED_WIN" ? "success" : "warning",
    title: `Trade closed (${status === "CLOSED_WIN" ? "in profit" : "at a loss"})`,
    message: detail,
    symbol: trade.symbol,
  });

  res.json({
    success: true,
    message: detail,
    pnlStatus: "UNKNOWN",
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
