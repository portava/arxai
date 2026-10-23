// Build EE — Paper Execution routes.
//
// SAFETY (strict freeze): NONE of these endpoints place real trades or call
// MT5 / executeTrade / setCanPlaceTrades / live broker. They only delegate to
// the paper execution service which writes to paper_orders / paper_executions
// / paper_execution_logs and reads Build DD market data.

import { Router } from "express";
import { z } from "zod/v4";
import {
  db, paperExecutionsTable, paperExecutionLogsTable, paperOrdersTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import {
  executePaperFromDecision,
  loadDecisionFromLog,
  listOpenPaperExecutions,
  listPaperExecutions,
} from "../lib/paperExecution/paperExecutionService.js";
import {
  runPaperMonitor,
  closePaperManually,
} from "../lib/paperExecution/paperExecutionMonitor.js";
import type { TradeDecision } from "./tradeDecision.js";

const router = Router();
const PAPER_TAG = "Simulated paper execution — Build EE never places live trades, never touches MT5/canPlaceTrades.";

function ok(res: import("express").Response, body: Record<string, unknown>) {
  return res.json({ ...body, system: "paperExecution", simulated: true, disclaimer: PAPER_TAG });
}
function fail(res: import("express").Response, status: number, error: string, extra?: Record<string, unknown>) {
  return res.status(status).json({ error, ...(extra ?? {}), system: "paperExecution", simulated: true, disclaimer: PAPER_TAG });
}

// ── POST /paper-execution/from-decision ───────────────────────────────────
const FromDecisionBody = z.object({
  decisionId: z.number().int().positive(),
  allowConflicts: z.boolean().optional().default(false),
  paperAccountId: z.number().int().positive().optional(),
});
router.post("/paper-execution/from-decision", async (req, res): Promise<void> => {
  const parse = FromDecisionBody.safeParse(req.body ?? {});
  if (!parse.success) { fail(res, 400, "Invalid body", { issues: parse.error.issues }); return; }
  const { decisionId, allowConflicts, paperAccountId } = parse.data;
  try {
    const decision = await loadDecisionFromLog(decisionId);
    if (!decision) { fail(res, 404, `Decision ${decisionId} not found in trade_decision_logs`); return; }
    const result = await executePaperFromDecision(decision, decisionId, { allowConflicts, paperAccountId });
    ok(res, { execution: result });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "POST /paper-execution/from-decision failed");
    fail(res, 500, "Failed to execute paper trade", { detail: String(err).slice(0, 300) });
  }
});

// ── POST /paper-execution/demo ────────────────────────────────────────────
// Convenience: synthesize a passing decision in-memory (NOT stored in
// trade_decision_logs) and execute. Useful for end-to-end smoke tests.
const DemoBody = z.object({
  symbol: z.string().min(1).default("Volatility 75 Index"),
  action: z.enum(["BUY", "SELL"]).default("BUY"),
  decisionId: z.number().int().positive().optional(),
});
router.post("/paper-execution/demo", async (req, res): Promise<void> => {
  const parse = DemoBody.safeParse(req.body ?? {});
  if (!parse.success) { fail(res, 400, "Invalid body", { issues: parse.error.issues }); return; }
  const { symbol, action } = parse.data;
  try {
    // Pull a current quote so SL/TP geometry is valid.
    const { getMarketData } = await import("../lib/marketData/marketDataService.js");
    const md = await getMarketData({ symbol, timeframe: "M5", limit: 100 });
    const px = md.snapshot.mid;
    // Widen SL/TP buffer to absorb the drift between this quote and the
    // service's own re-fetch (the FALLBACK provider is per-call randomized).
    const slDelta = px * 0.08;
    const tpDelta = px * 0.16;
    const decision: TradeDecision = {
      shouldTrade: true,
      action,
      symbol,
      confidence: 75,
      riskScore: 40,
      entryReason: "Build EE demo synthetic decision",
      invalidationReason: "demo",
      stopLoss:  action === "BUY" ? px - slDelta : px + slDelta,
      takeProfit: action === "BUY" ? px + tpDelta : px - tpDelta,
      positionSize: 0.05,
      tradeWindow: { status: "GOOD", reason: "demo" },
      signalsUsed: [],
      warnings: [],
      blockers: [],
      operationalMode: "PAPER_DEMO",
      syntheticData: false,
      timestamp: new Date().toISOString(),
      marketDataSummary: {
        source: md.snapshot.source, provider: md.snapshot.provider,
        symbol: md.snapshot.symbol, mid: md.snapshot.mid, spread: md.snapshot.spread,
        timestamp: md.snapshot.timestamp, timeframe: md.snapshot.timeframe,
        dataQualityStatus: md.snapshot.dataQuality.status,
        candlesAvailable: md.snapshot.dataQuality.candlesAvailable,
        volatilityLevel: md.snapshot.sessionContext.volatilityLevel,
        liquidityLevel: md.snapshot.sessionContext.liquidityLevel,
        warnings: md.snapshot.dataQuality.warnings,
        blockers: [],
      },
    };

    const decisionId = parse.data.decisionId
      ?? await persistSyntheticDecisionLog(decision);

    const result = await executePaperFromDecision(decision, decisionId, { allowConflicts: false });
    ok(res, { decisionIdUsed: decisionId, execution: result, marketData: md.snapshot });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "POST /paper-execution/demo failed");
    fail(res, 500, "Failed to execute demo", { detail: String(err).slice(0, 300) });
  }
});

async function persistSyntheticDecisionLog(d: TradeDecision): Promise<number> {
  const { tradeDecisionLogsTable } = await import("@workspace/db");
  const ins = await db.insert(tradeDecisionLogsTable).values({
    symbol: d.symbol, action: d.action, shouldTrade: d.shouldTrade,
    confidence: d.confidence, riskScore: d.riskScore,
    invalidationReason: d.invalidationReason,
    stopLoss: d.stopLoss, takeProfit: d.takeProfit, positionSize: d.positionSize,
    tradeWindowStatus: d.tradeWindow.status, tradeWindowReason: d.tradeWindow.reason,
    decisionJson: d as unknown as Record<string, unknown>,
  }).returning({ id: tradeDecisionLogsTable.id });
  return ins[0]!.id;
}

// ── GET /paper-execution/open ─────────────────────────────────────────────
router.get("/paper-execution/open", async (_req, res): Promise<void> => {
  const rows = await listOpenPaperExecutions(50);
  ok(res, { open: rows, count: rows.length });
});

// ── GET /paper-execution/trades?limit=20 ──────────────────────────────────
router.get("/paper-execution/trades", async (req, res): Promise<void> => {
  const limit = Math.min(200, Math.max(1, Number(req.query["limit"] ?? 20) || 20));
  const rows = await listPaperExecutions(limit);
  ok(res, { trades: rows, count: rows.length });
});

// ── GET /paper-execution/trade/:id ────────────────────────────────────────
router.get("/paper-execution/trade/:id", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) { fail(res, 400, "Invalid id"); return; }
  const exec = (await db.select().from(paperExecutionsTable)
    .where(eq(paperExecutionsTable.id, id)).limit(1))[0];
  if (!exec) { fail(res, 404, "Paper execution not found"); return; }
  const order = exec.orderId
    ? (await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.id, exec.orderId)).limit(1))[0]
    : null;
  const logs = await db.select().from(paperExecutionLogsTable)
    .where(eq(paperExecutionLogsTable.executionId, exec.executionId))
    .orderBy(desc(paperExecutionLogsTable.createdAt)).limit(50);
  ok(res, { execution: exec, paperOrder: order, logs });
});

// ── POST /paper-execution/monitor ─────────────────────────────────────────
const MonitorBody = z.object({
  forcePrice: z.number().optional(),
  forceSymbol: z.string().optional(),
});
router.post("/paper-execution/monitor", async (req, res): Promise<void> => {
  const parse = MonitorBody.safeParse(req.body ?? {});
  if (!parse.success) { fail(res, 400, "Invalid body", { issues: parse.error.issues }); return; }
  try {
    const summary = await runPaperMonitor(parse.data);
    ok(res, { monitor: summary });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "POST /paper-execution/monitor failed");
    fail(res, 500, "Monitor run failed", { detail: String(err).slice(0, 300) });
  }
});

// ── POST /paper-execution/close/:id ───────────────────────────────────────
router.post("/paper-execution/close/:id", async (req, res): Promise<void> => {
  const orderId = Number(req.params["id"]);
  if (!Number.isFinite(orderId)) { fail(res, 400, "Invalid id"); return; }
  const exitPrice = typeof req.body?.exitPrice === "number" ? req.body.exitPrice : undefined;
  try {
    const r = await closePaperManually(orderId, exitPrice != null ? { exitPrice } : undefined);
    if (!r.ok) { fail(res, 409, r.error ?? "close failed"); return; }
    ok(res, { close: r });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "POST /paper-execution/close failed");
    fail(res, 500, "Close failed", { detail: String(err).slice(0, 300) });
  }
});

export default router;
