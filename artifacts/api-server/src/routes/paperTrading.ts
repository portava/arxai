// (Q) Build Q — Paper Trading Sandbox routes.
//
// SAFETY (strict freeze): this router NEVER calls /execute-trade, /mt5-*,
// trades.ts, live_positions, or safetyCore. It only mutates paper_* tables.
// Every order/event is labeled "Simulated" in payloads.
//
// Trade Engine (Tier 1): open / modify / close are the PAPER mode of the one
// pipeline — submitTrade({ mode: "PAPER" }) in lib/tradeEngine/pipeline.ts,
// which runs the Risk Governor and writes the simulator book in
// lib/tradeEngine/paperVenue.ts. This router keeps account management and
// the HTTP envelope; it no longer writes paper_orders itself.
//
// OWNERSHIP: every account and order is scoped to req.authUser. A caller can
// only see or mutate rows whose user_id is their own; another user's row (or
// a legacy ownerless row) answers 404, never 403, so ids cannot be probed.

import { Router } from "express";
import {
  db, paperAccountsTable, paperOrdersTable,
  vaultEventsTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import { submitTrade, type TradeResult } from "../lib/tradeEngine/pipeline.js";
import {
  SIMULATED_TAG, getMockPrice, markToMarket, ownPaperAccount as ownAccount,
} from "../lib/tradeEngine/paperVenue.js";

// Kept for existing importers; the simulator price lives in the PAPER venue.
export { getMockPrice };

const router = Router();

// Unified response envelope so EVERY paper response (success or error) carries
// the simulated flag + disclaimer (architect fix #2).
function ok(res: import("express").Response, body: Record<string, unknown>) {
  return res.json({ ...body, simulated: true, disclaimer: SIMULATED_TAG });
}
function fail(res: import("express").Response, status: number, error: string, extra?: Record<string, unknown>) {
  return res.status(status).json({ error, ...(extra ?? {}), simulated: true, disclaimer: SIMULATED_TAG });
}

async function vaultBehavior(kind: string, payload: Record<string, unknown>) {
  await db.insert(vaultEventsTable).values({
    kind, severity: "INFO", source: "SYSTEM", truthDomain: "BEHAVIOR",
    summary: kind, payload: { ...payload, simulated: true, disclaimer: SIMULATED_TAG },
    reasons: [], blockers: [], generatedAtIso: new Date().toISOString(),
  }).catch(() => { /* non-fatal */ });
}

/** Map a PAPER pipeline refusal to this router's existing HTTP envelope. */
function paperRefused(res: import("express").Response, r: Extract<TradeResult, { ok: false }>) {
  switch (r.reason) {
    case "PAPER_ACCOUNT_NOT_FOUND": return fail(res, 404, "Paper account not found");
    case "PAPER_ORDER_NOT_FOUND": return fail(res, 404, "Not found");
    case "PAPER_ORDER_NOT_OPEN": return fail(res, 409, "Order not open");
    case "INVALID_SLTP_GEOMETRY":
      return fail(res, 400, "Invalid SL/TP geometry for direction",
        r.detail?.entryPrice !== undefined ? { entryPrice: r.detail.entryPrice } : undefined);
    case "RISK_GOVERNOR_BLOCK":
      return fail(res, 422, r.detail?.primaryReason ?? "Blocked by Risk Governor", {
        code: "RISK_GOVERNOR_BLOCK", blockedBy: r.detail?.blockedBy, auditEventId: r.detail?.auditEventId,
      });
    default: return fail(res, 500, r.reason);
  }
}

// ── Validation ─────────────────────────────────────────────────────────────
const CreateAccountBody = z.object({
  accountName: z.string().min(1).max(64).default("Practice"),
  startingBalance: z.number().positive().default(10_000),
});

const PlaceOrderBody = z.object({
  paperAccountId: z.number().int().positive(),
  symbol: z.string().min(1).max(64),
  direction: z.enum(["BUY","SELL"]),
  orderType: z.enum(["MARKET","LIMIT"]).default("MARKET"),
  lotSize: z.number().positive().max(100).default(0.01),
  entryPrice: z.number().positive().optional(),  // MARKET → derived
  stopLoss: z.number().positive(),
  takeProfit: z.number().positive(),
  strategyId: z.string().max(64).optional(),
  tradePlanId: z.number().int().positive().optional(),
  // (BB) Optional Build AA decision_id this order was placed against.
  decisionId: z.number().int().positive().optional(),
});

const UpdateOrderBody = z.object({
  stopLoss: z.number().positive().optional(),
  takeProfit: z.number().positive().optional(),
});

// ── POST /paper/accounts ───────────────────────────────────────────────────
router.post("/paper/accounts", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const b = CreateAccountBody.parse(req.body ?? {});
    // Deactivate this user's prior active accounts so each user has one active.
    await db.update(paperAccountsTable).set({ isActive: 0 })
      .where(and(eq(paperAccountsTable.userId, userId), eq(paperAccountsTable.isActive, 1)));
    const ins = await db.insert(paperAccountsTable).values({
      userId,
      accountName: b.accountName,
      startingBalance: b.startingBalance,
      currentBalance: b.startingBalance,
      equity: b.startingBalance,
      isActive: 1,
    }).returning();
    await vaultBehavior("PAPER_ACCOUNT_CREATED", { accountId: ins[0]!.id, name: b.accountName });
    ok(res, { account: ins[0] }); return;
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /paper/accounts failed");
    fail(res, 500, "Failed to create account");
  }
});

// ── GET /paper/accounts ────────────────────────────────────────────────────
router.get("/paper/accounts", requireUser, async (req, res): Promise<void> => {
  const mine = eq(paperAccountsTable.userId, req.authUser!.id);
  const rows = await db.select().from(paperAccountsTable).where(mine).orderBy(desc(paperAccountsTable.createdAt));
  // Refresh every account so list state is consistent (architect fix #3).
  for (const r of rows) await markToMarket(r.id);
  const refreshed = await db.select().from(paperAccountsTable).where(mine).orderBy(desc(paperAccountsTable.createdAt));
  ok(res, { accounts: refreshed });
});

// ── GET /paper/accounts/active ─────────────────────────────────────────────
router.get("/paper/accounts/active", requireUser, async (req, res): Promise<void> => {
  const rows = await db.select().from(paperAccountsTable)
    .where(and(eq(paperAccountsTable.userId, req.authUser!.id), eq(paperAccountsTable.isActive, 1)))
    .orderBy(desc(paperAccountsTable.createdAt)).limit(1);
  if (!rows[0]) { fail(res, 404, "No active paper account"); return; }
  const refreshed = await markToMarket(rows[0].id);
  ok(res, { account: refreshed ?? rows[0] });
});

// ── POST /paper/orders ─────────────────────────────────────────────────────
router.post("/paper/orders", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const b = PlaceOrderBody.parse(req.body ?? {});
    const r = await submitTrade({
      mode: "PAPER", intent: "OPEN", userId,
      paperAccountId: b.paperAccountId, symbol: b.symbol, side: b.direction, orderType: b.orderType,
      lots: b.lotSize, entryPrice: b.entryPrice ?? null, stopLoss: b.stopLoss, takeProfit: b.takeProfit,
      strategyId: b.strategyId ?? null, tradePlanId: b.tradePlanId ?? null, decisionId: b.decisionId ?? null,
      sourcePage: "POST /paper/orders",
    });
    if (!r.ok) { paperRefused(res, r); return; }
    ok(res, { order: r.paperOrder });
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /paper/orders failed");
    fail(res, 500, "Failed to place order");
  }
});

// ── PATCH /paper/orders/:id ────────────────────────────────────────────────
router.patch("/paper/orders/:id", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) { fail(res, 400, "Invalid id"); return; }
    const b = UpdateOrderBody.parse(req.body ?? {});
    const r = await submitTrade({
      mode: "PAPER", intent: "MODIFY", userId, orderId: id,
      stopLoss: b.stopLoss, takeProfit: b.takeProfit, sourcePage: "PATCH /paper/orders/:id",
    });
    if (!r.ok) { paperRefused(res, r); return; }
    ok(res, { order: r.paperOrder });
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "PATCH /paper/orders/:id failed");
    fail(res, 500, "Failed to update order");
  }
});

// ── POST /paper/orders/:id/close ───────────────────────────────────────────
router.post("/paper/orders/:id/close", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) { fail(res, 400, "Invalid id"); return; }
    const r = await submitTrade({ mode: "PAPER", intent: "CLOSE", userId, orderId: id, sourcePage: "POST /paper/orders/:id/close" });
    if (!r.ok) { paperRefused(res, r); return; }
    ok(res, { order: r.paperOrder });
  } catch (err) {
    req.log.error({ err: String(err) }, "POST /paper/orders/:id/close failed");
    fail(res, 500, "Failed to close order");
  }
});

// ── GET /paper/orders ──────────────────────────────────────────────────────
router.get("/paper/orders", requireUser, async (req, res): Promise<void> => {
  try {
    const accountId = Number(req.query["accountId"]);
    const status = String(req.query["status"] ?? "");
    if (!Number.isFinite(accountId)) { fail(res, 400, "accountId required"); return; }
    if (!(await ownAccount(accountId, req.authUser!.id))) { fail(res, 404, "Paper account not found"); return; }
    await markToMarket(accountId);
    const mine = and(eq(paperOrdersTable.paperAccountId, accountId), eq(paperOrdersTable.userId, req.authUser!.id));
    const where = status === "OPEN" ? and(mine, eq(paperOrdersTable.status, "OPEN")) : mine;
    const rows = await db.select().from(paperOrdersTable)
      .where(where).orderBy(desc(paperOrdersTable.openedAt)).limit(200);
    ok(res, { orders: rows });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /paper/orders failed");
    fail(res, 500, "Failed to load orders");
  }
});

// ── GET /paper/history ─────────────────────────────────────────────────────
router.get("/paper/history", requireUser, async (req, res): Promise<void> => {
  try {
    const accountId = Number(req.query["accountId"]);
    if (!Number.isFinite(accountId)) { fail(res, 400, "accountId required"); return; }
    if (!(await ownAccount(accountId, req.authUser!.id))) { fail(res, 404, "Paper account not found"); return; }
    // Refresh state before computing history (architect fix #3).
    await markToMarket(accountId);
    const orders = await db.select().from(paperOrdersTable)
      .where(and(eq(paperOrdersTable.paperAccountId, accountId), eq(paperOrdersTable.userId, req.authUser!.id)))
      .orderBy(desc(paperOrdersTable.openedAt)).limit(500);
    const closed = orders.filter((o) => o.status !== "OPEN");
    const wins = closed.filter((o) => o.profitLoss > 0).length;
    const losses = closed.filter((o) => o.profitLoss < 0).length;
    const netPnl = closed.reduce((s, o) => s + o.profitLoss, 0);
    ok(res, {
      orders, closedCount: closed.length, wins, losses,
      winRate: closed.length > 0 ? wins / closed.length : 0,
      netPnl,
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /paper/history failed");
    fail(res, 500, "Failed to load history");
  }
});

export default router;
