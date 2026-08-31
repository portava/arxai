// (Q) Build Q — Paper Trading Sandbox routes.
//
// SAFETY (strict freeze): this router NEVER calls /execute-trade, /mt5-*,
// trades.ts, live_positions, or safetyCore. It only mutates paper_* tables.
// Every order/event is labeled "Simulated" in payloads. This is the ONLY
// surface that may write to paper_* tables.

import { Router } from "express";
import {
  db, paperAccountsTable, paperOrdersTable, paperTradeEventsTable,
  vaultEventsTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { generateDeterministicCandles } from "../lib/backtestStrategyRegistry.js";
import { runAutoDebrief } from "../lib/autoDebriefService.js";
import { linkTradeToActiveSession, usdToCents, closeResultForPnl } from "../lib/paperSession/manager.js";

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

async function logEvent(orderId: number, eventType: string, message: string) {
  await db.insert(paperTradeEventsTable).values({
    paperOrderId: orderId, eventType, message,
  }).catch(() => { /* non-fatal */ });
}

// ── Synthetic mark-to-market price ─────────────────────────────────────────
// Uses the same deterministic candle generator as the backtest engine so the
// "current" price is reproducible per (symbol, second-bucket) and never
// requires a real broker quote. Bucket = 60s so prices feel live but stay
// reproducible within the bucket.
// Returns null when the symbol has no synthetic price model — callers must
// refuse rather than mark a position to a fabricated 1.0000 price (the old
// `?? 1` default did exactly that for any unmodelled instrument).
function getMockPrice(symbol: string, atMs: number): number | null {
  const bucket = Math.floor(atMs / 60_000) * 60_000;
  try {
    const candles = generateDeterministicCandles({
      symbol, count: 1, timeframe: "M1",
      seed: `paper-mtm|${bucket}`, baseTimeMs: bucket,
    });
    return candles[0]?.close ?? null;
  } catch {
    return null;
  }
}

// P&L UNIT: "sim points" — dir × (exit − entry) × lotSize × 100, symbol-blind.
// The fixed ×100 corresponds to no real currency amount for ANY instrument
// (no contract size, pip value, or per-symbol scaling), so every surface that
// renders this figure must label it sim pts, never dollars or cents.
// (Same formula as paperExecutionMonitor.unrealizedPnl — kept identical so the
// two surfaces can never disagree on scale.)
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
  const open = await db.select().from(paperOrdersTable)
    .where(and(eq(paperOrdersTable.paperAccountId, accountId),
               eq(paperOrdersTable.status, "OPEN")));
  const now = Date.now();
  let unrealized = 0;
  let margin = 0;

  for (const o of open) {
    const px = getMockPrice(o.symbol, now);
    // No synthetic price model ⇒ this position simply cannot be marked. Skip it
    // (it keeps its last stored state) rather than settling SL/TP against a
    // fabricated price.
    if (px == null) continue;
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
      // The settle was decided by the synthetic price model (a seeded PRNG),
      // not market data, and the P&L unit is sim points — say both.
      await logEvent(o.id, status, `${SIMULATED_TAG} ${hit} hit at ${exitPx.toFixed(5)} (synthetic model price), P&L ${pnl.toFixed(2)} sim pts`);
      // Session accounting (Build PP): count this settle against the owner's
      // ACTIVE paper session (netPnl in CENTS). Rows with no user_id — placed
      // before the routes stamped ownership, or by an unauthenticated caller —
      // cannot be attributed to a session and are honestly left uncounted.
      if (o.userId != null) {
        await linkTradeToActiveSession(o.userId, {
          tradeId: String(o.id),
          decisionId: o.decisionId != null ? String(o.decisionId) : undefined,
          symbol: o.symbol, action: "CLOSE",
          result: closeResultForPnl(pnl), pnl: usdToCents(pnl),
        });
      }
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
    .where(and(eq(paperOrdersTable.paperAccountId, accountId)));
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
router.post("/paper/accounts", async (req, res): Promise<void> => {
  try {
    const b = CreateAccountBody.parse(req.body ?? {});
    // Deactivate prior active accounts so "active" is single-tenant.
    await db.update(paperAccountsTable).set({ isActive: 0 })
      .where(eq(paperAccountsTable.isActive, 1));
    const ins = await db.insert(paperAccountsTable).values({
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
router.get("/paper/accounts", async (_req, res): Promise<void> => {
  const rows = await db.select().from(paperAccountsTable).orderBy(desc(paperAccountsTable.createdAt));
  // Refresh every account so list state is consistent (architect fix #3).
  for (const r of rows) await markToMarket(r.id);
  const refreshed = await db.select().from(paperAccountsTable).orderBy(desc(paperAccountsTable.createdAt));
  ok(res, { accounts: refreshed });
});

// ── GET /paper/accounts/active ─────────────────────────────────────────────
router.get("/paper/accounts/active", async (_req, res): Promise<void> => {
  const rows = await db.select().from(paperAccountsTable)
    .where(eq(paperAccountsTable.isActive, 1)).limit(1);
  if (!rows[0]) { fail(res, 404, "No active paper account"); return; }
  const refreshed = await markToMarket(rows[0].id);
  ok(res, { account: refreshed ?? rows[0] });
});

// ── POST /paper/orders ─────────────────────────────────────────────────────
router.post("/paper/orders", async (req, res): Promise<void> => {
  try {
    const b = PlaceOrderBody.parse(req.body ?? {});
    const accs = await db.select().from(paperAccountsTable)
      .where(eq(paperAccountsTable.id, b.paperAccountId)).limit(1);
    if (!accs[0]) { fail(res, 404, "Paper account not found"); return; }
    const px = b.entryPrice ?? getMockPrice(b.symbol, Date.now());
    if (px == null) {
      fail(res, 422, `No synthetic price model for ${b.symbol} — supply an explicit entryPrice or use a modelled symbol.`);
      return;
    }
    // Validate SL/TP geometry to refuse malformed paper orders.
    const slOk = b.direction === "BUY" ? b.stopLoss < px   : b.stopLoss > px;
    const tpOk = b.direction === "BUY" ? b.takeProfit > px : b.takeProfit < px;
    if (!slOk || !tpOk) {
      fail(res, 400, "Invalid SL/TP geometry for direction", { entryPrice: px });
      return;
    }
    const ins = await db.insert(paperOrdersTable).values({
      // Stamp ownership when the caller is authenticated (attachAuthUser runs
      // app-wide). Without it a close can never be attributed to a paper
      // session — the REAL wiring this route still lacks is requireUser, so
      // unauthenticated sandbox orders keep a null user_id and stay honestly
      // uncounted in session gauges rather than guessed onto someone.
      userId: req.authUser?.id ?? null,
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
    await logEvent(order.id, "PLACED", `${SIMULATED_TAG} ${b.direction} ${b.symbol} @ ${px.toFixed(5)}${b.entryPrice == null ? " (synthetic model price)" : ""} SL ${b.stopLoss} TP ${b.takeProfit} lot ${b.lotSize}`);
    // Session accounting (Build PP): count this open against the caller's
    // ACTIVE paper session. Best-effort; records nothing without one.
    if (req.authUser) {
      await linkTradeToActiveSession(req.authUser.id, {
        tradeId: String(order.id),
        decisionId: b.decisionId != null ? String(b.decisionId) : undefined,
        symbol: b.symbol, action: "OPEN", result: "OPEN",
      });
    }
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
router.patch("/paper/orders/:id", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) { fail(res, 400, "Invalid id"); return; }
    const b = UpdateOrderBody.parse(req.body ?? {});
    const cur = (await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.id, id)).limit(1))[0];
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
    await db.update(paperOrdersTable).set(next).where(eq(paperOrdersTable.id, id));
    await logEvent(id, "UPDATED", `${SIMULATED_TAG} SL→${next.stopLoss} TP→${next.takeProfit}`);
    await markToMarket(cur.paperAccountId);
    const refreshed = (await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.id, id)).limit(1))[0];
    ok(res, { order: refreshed });
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "PATCH /paper/orders/:id failed");
    fail(res, 500, "Failed to update order");
  }
});

// ── POST /paper/orders/:id/close ───────────────────────────────────────────
router.post("/paper/orders/:id/close", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) { fail(res, 400, "Invalid id"); return; }
    const cur = (await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.id, id)).limit(1))[0];
    if (!cur) { fail(res, 404, "Not found"); return; }
    if (cur.status !== "OPEN") { fail(res, 409, "Order not open"); return; }
    const exitPx = getMockPrice(cur.symbol, Date.now());
    if (exitPx == null) {
      fail(res, 422, `No synthetic price model for ${cur.symbol} — refusing to close at a fabricated price.`);
      return;
    }
    const pnl = pnlFor(cur.direction, cur.lotSize, cur.entryPrice, exitPx);
    await db.update(paperOrdersTable).set({
      status: "CLOSED_MANUAL", closedAt: new Date(), exitPrice: exitPx,
      profitLoss: pnl, updatedAt: new Date(),
    }).where(eq(paperOrdersTable.id, id));
    await logEvent(id, "CLOSED_MANUAL", `${SIMULATED_TAG} closed @ ${exitPx.toFixed(5)} (synthetic model price), P&L ${pnl.toFixed(2)} sim pts`);
    await vaultBehavior("PAPER_ORDER_CLOSED", { orderId: id, exitPrice: exitPx, pnl, manual: true });
    // Session accounting (Build PP): attribute the close to the order's owner
    // (or the authenticated caller for legacy rows with no user_id stamp).
    const closeOwnerId = cur.userId ?? req.authUser?.id ?? null;
    if (closeOwnerId != null) {
      await linkTradeToActiveSession(closeOwnerId, {
        tradeId: String(id),
        decisionId: cur.decisionId != null ? String(cur.decisionId) : undefined,
        symbol: cur.symbol, action: "CLOSE",
        result: closeResultForPnl(pnl), pnl: usdToCents(pnl),
      });
    }
    // markToMarket recomputes balance from starting + Σ closed-order P&L, so
    // this manual close's P&L is now properly reflected (architect fix #1).
    await markToMarket(cur.paperAccountId);
    // (BB) Closed-loop auto-debrief on manual close. Best-effort, idempotent.
    runAutoDebrief(id, { triggeredBy: "manual_close" })
      .catch(() => { /* non-fatal */ });
    const refreshed = (await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.id, id)).limit(1))[0];
    ok(res, { order: refreshed });
  } catch (err) {
    req.log.error({ err: String(err) }, "POST /paper/orders/:id/close failed");
    fail(res, 500, "Failed to close order");
  }
});

// ── GET /paper/orders ──────────────────────────────────────────────────────
router.get("/paper/orders", async (req, res): Promise<void> => {
  try {
    const accountId = Number(req.query["accountId"]);
    const status = String(req.query["status"] ?? "");
    if (!Number.isFinite(accountId)) { fail(res, 400, "accountId required"); return; }
    await markToMarket(accountId);
    const where = status === "OPEN"
      ? and(eq(paperOrdersTable.paperAccountId, accountId), eq(paperOrdersTable.status, "OPEN"))
      : eq(paperOrdersTable.paperAccountId, accountId);
    const rows = await db.select().from(paperOrdersTable)
      .where(where).orderBy(desc(paperOrdersTable.openedAt)).limit(200);
    ok(res, { orders: rows });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /paper/orders failed");
    fail(res, 500, "Failed to load orders");
  }
});

// ── GET /paper/history ─────────────────────────────────────────────────────
router.get("/paper/history", async (req, res): Promise<void> => {
  try {
    const accountId = Number(req.query["accountId"]);
    if (!Number.isFinite(accountId)) { fail(res, 400, "accountId required"); return; }
    // Refresh state before computing history (architect fix #3).
    await markToMarket(accountId);
    const orders = await db.select().from(paperOrdersTable)
      .where(eq(paperOrdersTable.paperAccountId, accountId))
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
