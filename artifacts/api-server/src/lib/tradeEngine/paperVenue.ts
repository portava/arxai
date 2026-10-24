// PAPER venue of the Trade Engine pipeline (lib/tradeEngine/pipeline.ts).
//
// The paper simulator book (paper_orders) used to be written straight from
// routes/paperTrading.ts. It is now the PAPER mode of the one pipeline: the
// route parses and owns the HTTP envelope; open / modify / close run here,
// each behind the same pre-trade Risk Governor (enforcePreTradeRisk, venue
// PAPER) a DEMO or LIVE order faces. Nothing here reaches a broker, a bridge,
// an MT5 mailbox or a position ledger. Every row stays scoped to its owner.
//
// The logic is moved, not changed: the same geometry checks, the same
// governor intents, the same writes, events, vault rows and auto-debrief.

import {
  db, paperAccountsTable, paperOrdersTable, paperTradeEventsTable, vaultEventsTable,
} from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { generateDeterministicCandles } from "../backtestStrategyRegistry.js";
import { runAutoDebrief } from "../autoDebriefService.js";
import { enforcePreTradeRisk } from "../riskGovernor/enforce.js";

export const SIMULATED_TAG = "Simulated — paper trading does not guarantee live results.";

export type PaperOrderRow = typeof paperOrdersTable.$inferSelect;

export type PaperRefusal =
  | { ok: false; reason: "PAPER_ACCOUNT_NOT_FOUND" }
  | { ok: false; reason: "PAPER_ORDER_NOT_FOUND" }
  | { ok: false; reason: "PAPER_ORDER_NOT_OPEN" }
  | { ok: false; reason: "INVALID_SLTP_GEOMETRY"; entryPrice?: number }
  | { ok: false; reason: "RISK_GOVERNOR_BLOCK"; primaryReason: string | null; blockedBy: string[]; auditEventId: number | null };

export type PaperResult = { ok: true; order: PaperOrderRow | null } | PaperRefusal;

export interface PaperOpenArgs {
  userId: number;
  paperAccountId: number;
  symbol: string;
  side: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT";
  lots: number;
  entryPrice: number | null;
  stopLoss: number;
  takeProfit: number;
  strategyId: string | null;
  tradePlanId: number | null;
  decisionId: number | null;
  caller: string;
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

export async function ownPaperAccount(id: number, userId: number) {
  return (await db.select().from(paperAccountsTable)
    .where(and(eq(paperAccountsTable.id, id), eq(paperAccountsTable.userId, userId)))
    .limit(1))[0] ?? null;
}

export async function ownPaperOrder(id: number, userId: number) {
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

function governorRefusal(risk: { primaryReason?: string | null; blockedBy: string[]; auditEventId?: number | null }): PaperRefusal {
  return {
    ok: false, reason: "RISK_GOVERNOR_BLOCK",
    primaryReason: risk.primaryReason ?? null, blockedBy: risk.blockedBy, auditEventId: risk.auditEventId ?? null,
  };
}

// Mark-to-market: settle SL/TP for any open orders, then RECOMPUTE balance
// from starting balance + Σ(closed-order P&L). Pulling balance from the
// authoritative ledger (closed orders) means manual-close P&L is always
// reflected even if the order transitioned to CLOSED before mark-to-market
// runs. Equity = balance + unrealized; margin = Σ open lot. An SL/TP hit is
// the simulator venue's own fill, not a new order, so it is not re-governed.
export async function markToMarket(accountId: number) {
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
    // uses Build DD market data). Mark-to-market must NOT auto-close them
    // with mock prices — only refresh unrealized P&L for equity display.
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

/** Open a paper order: owner check, SL/TP geometry, Risk Governor, then the simulator book. */
export async function openPaperOrder(a: PaperOpenArgs): Promise<PaperResult> {
  if (!(await ownPaperAccount(a.paperAccountId, a.userId))) return { ok: false, reason: "PAPER_ACCOUNT_NOT_FOUND" };
  const nowMs = Date.now();
  const marketPx = getMockPrice(a.symbol, nowMs);
  const px = a.entryPrice ?? marketPx;
  // Validate SL/TP geometry to refuse malformed paper orders.
  const slOk = a.side === "BUY" ? a.stopLoss < px   : a.stopLoss > px;
  const tpOk = a.side === "BUY" ? a.takeProfit > px : a.takeProfit < px;
  if (!slOk || !tpOk) return { ok: false, reason: "INVALID_SLTP_GEOMETRY", entryPrice: px };
  // Pre-trade Risk Governor: the same rules a live order faces, priced
  // against the paper simulator's market.
  const risk = await enforcePreTradeRisk({
    userId: a.userId, venue: "PAPER", origin: "manual", action: "OPEN",
    symbol: a.symbol, side: a.side, lots: a.lots,
    entryPrice: a.entryPrice, stopLoss: a.stopLoss, takeProfit: a.takeProfit,
  }, {
    paperAccountId: a.paperAccountId,
    facts: { quote: { bid: marketPx, ask: marketPx, at: new Date(nowMs), source: "paper_simulator_price" } },
    auditContext: { caller: a.caller },
  });
  if (!risk.allowed) return governorRefusal(risk);
  const ins = await db.insert(paperOrdersTable).values({
    userId: a.userId,
    paperAccountId: a.paperAccountId,
    symbol: a.symbol, direction: a.side, orderType: a.orderType,
    lotSize: a.lots, entryPrice: px,
    stopLoss: a.stopLoss, takeProfit: a.takeProfit,
    status: "OPEN",
    strategyId: a.strategyId,
    tradePlanId: a.tradePlanId,
    decisionId: a.decisionId,
  }).returning();
  const order = ins[0]!;
  await logEvent(a.userId, order.id, "PLACED", `${SIMULATED_TAG} ${a.side} ${a.symbol} @ ${px.toFixed(5)} SL ${a.stopLoss} TP ${a.takeProfit} lot ${a.lots}`);
  await vaultBehavior("PAPER_ORDER_PLACED", {
    orderId: order.id, accountId: a.paperAccountId,
    symbol: a.symbol, direction: a.side, lotSize: a.lots,
  });
  await markToMarket(a.paperAccountId);
  return { ok: true, order };
}

/** Move the stop and/or target of an open paper order (an omitted field keeps its value). */
export async function modifyPaperOrder(a: {
  userId: number; orderId: number; stopLoss?: number | null; takeProfit?: number | null; caller: string;
}): Promise<PaperResult> {
  const cur = await ownPaperOrder(a.orderId, a.userId);
  if (!cur) return { ok: false, reason: "PAPER_ORDER_NOT_FOUND" };
  if (cur.status !== "OPEN") return { ok: false, reason: "PAPER_ORDER_NOT_OPEN" };
  const next = {
    stopLoss: a.stopLoss ?? cur.stopLoss,
    takeProfit: a.takeProfit ?? cur.takeProfit,
    updatedAt: new Date(),
  };
  const slOk = cur.direction === "BUY" ? next.stopLoss < cur.entryPrice   : next.stopLoss > cur.entryPrice;
  const tpOk = cur.direction === "BUY" ? next.takeProfit > cur.entryPrice : next.takeProfit < cur.entryPrice;
  if (!slOk || !tpOk) return { ok: false, reason: "INVALID_SLTP_GEOMETRY" };
  // Position Guardian: a stop may be tightened freely, but widening it is
  // checked against the trader's per-trade loss limit.
  const nowMs = Date.now();
  const marketPx = getMockPrice(cur.symbol, nowMs);
  const risk = await enforcePreTradeRisk({
    userId: a.userId, venue: "PAPER", origin: "manual", action: "MODIFY",
    symbol: cur.symbol, side: cur.direction as "BUY" | "SELL", lots: cur.lotSize,
    stopLoss: next.stopLoss, takeProfit: next.takeProfit,
    position: { entryPrice: cur.entryPrice, stopLoss: cur.stopLoss },
  }, {
    paperAccountId: cur.paperAccountId,
    facts: { quote: { bid: marketPx, ask: marketPx, at: new Date(nowMs), source: "paper_simulator_price" } },
    auditContext: { caller: a.caller, orderId: a.orderId },
  });
  if (!risk.allowed) return governorRefusal(risk);
  await db.update(paperOrdersTable).set(next)
    .where(and(eq(paperOrdersTable.id, a.orderId), eq(paperOrdersTable.userId, a.userId)));
  await logEvent(a.userId, a.orderId, "UPDATED", `${SIMULATED_TAG} SL→${next.stopLoss} TP→${next.takeProfit}`);
  await markToMarket(cur.paperAccountId);
  return { ok: true, order: await ownPaperOrder(a.orderId, a.userId) };
}

/** Close an open paper order at the simulator price. */
export async function closePaperOrder(a: { userId: number; orderId: number; caller: string }): Promise<PaperResult> {
  const cur = await ownPaperOrder(a.orderId, a.userId);
  if (!cur) return { ok: false, reason: "PAPER_ORDER_NOT_FOUND" };
  if (cur.status !== "OPEN") return { ok: false, reason: "PAPER_ORDER_NOT_OPEN" };
  const exitPx = getMockPrice(cur.symbol, Date.now());
  const risk = await enforcePreTradeRisk({
    userId: a.userId, venue: "PAPER", origin: "manual", action: "CLOSE",
    symbol: cur.symbol, side: cur.direction as "BUY" | "SELL", lots: cur.lotSize,
    intentRef: `paper_close:${a.orderId}`,
  }, {
    paperAccountId: cur.paperAccountId,
    facts: { quote: { bid: exitPx, ask: exitPx, at: new Date(), source: "paper_simulator_price" } },
    auditContext: { caller: a.caller, orderId: a.orderId },
  });
  if (!risk.allowed) return governorRefusal(risk);
  const pnl = pnlFor(cur.direction, cur.lotSize, cur.entryPrice, exitPx);
  await db.update(paperOrdersTable).set({
    status: "CLOSED_MANUAL", closedAt: new Date(), exitPrice: exitPx,
    profitLoss: pnl, updatedAt: new Date(),
  }).where(and(eq(paperOrdersTable.id, a.orderId), eq(paperOrdersTable.userId, a.userId)));
  await logEvent(a.userId, a.orderId, "CLOSED_MANUAL", `${SIMULATED_TAG} closed @ ${exitPx.toFixed(5)}, P&L ${pnl.toFixed(2)}`);
  await vaultBehavior("PAPER_ORDER_CLOSED", { orderId: a.orderId, exitPrice: exitPx, pnl, manual: true });
  // markToMarket recomputes balance from starting + Σ closed-order P&L, so
  // this manual close's P&L is reflected.
  await markToMarket(cur.paperAccountId);
  // (BB) Closed-loop auto-debrief on manual close. Best-effort, idempotent.
  runAutoDebrief(a.orderId, { triggeredBy: "manual_close" })
    .catch(() => { /* non-fatal */ });
  return { ok: true, order: await ownPaperOrder(a.orderId, a.userId) };
}
