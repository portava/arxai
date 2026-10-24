// (Q) Build Q — Paper Trading Sandbox routes.
//
// SAFETY (strict freeze): this router NEVER calls /execute-trade, /mt5-*,
// trades.ts, live_positions, or safetyCore. It only mutates paper_* tables.
// Every order/event is labeled "Simulated" in payloads. This is the ONLY
// surface that may write to paper_* tables.
//
// OWNERSHIP: every account and order is scoped to req.authUser. A caller can
// only see or mutate rows whose user_id is their own; another user's row (or
// a legacy ownerless row) answers 404, never 403, so ids cannot be probed.

import { Router } from "express";
import {
  db, paperAccountsTable, paperOrdersTable, paperTradeEventsTable,
  vaultEventsTable,
} from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import { generateDeterministicCandles } from "../lib/backtestStrategyRegistry.js";
import { runAutoDebrief } from "../lib/autoDebriefService.js";
import { enforcePreTradeRisk } from "../lib/riskGovernor/enforce.js";

const router = Router();
const SIMULATED_TAG = "Simulated — paper trading does not guarantee live results.";

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

async function logEvent(userId: number, orderId: number, eventType: string, message: string) {
  await db.insert(paperTradeEventsTable).values({
    userId, paperOrderId: orderId, eventType, message,
  }).catch(() => { /* non-fatal */ });
}

async function ownAccount(id: number, userId: number) {
  return (await db.select().from(paperAccountsTable)
    .where(and(eq(paperAccountsTable.id, id), eq(paperAccountsTable.userId, userId)))
    .limit(1))[0] ?? null;
}

async function ownOrder(id: number, userId: number) {
  return (await db.select().from(paperOrdersTable)
    .where(and(eq(paperOrdersTable.id, id), eq(paperOrdersTable.userId, userId)))
    .limit(1))[0] ?? null;
}

// ── Synthetic mark-to-market price ─────────────────────────────────────────
// Uses the same deterministic candle generator as the backtest engine so the
// "current" price is reproducible per (symbol, second-bucket) and never
// requires a real broker quote. Bucket = 60s so prices feel live but stay
// reproducible within the bucket.
export function getMockPrice(symbol: string, atMs: number): number {
  const bucket = Math.floor(atMs / 60_000) * 60_000;
  const candles = generateDeterministicCandles({
    symbol, count: 1, timeframe: "M1",
    seed: `paper-mtm|${bucket}`, baseTimeMs: bucket,
  });
  return candles[0]?.close ?? 1;
}

function pnlFor(direction: string, lotSize: number, entry: number, exit: number): number {
  const dir = direction === "BUY" ? 1 : -1;
  return dir * (exit - entry) * lotSize * 100;
}

// Mark-to-market: settle SL/TP for any open orders, then RECOMPUTE balance
// from starting balance + Σ(closed-order P&L). Pulling balance from the
// authoritative ledger (closed orders) means manual-close P&L is always
// reflected even if the order transitioned to CLOSED before mark-to-market
// runs (architect fix #1). Equity = balance + unrealized; margin = Σ open lot.
async function markToMarket(accountId: number) {
  const account = (await db.select().from(paperAccountsTable)
    .where(eq(paperAccountsTable.id, accountId)).limit(1))[0];
  if (!account) return null;
  // Only the account owner's orders count toward its balance, so a stray row
  // stamped with another user id can never move this account's equity.
  const ownedBy = account.userId == null
    ? isNull(paperOrdersTable.userId)
    : eq(paperOrdersTable.userId, account.userId);
  const open = await db.select().from(paperOrdersTable)
    .where(and(eq(paperOrdersTable.paperAccountId, accountId), ownedBy,
               eq(paperOrdersTable.status, "OPEN")));
  const now = Date.now();
  let unrealized = 0;
  let margin = 0;

  for (const o of open) {
    const px = getMockPrice(o.symbol, now);
    // (Build EE) EE-managed orders are owned by the Build EE monitor (which
    // uses Build DD market data). Build Q's mark-to-market must NOT auto-close
    // them with mock prices — only refresh unrealized P&L for equity display.
    const eeOwned = o.strategyId === "build_ee_paper_execution";
    let hit: "TP" | "SL" | null = null;
    if (!eeOwned) {
      if (o.direction === "BUY") {
        if (px <= o.stopLoss)         hit = "SL";
        else if (px >= o.takeProfit)  hit = "TP";
      } else {
        if (px >= o.stopLoss)         hit = "SL";
        else if (px <= o.takeProfit)  hit = "TP";
      }
    }
    if (hit) {
      const exitPx = hit === "SL" ? o.stopLoss : o.takeProfit;
      const pnl = pnlFor(o.direction, o.lotSize, o.entryPrice, exitPx);
      const status = hit === "SL" ? "CLOSED_SL" : "CLOSED_TP";
      await db.update(paperOrdersTable).set({
        status, closedAt: new Date(), exitPrice: exitPx,
        profitLoss: pnl, updatedAt: new Date(),
      }).where(eq(paperOrdersTable.id, o.id));
      if (o.userId != null) await logEvent(o.userId, o.id, status, `${SIMULATED_TAG} ${hit} hit at ${exitPx.toFixed(5)}, P&L ${pnl.toFixed(2)}`);
      // (BB) Closed-loop auto-debrief on SL/TP close. Best-effort, idempotent.
      runAutoDebrief(o.id, { triggeredBy: "mark_to_market" })
        .catch(() => { /* non-fatal: never break mark-to-market */ });
    } else {
      unrealized += pnlFor(o.direction, o.lotSize, o.entryPrice, px);
      margin += o.lotSize * 1000;
    }
  }

  // Authoritative balance: starting + Σ realized P&L from EVERY closed order.
  const closed = await db.select().from(paperOrdersTable)
    .where(and(eq(paperOrdersTable.paperAccountId, accountId), ownedBy));
  const realizedTotal = closed
    .filter((o) => o.status !== "OPEN")
    .reduce((s, o) => s + o.profitLoss, 0);
  const newBalance = account.startingBalance + realizedTotal;
  const equity = newBalance + unrealized;
  await db.update(paperAccountsTable).set({
    currentBalance: newBalance, equity, marginUsed: margin, updatedAt: new Date(),
  }).where(eq(paperAccountsTable.id, accountId));

  return (await db.select().from(paperAccountsTable)
    .where(eq(paperAccountsTable.id, accountId)).limit(1))[0] ?? null;
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
    if (!(await ownAccount(b.paperAccountId, userId))) { fail(res, 404, "Paper account not found"); return; }
    const nowMs = Date.now();
    const marketPx = getMockPrice(b.symbol, nowMs);
    const px = b.entryPrice ?? marketPx;
    // Validate SL/TP geometry to refuse malformed paper orders.
    const slOk = b.direction === "BUY" ? b.stopLoss < px   : b.stopLoss > px;
    const tpOk = b.direction === "BUY" ? b.takeProfit > px : b.takeProfit < px;
    if (!slOk || !tpOk) {
      fail(res, 400, "Invalid SL/TP geometry for direction", { entryPrice: px });
      return;
    }
    // Pre-trade Risk Governor: the same 12 rules a live order faces, priced
    // against the paper simulator's market.
    const risk = await enforcePreTradeRisk({
      userId, venue: "PAPER", origin: "manual", action: "OPEN",
      symbol: b.symbol, side: b.direction, lots: b.lotSize,
      entryPrice: b.entryPrice ?? null, stopLoss: b.stopLoss, takeProfit: b.takeProfit,
    }, {
      paperAccountId: b.paperAccountId,
      facts: { quote: { bid: marketPx, ask: marketPx, at: new Date(nowMs), source: "paper_simulator_price" } },
      auditContext: { caller: "POST /paper/orders" },
    });
    if (!risk.allowed) {
      fail(res, 422, risk.primaryReason ?? "Blocked by Risk Governor", {
        code: "RISK_GOVERNOR_BLOCK", blockedBy: risk.blockedBy, auditEventId: risk.auditEventId,
      });
      return;
    }
    const ins = await db.insert(paperOrdersTable).values({
      userId,
      paperAccountId: b.paperAccountId,
      symbol: b.symbol, direction: b.direction, orderType: b.orderType,
      lotSize: b.lotSize, entryPrice: px,
      stopLoss: b.stopLoss, takeProfit: b.takeProfit,
      status: "OPEN",
      strategyId: b.strategyId ?? null,
      tradePlanId: b.tradePlanId ?? null,
      decisionId: b.decisionId ?? null,
    }).returning();
    const order = ins[0]!;
    await logEvent(userId, order.id, "PLACED", `${SIMULATED_TAG} ${b.direction} ${b.symbol} @ ${px.toFixed(5)} SL ${b.stopLoss} TP ${b.takeProfit} lot ${b.lotSize}`);
    await vaultBehavior("PAPER_ORDER_PLACED", {
      orderId: order.id, accountId: b.paperAccountId,
      symbol: b.symbol, direction: b.direction, lotSize: b.lotSize,
    });
    await markToMarket(b.paperAccountId);
    ok(res, { order });
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
    const cur = await ownOrder(id, userId);
    if (!cur) { fail(res, 404, "Not found"); return; }
    if (cur.status !== "OPEN") { fail(res, 409, "Order not open"); return; }
    const next = {
      stopLoss: b.stopLoss ?? cur.stopLoss,
      takeProfit: b.takeProfit ?? cur.takeProfit,
      updatedAt: new Date(),
    };
    const slOk = cur.direction === "BUY" ? next.stopLoss < cur.entryPrice   : next.stopLoss > cur.entryPrice;
    const tpOk = cur.direction === "BUY" ? next.takeProfit > cur.entryPrice : next.takeProfit < cur.entryPrice;
    if (!slOk || !tpOk) { fail(res, 400, "Invalid SL/TP geometry for direction"); return; }
    // Position Guardian: a stop may be tightened freely, but widening it is
    // checked against the trader's per-trade loss limit.
    const nowMs = Date.now();
    const marketPx = getMockPrice(cur.symbol, nowMs);
    const risk = await enforcePreTradeRisk({
      userId, venue: "PAPER", origin: "manual", action: "MODIFY",
      symbol: cur.symbol, side: cur.direction as "BUY" | "SELL", lots: cur.lotSize,
      stopLoss: next.stopLoss, takeProfit: next.takeProfit,
      position: { entryPrice: cur.entryPrice, stopLoss: cur.stopLoss },
    }, {
      paperAccountId: cur.paperAccountId,
      facts: { quote: { bid: marketPx, ask: marketPx, at: new Date(nowMs), source: "paper_simulator_price" } },
      auditContext: { caller: "PATCH /paper/orders/:id", orderId: id },
    });
    if (!risk.allowed) {
      fail(res, 422, risk.primaryReason ?? "Blocked by Risk Governor", {
        code: "RISK_GOVERNOR_BLOCK", blockedBy: risk.blockedBy, auditEventId: risk.auditEventId,
      });
      return;
    }
    await db.update(paperOrdersTable).set(next)
      .where(and(eq(paperOrdersTable.id, id), eq(paperOrdersTable.userId, userId)));
    await logEvent(userId, id, "UPDATED", `${SIMULATED_TAG} SL→${next.stopLoss} TP→${next.takeProfit}`);
    await markToMarket(cur.paperAccountId);
    ok(res, { order: await ownOrder(id, userId) });
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
    const cur = await ownOrder(id, userId);
    if (!cur) { fail(res, 404, "Not found"); return; }
    if (cur.status !== "OPEN") { fail(res, 409, "Order not open"); return; }
    const exitPx = getMockPrice(cur.symbol, Date.now());
    const risk = await enforcePreTradeRisk({
      userId, venue: "PAPER", origin: "manual", action: "CLOSE",
      symbol: cur.symbol, side: cur.direction as "BUY" | "SELL", lots: cur.lotSize,
      intentRef: `paper_close:${id}`,
    }, {
      paperAccountId: cur.paperAccountId,
      facts: { quote: { bid: exitPx, ask: exitPx, at: new Date(), source: "paper_simulator_price" } },
      auditContext: { caller: "POST /paper/orders/:id/close", orderId: id },
    });
    if (!risk.allowed) {
      fail(res, 422, risk.primaryReason ?? "Blocked by Risk Governor", {
        code: "RISK_GOVERNOR_BLOCK", blockedBy: risk.blockedBy, auditEventId: risk.auditEventId,
      });
      return;
    }
    const pnl = pnlFor(cur.direction, cur.lotSize, cur.entryPrice, exitPx);
    await db.update(paperOrdersTable).set({
      status: "CLOSED_MANUAL", closedAt: new Date(), exitPrice: exitPx,
      profitLoss: pnl, updatedAt: new Date(),
    }).where(and(eq(paperOrdersTable.id, id), eq(paperOrdersTable.userId, userId)));
    await logEvent(userId, id, "CLOSED_MANUAL", `${SIMULATED_TAG} closed @ ${exitPx.toFixed(5)}, P&L ${pnl.toFixed(2)}`);
    await vaultBehavior("PAPER_ORDER_CLOSED", { orderId: id, exitPrice: exitPx, pnl, manual: true });
    // markToMarket recomputes balance from starting + Σ closed-order P&L, so
    // this manual close's P&L is now properly reflected (architect fix #1).
    await markToMarket(cur.paperAccountId);
    // (BB) Closed-loop auto-debrief on manual close. Best-effort, idempotent.
    runAutoDebrief(id, { triggeredBy: "manual_close" })
      .catch(() => { /* non-fatal */ });
    ok(res, { order: await ownOrder(id, userId) });
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
