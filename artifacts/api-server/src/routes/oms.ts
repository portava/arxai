// OMS / Position Manager / Execution / P/L HTTP surface.
//
// SAFETY: All mutating endpoints (create/cancel/submit/close/move-*) require
// ADMIN. None of them place real broker orders. Live-tester-intent orders
// are accepted but parked at PENDING_MT5_CONNECTION and never submitted to
// the simulator engine.
import { Router, type Request, type Response, type NextFunction } from "express";
import { readRoleFromRequest } from "../lib/security/middleware.js";

import { z } from "zod/v4";
import {
  createOrder, listOrders, getOrder, patchOrder, cancelOrder,
  submitToSimulator, listPositions, getPosition,
  closePosition, partialClose, moveStop, moveTakeProfit, moveStopToBreakEven, applyTrailingStop,
  pnlSummary, pnlBy, pnlDaily, brokerReconStatus, omsDashboardSummary,
  tickAll,
} from "../lib/oms.js";

const router = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const role = readRoleFromRequest(req);
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ error: "Forbidden", requiredRole: "ADMIN" });
    return;
  }
  next();
}

const Env = z.enum(["PAPER", "DEMO_SIMULATOR", "LIVE_TESTER_INTENT", "FUTURE_MT5_DEMO", "FUTURE_MT5_LIVE"]);
const Source = z.enum(["MANUAL", "AI_ASSIST", "AI_AUTO", "SCANNER", "BACKTEST", "REPLAY"]);

// ── Orders ─────────────────────────────────────────────────────────────────
router.get("/orders", (req, res) => {
  const env = req.query.environment ? Env.safeParse(req.query.environment) : null;
  const status = req.query.status ? String(req.query.status) : undefined;
  const source = req.query.source ? Source.safeParse(req.query.source) : null;
  return res.json({
    orders: listOrders({
      environment: env?.success ? env.data : undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      status: status as any,
      source: source?.success ? source.data : undefined,
      limit: Math.min(Number(req.query.limit) || 200, 500),
    }),
    dataSource: "SIMULATOR",
  });
});
router.get("/orders/:id", (req, res) => {
  const o = getOrder(String(req.params.id)); if (!o) return res.status(404).json({ error: "not found" });
  return res.json(o);
});

router.post("/orders/create", requireAdmin, (req, res) => {
  const Body = z.object({
    environment: Env, source: Source,
    symbol: z.string(), direction: z.enum(["BUY", "SELL"]),
    orderType: z.enum(["MARKET", "LIMIT", "STOP"]).optional(),
    lotSize: z.number().positive(),
    entryPrice: z.number().optional(),
    stopLoss: z.number().optional(),
    takeProfit: z.number().optional(),
    riskAmount: z.number().optional(),
    confidenceScore: z.number().optional(),
    riskScore: z.number().optional(),
    entrySniperScore: z.number().optional(),
    opportunityScore: z.number().optional(),
    strategyId: z.union([z.number(), z.string()]).optional(),
    idempotencyKey: z.string().optional(),
  });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "invalid", issues: p.error.issues });
  return res.status(201).json(createOrder(p.data));
});

router.post("/orders/:id/submit-simulator", requireAdmin, (req, res) => {
  const r = submitToSimulator(String(req.params.id));
  if (r.error) return res.status(400).json(r);
  return res.json(r);
});
router.post("/orders/:id/cancel", requireAdmin, (req, res) => {
  const o = cancelOrder(String(req.params.id)); if (!o) return res.status(404).json({ error: "not found" });
  return res.json(o);
});
router.patch("/orders/:id", requireAdmin, (req, res) => {
  const Body = z.object({
    stopLoss: z.number().optional(), takeProfit: z.number().optional(),
    lotSize: z.number().positive().optional(),
    rejectionReason: z.string().optional(),
  });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "invalid", issues: p.error.issues });
  const o = patchOrder(String(req.params.id), p.data); if (!o) return res.status(404).json({ error: "not found" });
  return res.json(o);
});

// ── Positions ──────────────────────────────────────────────────────────────
router.get("/oms/positions", (req, res) => {
  const env = req.query.environment ? Env.safeParse(req.query.environment) : null;
  return res.json({ positions: listPositions({ environment: env?.success ? env.data : undefined }), dataSource: "SIMULATOR" });
});
router.get("/oms/positions/open", (_req, res) => res.json({ positions: listPositions({ status: "OPEN" }), dataSource: "SIMULATOR" }));
router.get("/oms/positions/closed", (_req, res) => {
  const closed = listPositions({}).filter((p) => p.status !== "OPEN");
  return res.json({ positions: closed, dataSource: "SIMULATOR" });
});
router.get("/oms/positions/:id", (req, res) => {
  const p = getPosition(String(req.params.id)); if (!p) return res.status(404).json({ error: "not found" });
  return res.json(p);
});

router.post("/oms/positions/:id/close", requireAdmin, (req, res) => {
  const p = closePosition(String(req.params.id), "MANUALLY_CLOSED");
  if (!p) return res.status(404).json({ error: "not found" });
  return res.json(p);
});
router.post("/oms/positions/:id/partial-close", requireAdmin, (req, res) => {
  const Body = z.object({ fraction: z.number().min(0.01).max(0.99) });
  const p = Body.safeParse(req.body ?? {}); if (!p.success) return res.status(400).json({ error: "invalid" });
  const pos = partialClose(String(req.params.id), p.data.fraction); if (!pos) return res.status(404).json({ error: "not found" });
  return res.json(pos);
});
router.post("/oms/positions/:id/move-stop", requireAdmin, (req, res) => {
  const Body = z.object({ stopLoss: z.number() });
  const p = Body.safeParse(req.body ?? {}); if (!p.success) return res.status(400).json({ error: "invalid" });
  const pos = moveStop(String(req.params.id), p.data.stopLoss); if (!pos) return res.status(404).json({ error: "not found" });
  return res.json(pos);
});
router.post("/oms/positions/:id/move-take-profit", requireAdmin, (req, res) => {
  const Body = z.object({ takeProfit: z.number() });
  const p = Body.safeParse(req.body ?? {}); if (!p.success) return res.status(400).json({ error: "invalid" });
  const pos = moveTakeProfit(String(req.params.id), p.data.takeProfit); if (!pos) return res.status(404).json({ error: "not found" });
  return res.json(pos);
});
router.post("/oms/positions/:id/breakeven", requireAdmin, (req, res) => {
  const pos = moveStopToBreakEven(String(req.params.id)); if (!pos) return res.status(404).json({ error: "not found" });
  return res.json(pos);
});
router.post("/oms/positions/:id/trailing-stop", requireAdmin, (req, res) => {
  const Body = z.object({ distance: z.number().positive() });
  const p = Body.safeParse(req.body ?? {}); if (!p.success) return res.status(400).json({ error: "invalid" });
  const pos = applyTrailingStop(String(req.params.id), p.data.distance); if (!pos) return res.status(404).json({ error: "not found" });
  return res.json(pos);
});

// ── Execution helpers ──────────────────────────────────────────────────────
router.post("/execution/simulator/fill", requireAdmin, (req, res) => {
  const Body = z.object({ orderId: z.string() });
  const p = Body.safeParse(req.body ?? {}); if (!p.success) return res.status(400).json({ error: "invalid" });
  const r = submitToSimulator(p.data.orderId);
  if (r.error) return res.status(400).json(r);
  return res.json(r);
});
router.post("/execution/simulator/tick", requireAdmin, (_req, res) => { tickAll(); return res.json({ ticked: true }); });

// ── P/L ────────────────────────────────────────────────────────────────────
router.get("/pnl/summary", (req, res) => {
  const env = req.query.environment ? Env.safeParse(req.query.environment) : null;
  return res.json(pnlSummary(env?.success ? env.data : undefined));
});
router.get("/pnl/daily", (req, res) => {
  const env = req.query.environment ? Env.safeParse(req.query.environment) : null;
  return res.json({ days: pnlDaily(env?.success ? env.data : undefined), dataSource: "SIMULATOR" });
});
router.get("/pnl/by-symbol", (_req, res) => res.json({ groups: pnlBy("symbol"), dataSource: "SIMULATOR" }));
router.get("/pnl/by-strategy", (_req, res) => res.json({ groups: pnlBy("strategy"), dataSource: "SIMULATOR" }));
router.get("/pnl/by-environment", (_req, res) => res.json({ groups: pnlBy("environment"), dataSource: "SIMULATOR" }));

// ── Reconciliation + dashboard ─────────────────────────────────────────────
router.get("/broker-reconciliation/status", (req, res) => {
  const u = (req as typeof req & { authUser?: { role?: string } }).authUser;
  const role = String(u?.role ?? "").toUpperCase();
  if (role !== "ADMIN" && role !== "OWNER") {
    return res.status(403).json({ ok: false, error: "ADMIN_OR_OWNER_REQUIRED", redirectTo: "/admin/reconciliation-center" });
  }
  return res.json(brokerReconStatus());
});
router.get("/oms/dashboard-summary", (_req, res) => res.json(omsDashboardSummary()));

export default router;
