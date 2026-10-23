// ARX AI — Paper Intelligence routes.
//
// SAFETY (strict freeze): this router NEVER calls /execute-trade,
// /mt5/execute, trades.ts, live_positions, the broker placement layer,
// or any LIVE_TRADING surface. It only:
//   - reads MT5 snapshot (read-only),
//   - runs strategyEngine + position sizing in-memory,
//   - writes/reads `paper_trade_ideas` (paper-only table),
//   - exercises the central read-only guard for blocked-execution tests.

import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { and, desc, eq } from "drizzle-orm";
import { db, paperTradeIdeasTable } from "@workspace/db";
import { analyzeSymbolForPaper } from "../lib/paperIntelligence.js";
import { blockBrokerExecution } from "../lib/readOnlyGuard.js";

const router = Router();
const DISCLAIMER = "Paper-only intelligence. Does not place real trades.";

const analyzeBody = z.object({
  symbol: z.string().min(1).max(64),
  riskPercent: z.number().positive().max(5).optional(),
  marketType: z.enum(["forex", "indices", "stocks", "synthetic"]).optional(),
  minConfidence: z.number().min(0).max(100).optional(),
});

router.post("/intelligence/analyze", async (req: Request, res: Response) => {
  const parsed = analyzeBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid analyze body", details: parsed.error.issues, paperOnly: true, disclaimer: DISCLAIMER });
  }
  try {
    const result = await analyzeSymbolForPaper(parsed.data);
    return res.json({ ...result, disclaimer: DISCLAIMER });
  } catch (err) {
    req.log.error({ err: String(err) }, "paperIntelligence analyze failed");
    return res.status(500).json({ error: "ANALYZE_FAILED", paperOnly: true, disclaimer: DISCLAIMER });
  }
});

const ideaCreateBody = z.object({
  symbol: z.string().min(1).max(64),
  direction: z.enum(["BUY", "SELL"]),
  entryIdea: z.number(),
  stopLossIdea: z.number(),
  takeProfitIdea: z.number(),
  riskPercent: z.number().positive().max(5).default(0.5),
  confidenceScore: z.number().min(0).max(100).default(0),
  riskScore: z.number().min(0).max(100).default(0),
  suggestedLot: z.number().nonnegative().default(0),
  aiReasoning: z.string().max(8000).default(""),
  strategySource: z.string().max(128).optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["WATCHLIST", "PAPER_OPEN", "PAPER_CLOSED", "REJECTED"]).default("WATCHLIST"),
});

router.post("/ideas", async (req: Request, res: Response) => {
  const parsed = ideaCreateBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid idea body", details: parsed.error.issues, paperOnly: true, disclaimer: DISCLAIMER });
  }
  const v = parsed.data;
  const inserted = await db.insert(paperTradeIdeasTable).values({
    symbol: v.symbol,
    direction: v.direction,
    entryIdea: v.entryIdea,
    stopLossIdea: v.stopLossIdea,
    takeProfitIdea: v.takeProfitIdea,
    riskPercent: v.riskPercent,
    confidenceScore: v.confidenceScore,
    riskScore: v.riskScore,
    suggestedLot: v.suggestedLot,
    aiReasoning: v.aiReasoning,
    strategySource: v.strategySource ?? null,
    inputs: v.inputs ?? {},
    status: v.status,
  }).returning();
  return res.json({ idea: inserted[0], paperOnly: true, disclaimer: DISCLAIMER });
});

const listQuery = z.object({
  status: z.enum(["WATCHLIST", "PAPER_OPEN", "PAPER_CLOSED", "REJECTED"]).optional(),
  symbol: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

router.get("/ideas", async (req: Request, res: Response) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query", details: parsed.error.issues, paperOnly: true, disclaimer: DISCLAIMER });
  }
  const { status, symbol, limit } = parsed.data;
  const filters = [
    status ? eq(paperTradeIdeasTable.status, status) : undefined,
    symbol ? eq(paperTradeIdeasTable.symbol, symbol) : undefined,
  ].filter(Boolean) as ReturnType<typeof eq>[];
  const where = filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);
  const rows = where
    ? await db.select().from(paperTradeIdeasTable).where(where).orderBy(desc(paperTradeIdeasTable.createdAt)).limit(limit)
    : await db.select().from(paperTradeIdeasTable).orderBy(desc(paperTradeIdeasTable.createdAt)).limit(limit);
  return res.json({ ideas: rows, count: rows.length, paperOnly: true, disclaimer: DISCLAIMER });
});

const patchBody = z.object({
  status: z.enum(["WATCHLIST", "PAPER_OPEN", "PAPER_CLOSED", "REJECTED"]).optional(),
  outcomePnl: z.number().optional(),
  outcomeNote: z.string().max(2000).optional(),
});

// Single-direction lifecycle: WATCHLIST → PAPER_OPEN → PAPER_CLOSED.
// REJECTED is a terminal exit from any non-terminal state. Terminal
// states (PAPER_CLOSED / REJECTED) cannot transition. This matches the
// schema invariant comment and prevents reopening closed ideas.
const ALLOWED_TRANSITIONS: Record<string, ReadonlyArray<string>> = {
  WATCHLIST:    ["PAPER_OPEN", "REJECTED"],
  PAPER_OPEN:   ["PAPER_CLOSED", "REJECTED"],
  PAPER_CLOSED: [],
  REJECTED:     [],
};

router.patch("/ideas/:id", async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid id", paperOnly: true, disclaimer: DISCLAIMER });
  }
  const parsed = patchBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid patch body", details: parsed.error.issues, paperOnly: true, disclaimer: DISCLAIMER });
  }
  const existing = (await db.select().from(paperTradeIdeasTable).where(eq(paperTradeIdeasTable.id, id)).limit(1))[0];
  if (!existing) {
    return res.status(404).json({ error: "Not found", paperOnly: true, disclaimer: DISCLAIMER });
  }
  const next = parsed.data.status;
  if (next !== undefined && next !== existing.status) {
    const allowed = ALLOWED_TRANSITIONS[existing.status] ?? [];
    if (!allowed.includes(next)) {
      return res.status(409).json({
        error: "ILLEGAL_LIFECYCLE_TRANSITION",
        from: existing.status, to: next, allowed,
        paperOnly: true, disclaimer: DISCLAIMER,
      });
    }
  }
  const updated = await db.update(paperTradeIdeasTable).set({
    ...(next                            !== undefined ? { status: next } : {}),
    ...(parsed.data.outcomePnl          !== undefined ? { outcomePnl: parsed.data.outcomePnl } : {}),
    ...(parsed.data.outcomeNote         !== undefined ? { outcomeNote: parsed.data.outcomeNote } : {}),
    updatedAt: new Date(),
  }).where(eq(paperTradeIdeasTable.id, id)).returning();
  return res.json({ idea: updated[0], paperOnly: true, disclaimer: DISCLAIMER });
});

// ── Sentinel: prove the central read-only guard returns the documented
//    shape and writes a vault row. NEVER reaches MT5 / broker.
const blockedTestBody = z.object({
  attemptKind: z.string().min(1).default("PLACE_ORDER"),
  symbol: z.string().optional(),
  direction: z.enum(["BUY", "SELL"]).optional(),
  lot: z.number().optional(),
  source: z.string().min(1).default("paper-intelligence:blocked-execution-test"),
  actor: z.string().optional(),
});

router.post("/intelligence/blocked-execution-test", async (req: Request, res: Response) => {
  const parsed = blockedTestBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.issues, paperOnly: true, disclaimer: DISCLAIMER });
  }
  const envelope = await blockBrokerExecution(parsed.data);
  return res.status(200).json({ ...envelope, paperOnly: true, disclaimer: DISCLAIMER });
});

export default router;
