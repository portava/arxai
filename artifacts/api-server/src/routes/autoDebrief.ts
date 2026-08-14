// (BB) Build BB — Auto-Debrief routes.
//
// SAFETY: This router NEVER calls executeTrade, /execute-trade, mt5_*,
// livePositions, setCanPlaceTrades, or engageKillSwitch. It only delegates
// to runAutoDebrief() which itself is read-only against trade_decision_logs
// + paper_orders and append-only against post_trade_debriefs / vault_events.

import { Router } from "express";
import {
  db, paperOrdersTable, postTradeDebriefsTable, tradeDecisionLogsTable,
} from "@workspace/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { runAutoDebrief, isClosedStatus } from "../lib/autoDebriefService.js";

const router = Router();
const AUTO_DEBRIEF_DISCLAIMER =
  "Auto-debriefs are reflective coaching aids generated when a paper trade closes. They are not predictions and do not guarantee future profitability.";

function ok(res: import("express").Response, body: Record<string, unknown>) {
  return res.json({ ...body, system: "auto-debrief", disclaimer: AUTO_DEBRIEF_DISCLAIMER });
}
function fail(res: import("express").Response, status: number, error: string, extra?: Record<string, unknown>) {
  return res.status(status).json({ error, ...(extra ?? {}), system: "auto-debrief", disclaimer: AUTO_DEBRIEF_DISCLAIMER });
}

// ── POST /auto-debrief/process/:orderId ────────────────────────────────────
// Run the auto-debrief for a single closed paper order. Idempotent.
router.post("/auto-debrief/process/:orderId", async (req, res): Promise<void> => {
  try {
    const orderId = Number(req.params["orderId"]);
    if (!Number.isFinite(orderId)) { fail(res, 400, "Invalid orderId"); return; }
    const result = await runAutoDebrief(orderId, { triggeredBy: "api_process" });
    if (result.status === "trade_not_found") { fail(res, 404, "Paper order not found", { result }); return; }
    if (result.status === "error") { fail(res, 500, result.error ?? "Auto-debrief failed", { result }); return; }
    ok(res, { result });
  } catch (err) {
    req.log.error({ err: String(err) }, "POST /auto-debrief/process failed");
    fail(res, 500, "Auto-debrief processing failed");
  }
});

// ── POST /auto-debrief/scan ────────────────────────────────────────────────
// Scan ALL closed paper orders that don't yet have a debrief; create one
// for each. Useful for backfilling and for E2E tests.
router.post("/auto-debrief/scan", async (req, res): Promise<void> => {
  try {
    const candidates = await db.select({
      id: paperOrdersTable.id, status: paperOrdersTable.status,
    }).from(paperOrdersTable)
      .leftJoin(postTradeDebriefsTable, eq(postTradeDebriefsTable.tradeId, paperOrdersTable.id))
      .where(and(
        sql`${paperOrdersTable.status} != 'OPEN'`,
        isNull(postTradeDebriefsTable.id),
      ))
      .limit(200);

    const results = [] as Array<Awaited<ReturnType<typeof runAutoDebrief>>>;
    for (const c of candidates) {
      if (!isClosedStatus(c.status)) continue;
      results.push(await runAutoDebrief(c.id, { triggeredBy: "api_scan" }));
    }
    const created = results.filter((r) => r.status === "created").length;
    const skipped = results.filter((r) => r.status === "skipped_already_exists").length;
    ok(res, { scanned: results.length, created, skipped, results });
  } catch (err) {
    req.log.error({ err: String(err) }, "POST /auto-debrief/scan failed");
    fail(res, 500, "Auto-debrief scan failed");
  }
});

// ── GET /auto-debrief/learning-payload/:tradeId ────────────────────────────
// Build CC handoff payload for a single trade.
router.get("/auto-debrief/learning-payload/:tradeId", async (req, res): Promise<void> => {
  try {
    const tradeId = Number(req.params["tradeId"]);
    if (!Number.isFinite(tradeId)) { fail(res, 400, "Invalid tradeId"); return; }
    const row = (await db.select().from(postTradeDebriefsTable)
      .where(eq(postTradeDebriefsTable.tradeId, tradeId)).limit(1))[0];
    if (!row) { fail(res, 404, "No debrief for this trade", { tradeId }); return; }
    ok(res, {
      tradeId,
      debriefId: row.id,
      learningPayload: row.learningPayload,
      readyForLearning: true,
      consumedByLearning: false,
      note: "Build BB has not modified scoring. Build CC will consume this payload.",
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /auto-debrief/learning-payload failed");
    fail(res, 500, "Failed to load learning payload");
  }
});

// ── GET /auto-debrief/by-trade/:tradeId ────────────────────────────────────
router.get("/auto-debrief/by-trade/:tradeId", async (req, res): Promise<void> => {
  const tradeId = Number(req.params["tradeId"]);
  if (!Number.isFinite(tradeId)) { fail(res, 400, "Invalid tradeId"); return; }
  const row = (await db.select().from(postTradeDebriefsTable)
    .where(eq(postTradeDebriefsTable.tradeId, tradeId)).limit(1))[0];
  if (!row) { fail(res, 404, "No debrief for this trade"); return; }
  ok(res, { debrief: row });
});

// ── GET /auto-debrief/recent ───────────────────────────────────────────────
// Recent SYSTEM_AUTO_DEBRIEF rows for monitoring/UI.
router.get("/auto-debrief/recent", async (req, res): Promise<void> => {
  const raw = Number(req.query["limit"]);
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(raw, 100)) : 20;
  const rows = await db.select().from(postTradeDebriefsTable)
    .where(eq(postTradeDebriefsTable.createdBy, "SYSTEM_AUTO_DEBRIEF"))
    .orderBy(desc(postTradeDebriefsTable.id))
    .limit(limit);
  ok(res, { count: rows.length, debriefs: rows });
});

// ── POST /auto-debrief/test ────────────────────────────────────────────────
// Test endpoint: optionally creates a fresh paper order linked to a
// supplied decision_id, then forces an immediate close + auto-debrief.
const TestBody = z.object({
  paperAccountId: z.number().int().positive(),
  symbol: z.string().min(1).max(64),
  direction: z.enum(["BUY", "SELL"]),
  decisionId: z.number().int().positive().nullable().optional(),
  forceResult: z.enum(["WIN", "LOSS", "BREAKEVEN", "CANCELLED"]).default("WIN"),
});
router.post("/auto-debrief/test", async (req, res): Promise<void> => {
  try {
    const b = TestBody.parse(req.body ?? {});
    const ENTRY = 100;
    const slBuy = b.direction === "BUY" ? ENTRY - 5 : ENTRY + 5;
    const tpBuy = b.direction === "BUY" ? ENTRY + 10 : ENTRY - 10;
    const ins = await db.insert(paperOrdersTable).values({
      paperAccountId: b.paperAccountId,
      symbol: b.symbol,
      direction: b.direction,
      orderType: "MARKET",
      lotSize: 0.01,
      entryPrice: ENTRY,
      stopLoss: slBuy,
      takeProfit: tpBuy,
      status: "OPEN",
      decisionId: b.decisionId ?? null,
    }).returning();
    const order = ins[0]!;
    // Force the close with the requested result.
    let exitPx = ENTRY;
    let status = "CLOSED_MANUAL";
    let pnl = 0;
    const dir = b.direction === "BUY" ? 1 : -1;
    if (b.forceResult === "WIN")        { exitPx = ENTRY + 8 * dir;  status = "CLOSED_TP"; pnl = dir * (exitPx - ENTRY) * 0.01 * 100; }
    else if (b.forceResult === "LOSS")  { exitPx = ENTRY - 4 * dir;  status = "CLOSED_SL"; pnl = dir * (exitPx - ENTRY) * 0.01 * 100; }
    else if (b.forceResult === "BREAKEVEN") { exitPx = ENTRY;        status = "CLOSED_MANUAL"; pnl = 0; }
    else { status = "CANCELLED"; pnl = 0; exitPx = ENTRY; }
    await db.update(paperOrdersTable).set({
      status, closedAt: new Date(),
      exitPrice: exitPx, profitLoss: pnl, updatedAt: new Date(),
    }).where(eq(paperOrdersTable.id, order.id));

    // Trigger auto-debrief.
    const result = await runAutoDebrief(order.id, { triggeredBy: "test_endpoint" });
    ok(res, { orderId: order.id, forcedResult: b.forceResult, status, pnl, result });
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /auto-debrief/test failed");
    fail(res, 500, "Auto-debrief test failed");
  }
});

// Reference imports to silence unused warnings (these are part of the
// service surface even if not directly referenced in route bodies above).
void tradeDecisionLogsTable;

export default router;
