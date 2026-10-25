// OMS / Position Manager / Execution / P/L HTTP surface.
//
// SAFETY: All mutating endpoints (create/cancel/submit/close/move-*) require
// ADMIN. None of them place real broker orders. Live-tester-intent orders
// are accepted but parked at PENDING_MT5_CONNECTION and never submitted to
// the simulator engine.
import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAdmin } from "../lib/security/middleware.js";

import { z } from "zod/v4";
import {
  placeOrder, listOrders, getOrder, amendOrder, withdrawOrder,
  fillOrder, listPositions, getPosition,
  closeOmsPosition, partialCloseOmsPosition, moveOmsStop, moveOmsTakeProfit, moveOmsStopToBreakEven, setOmsTrailingStop,
  pnlSummary, pnlBy, pnlDaily, brokerReconStatus, omsDashboardSummary,
  tickAll, type OmsActionResult, type OmsActor,
} from "../lib/oms.js";
import { operatorRoleFromSession } from "../lib/security/adminRoleGate.js";

// Every change to the simulator book is evaluated by the pre-trade Risk
// Governor for the operator making it (lib/oms.ts, governed entry points).
const actorOf = (req: Request): OmsActor => ({ userId: req.authUser!.id });

function sendResult<T>(res: Response, r: OmsActionResult<T>) {
  if (r.ok) return res.json(r.value);
  if (r.error === "not_found") return res.status(404).json({ error: "not found" });
  if (r.error === "risk_blocked") {
    return res.status(422).json({ error: "RISK_GOVERNOR_BLOCK", message: r.message, blockedBy: r.governance?.blockedBy ?? [],
      auditEventId: r.governance?.auditEventId ?? null });
  }
  return res.status(409).json({ error: r.error === "would_widen" ? "STOP_WOULD_WIDEN" : "POSITION_NOT_OPEN", message: r.message });
}

const router = Router();

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

router.post("/orders/create", requireAdmin, async (req, res) => {
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
  const { order, governance } = await placeOrder(p.data, actorOf(req));
  return res.status(201).json({ ...order, governance });
});

router.post("/orders/:id/submit-simulator", requireAdmin, async (req, res) => {
  const g = await fillOrder(String(req.params.id), actorOf(req));
  if (!g.ok) return sendResult(res, g);
  if (g.value.error) return res.status(400).json(g.value);
  return res.json(g.value);
});
router.post("/orders/:id/cancel", requireAdmin, (req, res) => {
  const o = withdrawOrder(String(req.params.id)); if (!o) return res.status(404).json({ error: "not found" });
  return res.json(o);
});
router.patch("/orders/:id", requireAdmin, async (req, res) => {
  const Body = z.object({
    stopLoss: z.number().optional(), takeProfit: z.number().optional(),
    lotSize: z.number().positive().optional(),
    rejectionReason: z.string().optional(),
  });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "invalid", issues: p.error.issues });
  return sendResult(res, await amendOrder(String(req.params.id), p.data, actorOf(req)));
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

router.post("/oms/positions/:id/close", requireAdmin, async (req, res) => {
  return sendResult(res, await closeOmsPosition(String(req.params.id), actorOf(req)));
});
router.post("/oms/positions/:id/partial-close", requireAdmin, async (req, res) => {
  const Body = z.object({ fraction: z.number().min(0.01).max(0.99) });
  const p = Body.safeParse(req.body ?? {}); if (!p.success) return res.status(400).json({ error: "invalid" });
  return sendResult(res, await partialCloseOmsPosition(String(req.params.id), p.data.fraction, actorOf(req)));
});
router.post("/oms/positions/:id/move-stop", requireAdmin, async (req, res) => {
  const Body = z.object({ stopLoss: z.number() });
  const p = Body.safeParse(req.body ?? {}); if (!p.success) return res.status(400).json({ error: "invalid" });
  return sendResult(res, await moveOmsStop(String(req.params.id), p.data.stopLoss, actorOf(req)));
});
router.post("/oms/positions/:id/move-take-profit", requireAdmin, async (req, res) => {
  const Body = z.object({ takeProfit: z.number() });
  const p = Body.safeParse(req.body ?? {}); if (!p.success) return res.status(400).json({ error: "invalid" });
  return sendResult(res, await moveOmsTakeProfit(String(req.params.id), p.data.takeProfit, actorOf(req)));
});
router.post("/oms/positions/:id/breakeven", requireAdmin, async (req, res) => {
  return sendResult(res, await moveOmsStopToBreakEven(String(req.params.id), actorOf(req)));
});
router.post("/oms/positions/:id/trailing-stop", requireAdmin, async (req, res) => {
  const Body = z.object({ distance: z.number().positive() });
  const p = Body.safeParse(req.body ?? {}); if (!p.success) return res.status(400).json({ error: "invalid" });
  return sendResult(res, await setOmsTrailingStop(String(req.params.id), p.data.distance, actorOf(req)));
});

// ── Execution helpers ──────────────────────────────────────────────────────
router.post("/execution/simulator/fill", requireAdmin, async (req, res) => {
  const Body = z.object({ orderId: z.string() });
  const p = Body.safeParse(req.body ?? {}); if (!p.success) return res.status(400).json({ error: "invalid" });
  const g = await fillOrder(p.data.orderId, actorOf(req));
  if (!g.ok) return sendResult(res, g);
  if (g.value.error) return res.status(400).json(g.value);
  return res.json(g.value);
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
  if (!operatorRoleFromSession(role)) {
    return res.status(403).json({ ok: false, error: "ADMIN_OR_OWNER_REQUIRED", redirectTo: "/admin/reconciliation-center" });
  }
  return res.json(brokerReconStatus());
});
router.get("/oms/dashboard-summary", (_req, res) => res.json(omsDashboardSummary()));

export default router;
