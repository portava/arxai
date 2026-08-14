import { Router } from "express";
import { db } from "@workspace/db";
import { backtestsTable } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import {
  GetBacktestsResponse,
  RunBacktestBody,
  RunBacktestResponse,
  GetBacktestParams,
  GetBacktestResponse,
} from "@workspace/api-zod";
import { runStrategyScan, type Candle } from "../lib/strategyEngine";
import { requireUser } from "../lib/auth/middleware.js";

const router = Router();

function runBacktestLogic(candles: Candle[], strategy: string, initialBalance: number) {
  let balance = initialBalance;
  let peak = initialBalance;
  let maxDrawdown = 0;
  let wins = 0;
  let losses = 0;
  const equityCurve: number[] = [balance];
  const windowSize = 50;

  for (let i = windowSize; i < candles.length - 1; i++) {
    const window = candles.slice(i - windowSize, i + 1);
    const signal = runStrategyScan(candles[0].time, window, 60);
    if (signal.direction === "WAIT") continue;

    const nextCandle = candles[i + 1];
    const riskAmount = balance * 0.01;
    let pnl = 0;

    if (signal.direction === "BUY") {
      if (nextCandle.high >= signal.takeProfit) {
        pnl = riskAmount * 2;
        wins++;
      } else if (nextCandle.low <= signal.stopLoss) {
        pnl = -riskAmount;
        losses++;
      }
    } else if (signal.direction === "SELL") {
      if (nextCandle.low <= signal.takeProfit) {
        pnl = riskAmount * 2;
        wins++;
      } else if (nextCandle.high >= signal.stopLoss) {
        pnl = -riskAmount;
        losses++;
      }
    }

    if (pnl !== 0) {
      balance += pnl;
      if (balance > peak) peak = balance;
      const dd = ((peak - balance) / peak) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
      equityCurve.push(balance);
    }
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const grossProfit = wins * initialBalance * 0.02;
  const grossLoss = losses * initialBalance * 0.01;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 9.99 : 0;

  return { balance, wins, losses, totalTrades, winRate, profitFactor, maxDrawdown, equityCurve };
}

// GET /backtests
router.get("/backtests", requireUser, async (req, res) => {
  try {
    const rows = await db.select().from(backtestsTable)
      .where(eq(backtestsTable.userId, req.authUser!.id))
      .orderBy(desc(backtestsTable.createdAt));
    const data = GetBacktestsResponse.parse(rows.map((r) => ({
      ...r,
      equityCurve: (r.equityCurve as number[]) ?? [],
      createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
    })));
    res.json(data);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to get backtests" });
  }
});

// POST /backtests
router.post("/backtests", requireUser, async (req, res) => {
  try {
    const body = RunBacktestBody.parse(req.body);
    const userId = req.authUser!.id;
    const candles: Candle[] = body.candles.map((c) => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));

    const result = runBacktestLogic(candles, body.strategy, body.initialBalance);

    const inserted = await db.insert(backtestsTable).values({
      userId,
      name: body.name,
      symbol: body.symbol,
      strategy: body.strategy,
      initialBalance: body.initialBalance,
      endingBalance: result.balance,
      totalTrades: result.totalTrades,
      wins: result.wins,
      losses: result.losses,
      winRate: result.winRate,
      profitFactor: result.profitFactor,
      maxDrawdown: result.maxDrawdown,
      bestStrategy: body.strategy,
      equityCurve: result.equityCurve,
      status: "COMPLETED",
    }).returning();

    const r = inserted[0];
    const data = RunBacktestResponse.parse({
      ...r,
      equityCurve: (r.equityCurve as number[]) ?? [],
      createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
    });
    res.json(data);
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Failed to run backtest" });
  }
});

// GET /backtests/:id
router.get("/backtests/:id", requireUser, async (req, res) => {
  try {
    const { id } = GetBacktestParams.parse({ id: Number(req.params["id"]) });
    const rows = await db.select().from(backtestsTable)
      .where(and(eq(backtestsTable.id, id), eq(backtestsTable.userId, req.authUser!.id)));
    if (!rows[0]) { res.status(404).json({ error: "Backtest not found" }); return; }
    const r = rows[0];
    const data = GetBacktestResponse.parse({
      ...r,
      equityCurve: (r.equityCurve as number[]) ?? [],
      createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
    });
    res.json(data);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to get backtest" });
  }
});

export default router;
