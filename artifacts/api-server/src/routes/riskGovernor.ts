// Build HH — Risk Governor routes.
//
// SAFETY: All endpoints are READ-ONLY/governance. They NEVER place trades,
// NEVER call MT5, NEVER modify canPlaceTrades. liveTradingStatus is hardcoded
// "DISABLED" in every response envelope.

import { Router } from "express";
import { z } from "zod/v4";
import { db, riskGovernorEvaluationsTable, riskGovernorEventsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { evaluateGovernor, type SimulateOverrides } from "../lib/riskGovernor/governor.js";

const router = Router();
const TAG = "Build HH — Risk Governor + Trader Readiness. Reporting/governance only. Never places trades, never calls MT5, never enables canPlaceTrades.";

function envelope(body: Record<string, unknown>) {
  return {
    system: "riskGovernor",
    liveTradingStatus: "DISABLED" as const,
    mode: "PAPER_ONLY" as const,
    disclaimer: TAG,
    ...body,
  };
}

// GET /api/risk-governor/status — fast non-persisted evaluation.
router.get("/risk-governor/status", async (req, res) => {
  try {
    const log = {
      info: (m: string, x?: Record<string, unknown>) => req.log?.info?.(x ?? {}, `HH governor: ${m}`),
      warn: (m: string, x?: Record<string, unknown>) => req.log?.warn?.(x ?? {}, `HH governor: ${m}`),
      error: (m: string, x?: Record<string, unknown>) => req.log?.error?.(x ?? {}, `HH governor: ${m}`),
    };
    const sym = typeof req.query.symbol === "string" && req.query.symbol.trim() ? req.query.symbol.trim() : undefined;
    const e = await evaluateGovernor({ persist: false, log, symbol: sym, userId: req.authUser?.id ?? null });
    res.json(envelope({ governor: e }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Failed to evaluate governor", detail: String(err).slice(0, 200) }));
  }
});

// POST /api/risk-governor/evaluate — persisted evaluation.
router.post("/risk-governor/evaluate", async (req, res) => {
  try {
    const log = {
      info: (m: string, x?: Record<string, unknown>) => req.log?.info?.(x ?? {}, `HH governor: ${m}`),
      warn: (m: string, x?: Record<string, unknown>) => req.log?.warn?.(x ?? {}, `HH governor: ${m}`),
      error: (m: string, x?: Record<string, unknown>) => req.log?.error?.(x ?? {}, `HH governor: ${m}`),
    };
    const e = await evaluateGovernor({ persist: true, log, userId: req.authUser?.id ?? null });
    res.json(envelope({ governor: e, persisted: true }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Failed to evaluate governor", detail: String(err).slice(0, 200) }));
  }
});

// GET /api/risk-governor/evaluations?limit=20
router.get("/risk-governor/evaluations", async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 20)));
  try {
    const rows = await db.select().from(riskGovernorEvaluationsTable)
      .orderBy(desc(riskGovernorEvaluationsTable.createdAt)).limit(limit);
    res.json(envelope({ evaluations: rows, count: rows.length }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Failed to list evaluations", detail: String(err).slice(0, 200) }));
  }
});

// GET /api/risk-governor/events?limit=50
router.get("/risk-governor/events", async (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 50)));
  try {
    const rows = await db.select().from(riskGovernorEventsTable)
      .orderBy(desc(riskGovernorEventsTable.createdAt)).limit(limit);
    res.json(envelope({ events: rows, count: rows.length }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Failed to list events", detail: String(err).slice(0, 200) }));
  }
});

// POST /api/risk-governor/demo — convenience: persist current eval and return everything useful.
router.post("/risk-governor/demo", async (req, res) => {
  try {
    const log = {
      info: (m: string, x?: Record<string, unknown>) => req.log?.info?.(x ?? {}, `HH governor: ${m}`),
      warn: (m: string, x?: Record<string, unknown>) => req.log?.warn?.(x ?? {}, `HH governor: ${m}`),
      error: (m: string, x?: Record<string, unknown>) => req.log?.error?.(x ?? {}, `HH governor: ${m}`),
    };
    const e = await evaluateGovernor({ persist: true, log, userId: req.authUser?.id ?? null });
    const recent = await db.select().from(riskGovernorEvaluationsTable)
      .orderBy(desc(riskGovernorEvaluationsTable.createdAt)).limit(5);
    const recentEvents = await db.select().from(riskGovernorEventsTable)
      .orderBy(desc(riskGovernorEventsTable.createdAt)).limit(10);
    res.json(envelope({ demo: true, governor: e, recent_evaluations: recent.length, recent_events: recentEvents.length }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Demo failed", detail: String(err).slice(0, 200) }));
  }
});

// POST /api/risk-governor/simulate — apply scenario overrides for testing.
const SimulateBody = z.object({
  forceCanPlaceTradesTrue: z.boolean().optional(),
  forceLiveTradingFlag: z.boolean().optional(),
  forceMarketDataMode: z.enum(["read_only", "live_writable", "missing"]).optional(),
  forceDailyPnl: z.number().optional(),
  forceOpenPaperTrades: z.number().int().nonnegative().optional(),
  forceRevengeCooldown: z.boolean().optional(),
  forceMarketDataQuality: z.enum(["GOOD", "DEGRADED", "FALLBACK_ONLY", "FAILED", "UNKNOWN"]).optional(),
  forceAutopilotErrorRate: z.number().min(0).max(100).optional(),
  forceSampleSize: z.number().int().nonnegative().optional(),
  forceWinRate: z.number().min(0).max(100).optional(),
  forceLearningConfidence: z.number().min(0).max(100).optional(),
  forceRepeatedMistakes: z.number().int().nonnegative().optional(),
  persist: z.boolean().optional().default(false),
});
router.post("/risk-governor/simulate", async (req, res) => {
  const parse = SimulateBody.safeParse(req.body ?? {});
  if (!parse.success) { res.status(400).json(envelope({ error: "Invalid body", issues: parse.error.issues })); return; }
  const { persist, ...simulate } = parse.data;
  try {
    const log = {
      info: (m: string, x?: Record<string, unknown>) => req.log?.info?.(x ?? {}, `HH governor[sim]: ${m}`),
      warn: (m: string, x?: Record<string, unknown>) => req.log?.warn?.(x ?? {}, `HH governor[sim]: ${m}`),
      error: (m: string, x?: Record<string, unknown>) => req.log?.error?.(x ?? {}, `HH governor[sim]: ${m}`),
    };
    const e = await evaluateGovernor({ persist, log, simulate: simulate as SimulateOverrides, userId: req.authUser?.id ?? null });
    res.json(envelope({ simulate: simulate as Record<string, unknown>, governor: e, persisted: !!persist }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Simulate failed", detail: String(err).slice(0, 200) }));
  }
});

export default router;
