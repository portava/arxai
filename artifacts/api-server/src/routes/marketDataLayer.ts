// Market Data Layer HTTP surface — quotes/candles envelopes, session clock,
// news risk, spread/vol monitors, market health, data quality, risk governor.
//
// SAFETY: All endpoints are read-only over the simulator EXCEPT news-risk
// CRUD which mutates an in-memory store and is admin-gated. No new code
// touches live_positions / mt5_commands / placeLiveOrderGuarded.
import { Router, type Request, type Response, type NextFunction } from "express";
import { readRoleFromRequest } from "../lib/security/middleware.js";

import { z } from "zod/v4";
import {
  getQuote, getQuotes, getCandles, dataSource,
  sessionClock, sessionsList, spreadMonitor, volatilityMonitor,
  marketHealth, dataQuality, evaluateRisk,
  listNewsEvents, addNewsEvent, patchNewsEvent, deleteNewsEvent, currentNewsRisk,
} from "../lib/marketDataLayer.js";

const router = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const role = readRoleFromRequest(req);
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ error: "Forbidden", requiredRole: "ADMIN" });
    return;
  }
  next();
}

router.get("/market/data-source", (_req, res) => res.json(dataSource()));

router.get("/market/quotes", requireAdmin, (req, res) => {
  const list = String(req.query.symbols || "EURUSD,GBPUSD,USDJPY,XAUUSD").split(",").filter(Boolean).slice(0, 20);
  return res.json({ quotes: getQuotes(list), dataSource: "SIMULATOR" });
});

router.get("/market/quote-envelope/:symbol", (req, res) => res.json(getQuote(req.params.symbol)));

router.get("/market/candles-envelope/:symbol", (req, res) => {
  const tf = String(req.query.timeframe || "M15");
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  return res.json(getCandles(req.params.symbol, tf, limit));
});

router.get("/market/sessions", (_req, res) => res.json(sessionsList()));
router.get("/market/session-clock", (_req, res) => res.json(sessionClock()));

router.get("/market/spread-monitor", (req, res) => res.json(spreadMonitor(String(req.query.symbol || "EURUSD"))));
router.get("/market/volatility-monitor", (req, res) =>
  res.json(volatilityMonitor(String(req.query.symbol || "EURUSD"), String(req.query.timeframe || "M15"))));
router.get("/market/health", (req, res) =>
  res.json(marketHealth(String(req.query.symbol || "EURUSD"), String(req.query.timeframe || "M15"))));
router.get("/data-quality", (req, res) =>
  res.json(dataQuality(String(req.query.symbol || "EURUSD"), String(req.query.timeframe || "M15"))));

router.post("/risk/evaluate", (req, res) => {
  const Body = z.object({
    symbol: z.string(),
    direction: z.enum(["BUY", "SELL"]).optional(),
    lotSize: z.number().optional(),
    stopLoss: z.number().optional(),
    takeProfit: z.number().optional(),
    entryPrice: z.number().optional(),
    maxLossUsd: z.number().optional(),
    confidenceScore: z.number().optional(),
    tradesToday: z.number().int().optional(),
    dailyLossUsd: z.number().optional(),
    maxDailyLossUsd: z.number().optional(),
  });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "symbol required", issues: p.error.issues });
  return res.json(evaluateRisk(p.data));
});

router.get("/news-risk/events", requireAdmin, (_req, res) => res.json({ events: listNewsEvents(), dataSource: "SIMULATOR" }));
router.get("/news-risk/current", (req, res) => res.json(currentNewsRisk(req.query.symbol ? String(req.query.symbol) : undefined)));

router.post("/news-risk/events", requireAdmin, (req, res) => {
  const Body = z.object({
    eventName: z.string().min(1),
    currency: z.string().min(1),
    impact: z.enum(["low", "medium", "high"]),
    eventTime: z.string(),
    affectedSymbols: z.array(z.string()).default([]),
    avoidBeforeMinutes: z.number().int().min(0).default(15),
    avoidAfterMinutes: z.number().int().min(0).default(15),
    notes: z.string().optional(),
  });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "invalid", issues: p.error.issues });
  return res.status(201).json(addNewsEvent(p.data));
});

router.patch("/news-risk/events/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
  const Body = z.object({
    eventName: z.string().optional(),
    currency: z.string().optional(),
    impact: z.enum(["low", "medium", "high"]).optional(),
    eventTime: z.string().optional(),
    affectedSymbols: z.array(z.string()).optional(),
    avoidBeforeMinutes: z.number().int().min(0).optional(),
    avoidAfterMinutes: z.number().int().min(0).optional(),
    notes: z.string().optional(),
  });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "invalid", issues: p.error.issues });
  const upd = patchNewsEvent(id, p.data);
  if (!upd) return res.status(404).json({ error: "not found" });
  return res.json(upd);
});

router.delete("/news-risk/events/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
  const ok = deleteNewsEvent(id);
  if (!ok) return res.status(404).json({ error: "not found" });
  return res.json({ deleted: true, id });
});

export default router;
