// Build CC — Learning Feedback Engine routes.
//
// SAFETY: read/process only. None of these endpoints place trades, mutate
// safetyCore, or touch live broker surfaces.

import { Router, type Response } from "express";
import { z } from "zod/v4";
import {
  processLearningPayload,
  getSymbolLearningView,
  listLearningEvents,
  listEdges,
  listMistakes,
  type LearningPayload,
} from "../lib/learningEngine.js";

const router: Router = Router();

const DISCLAIMER =
  "Learning data is reflective and bounded. It informs scoring but never overrides safety blockers, " +
  "kill-switch, risk locks, or the canPlaceTrades gate.";

function ok(res: Response, body: Record<string, unknown>) {
  return res.json({ ...body, system: "learning", disclaimer: DISCLAIMER });
}
function fail(res: Response, status: number, error: string) {
  return res.status(status).json({ error, system: "learning", disclaimer: DISCLAIMER });
}

// ── Schemas ────────────────────────────────────────────────────────────────
const SignalSchema = z.object({
  source: z.string(),
  status: z.string(),
  score: z.number(),
  detail: z.string().optional(),
});
const PayloadSchema = z.object({
  trade_id: z.number().int(),
  decision_id: z.number().int().nullable().optional().default(null),
  result: z.string(),
  pnl: z.number().default(0),
  pnl_percent: z.number().optional(),
  symbol: z.string().optional(),
  action: z.string().optional(),
  mistake_tags: z.array(z.string()).optional().default([]),
  lesson: z.string().optional().default(""),
  confidence_before_trade: z.number().nullable().optional().default(null),
  risk_score_before_trade: z.number().nullable().optional().default(null),
  signals_used: z.array(SignalSchema).optional().default([]),
  debrief_id: z.number().int(),
  ready_for_learning: z.boolean().default(true),
});

// POST /api/learning/process — accepts a Build BB learning payload.
router.post("/learning/process", async (req, res): Promise<void> => {
  try {
    const parsed = PayloadSchema.safeParse(req.body ?? {});
    if (!parsed.success) { fail(res, 400, "Invalid payload: " + parsed.error.message); return; }
    const result = await processLearningPayload(parsed.data as unknown as LearningPayload);
    ok(res, { result });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "POST /learning/process failed");
    fail(res, 500, "Failed to process learning payload");
  }
});

// GET /api/learning/events?limit=10
router.get("/learning/events", async (req, res): Promise<void> => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 10)));
    const events = await listLearningEvents(limit);
    ok(res, { count: events.length, events });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /learning/events failed");
    fail(res, 500, "Failed to list learning events");
  }
});

// GET /api/learning/edges?symbol=...
router.get("/learning/edges", async (req, res): Promise<void> => {
  try {
    const symbol = typeof req.query.symbol === "string" && req.query.symbol.length > 0 ? req.query.symbol : undefined;
    const edges = await listEdges(symbol);
    ok(res, { count: edges.length, symbol: symbol ?? null, edges });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /learning/edges failed");
    fail(res, 500, "Failed to list strategy edges");
  }
});

// GET /api/learning/mistakes?symbol=...
router.get("/learning/mistakes", async (req, res): Promise<void> => {
  try {
    const symbol = typeof req.query.symbol === "string" && req.query.symbol.length > 0 ? req.query.symbol : undefined;
    const mistakes = await listMistakes(symbol);
    ok(res, { count: mistakes.length, symbol: symbol ?? null, mistakes });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /learning/mistakes failed");
    fail(res, 500, "Failed to list mistake patterns");
  }
});

// GET /api/learning/view?symbol=...&action=BUY — what AA will see for the next decision.
router.get("/learning/view", async (req, res): Promise<void> => {
  try {
    const symbol = String(req.query.symbol ?? "Volatility 75 Index");
    const action = String(req.query.action ?? "BUY").toUpperCase() as "BUY" | "SELL" | "HOLD";
    if (!["BUY", "SELL", "HOLD"].includes(action)) { fail(res, 400, "action must be BUY|SELL|HOLD"); return; }
    const view = await getSymbolLearningView(symbol, action);
    ok(res, { view });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /learning/view failed");
    fail(res, 500, "Failed to compute learning view");
  }
});

// POST /api/learning/demo — synthesize a payload to prove the loop end-to-end.
const DemoBody = z.object({
  symbol: z.string().default("Volatility 75 Index"),
  action: z.enum(["BUY", "SELL"]).default("BUY"),
  result: z.enum(["WIN", "LOSS", "BREAKEVEN", "CANCELLED"]).default("WIN"),
  pnl: z.number().optional(),
  mistakeTags: z.array(z.string()).optional().default([]),
});
router.post("/learning/demo", async (req, res): Promise<void> => {
  try {
    const parsed = DemoBody.safeParse(req.body ?? {});
    if (!parsed.success) { fail(res, 400, "Invalid demo body: " + parsed.error.message); return; }
    const { symbol, action, result, mistakeTags } = parsed.data;
    const pnl = parsed.data.pnl ?? (result === "WIN" ? 12 : result === "LOSS" ? -8 : 0);
    // Keep IDs inside int32. Use offset > real-row range to avoid collisions.
    const fakeDebriefId = 2_000_000_000 + Math.floor(Math.random() * 100_000_000);
    const fakeTradeId   = 1_900_000_000 + Math.floor(Math.random() * 100_000_000);
    const payload: LearningPayload = {
      trade_id: fakeTradeId, decision_id: null, debrief_id: fakeDebriefId,
      result, pnl, pnl_percent: pnl, symbol, action,
      confidence_before_trade: result === "WIN" ? 78 : 64,
      risk_score_before_trade: result === "LOSS" ? 75 : 35,
      signals_used: [
        { source: "strategyEngine", status: "PASS", score: 32, detail: "demo signal" },
        { source: "session",        status: "PASS", score: 5,  detail: "demo session" },
        { source: "edge",           status: "PASS", score: 7,  detail: "demo edge" },
      ],
      mistake_tags: result === "LOSS" ? (mistakeTags.length ? mistakeTags : ["EXITED_TOO_QUICKLY"]) : [],
      lesson: `Demo ${result}`, ready_for_learning: true,
    };
    const learning = await processLearningPayload(payload);
    const view = await getSymbolLearningView(symbol, action);
    ok(res, { demoPayload: payload, learning, viewAfter: view });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "POST /learning/demo failed");
    fail(res, 500, "Failed to run learning demo");
  }
});

export default router;
