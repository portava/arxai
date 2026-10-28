// PAPER venue of the Trade Engine pipeline (lib/tradeEngine/pipeline.ts).
//
// The paper simulator book (paper_orders) used to be written straight from
// routes/paperTrading.ts. It is now the PAPER mode of the one pipeline: the
// route parses and owns the HTTP envelope; open / modify / close run here,
// each behind the same pre-trade Risk Governor (enforcePreTradeRisk, venue
// PAPER) a DEMO or LIVE order faces. Nothing here reaches a broker, a bridge,
// an MT5 mailbox or a position ledger. Every row stays scoped to its owner.
//
// Entries require an executable Safety Core mode and the owner's entry policy.
// Each booking/outcome and its linked evidence commit together. Existing
// geometry, ownership and protective-action governors still apply.
//
// One paper book (docs/TIER1_PAPER_BOOK.md): this module is the ONLY writer
// of paper_orders and paper_trade_events. The trader's ticket (via
// submitTrade), the Build EE autopilot and monitor, and the operator
// auto-debrief fixture all book through the functions below:
//
//   openPaperOrder / modifyPaperOrder / closePaperOrder — the trader's
//     ticket, reached only through lib/tradeEngine/pipeline.ts.
//   openPaperFill   — an order filled at a price the caller priced (Build EE
//     market-data fill, the QA fixture). Risk Governor OPEN, venue PAPER.
//   closePaperFill  — Build EE manual close at a caller-priced exit. Risk
//     Governor CLOSE, venue PAPER.
//   settlePaperOrder — the venue's own exit fill (stop or target hit, the QA
//     fixture's forced result). Not a new order, so not re-governed — the
//     same rule markToMarket has always applied.
//   voidPaperOrder  — rolls back an order this venue booked a moment ago
//     when its caller lost an idempotency race (status CANCELLED).
// check-single-paper-book holds the line.

import {
  db, paperAccountsTable, paperOrdersTable, paperTradeEventsTable, vaultEventsTable,
} from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { appendAuditInTransaction, type AuditTransaction } from "../auditVault.js";
import { paperEntryOrigin, paperEntryPolicyReason } from "../safety/entryPolicy.js";
import { readPaperEntryPosture } from "../safety/platformSwitches.js";
import { generateDeterministicCandles } from "../backtestStrategyRegistry.js";
import { runAutoDebrief } from "../autoDebriefService.js";
import { enforcePreTradeRisk, type EnforceResult } from "../riskGovernor/enforce.js";
import { currentQuote } from "./marketQuote.js";
import type { IntentOrigin, RiskQuote } from "../riskGovernor/preTrade.js";

export const SIMULATED_TAG = "Simulated — paper trading does not guarantee live results.";

/**
 * strategyId tag of a confirmed SIMULATED open (owner decision 13), booked at
 * a real market quote. Like Build EE orders, mark-to-market never settles it
 * at the synthetic simulator price; its stop/target are settled by the Build
 * EE monitor from real market data.
 */
export const MARKET_PRICED_SIMULATED_OPEN = "market_priced_simulated_open";

/** A real market quote with its provenance (source, observation time). */
export interface PaperQuote { bid: number; ask: number; at: Date; source: string }

export type PaperOrderRow = typeof paperOrdersTable.$inferSelect;

export type PaperRefusal =
  | { ok: false; reason: "NO_VALID_PRICE_SOURCE" }
  | { ok: false; reason: "PAPER_ACCOUNT_NOT_FOUND" }
  | { ok: false; reason: "PAPER_ORDER_NOT_FOUND" }
  | { ok: false; reason: "PAPER_ORDER_NOT_OPEN" }
  | { ok: false; reason: "INVALID_SLTP_GEOMETRY"; entryPrice?: number }
  | { ok: false; reason: "RISK_GOVERNOR_BLOCK"; primaryReason: string | null; blockedBy: string[]; auditEventId: number | null };

export type PaperResult = { ok: true; order: PaperOrderRow | null; replayed?: boolean } | PaperRefusal;

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
  /** Governor intent origin; omitted → "manual" (the trader's ticket). */
  origin?: IntentOrigin;
  /**
   * A real market quote to fill at (owner decision 13). When present the order
   * is a market fill at the quote (ask for BUY, bid for SELL), the governor
   * sees this quote, and the simulator price is not used. Omitted → the
   * trader's ticket behaviour (simulator price).
   */
  quote?: PaperQuote | null;
  /** Retry-safe idempotency key: one order per (user, key); a repeat returns the booked order. */
  clientRequestKey?: string | null;
  /** The caller's own in-flight row (e.g. "trade_action:12"), excluded from the governor's duplicate scan. */
  intentRef?: string;
}

/** Outcome evidence is mandatory and shares the order mutation's transaction. */
async function recordPaperOutcome(tx: AuditTransaction, order: PaperOrderRow, eventType: string, message: string | null, riskId?: number | null) {
  if (message != null) await tx.insert(paperTradeEventsTable).values({ userId: order.userId, paperOrderId: order.id, eventType, message });
  const kind = eventType === "UPDATED" ? "PAPER_ORDER_UPDATED"
    : eventType === "CANCELLED" ? "PAPER_ORDER_CANCELLED" : "PAPER_ORDER_CLOSED";
  const linkedDecisionId = riskId != null ? `risk:${riskId}` : null;
  const payload = { userId: order.userId, orderId: order.id, linkedTradeId: String(order.id), linkedDecisionId, entityType: "paper_order",
    symbol: order.symbol, accountId: order.paperAccountId, status: order.status, stopLoss: order.stopLoss, takeProfit: order.takeProfit,
    exitPrice: order.exitPrice, pnl: order.profitLoss, simulated: true, disclaimer: SIMULATED_TAG };
  await tx.insert(vaultEventsTable).values({ kind, source: "SYSTEM", severity: "INFO", truthDomain: "EXECUTION", summary: message ?? eventType,
    payload, symbol: order.symbol, linkedTradeId: String(order.id), linkedDecisionId, generatedAtIso: new Date().toISOString() });
  await appendAuditInTransaction(tx, { eventType: kind, source: "SYSTEM", severity: "INFO", systemMode: null, globalState: null, payload });
}

export async function ownPaperAccount(id: number, userId: number) {
  return (await db.select().from(paperAccountsTable)
    .where(and(eq(paperAccountsTable.id, id), eq(paperAccountsTable.userId, userId)))
    .limit(1))[0] ?? null;
}

/** The order a user already booked under a request key, if any (owner-scoped). */
export async function paperOrderByRequestKey(userId: number, key: string) {
  return (await db.select().from(paperOrdersTable)
    .where(and(eq(paperOrdersTable.userId, userId), eq(paperOrdersTable.clientRequestKey, key)))
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
  // Resolve every real-priced position before any settlement or account write.
  // Without a current real quote the valuation is unavailable; never stamp
  // simulator prices (or a partial valuation) onto a real-priced paper book.
  const prices = new Map<number, number>();
  for (const o of open) {
    if (o.strategyId !== "build_ee_paper_execution" && o.strategyId !== MARKET_PRICED_SIMULATED_OPEN) continue;
    const quote = await currentQuote(o.symbol);
    if (!quote.ok) return null;
    prices.set(o.id, o.direction === "BUY" ? quote.bid : quote.ask);
  }
  let unrealized = 0;
  let margin = 0;

  for (const o of open) {
    const px = prices.get(o.id) ?? getMockPrice(o.symbol, now);
    // (Build EE) EE-managed orders are owned by the Build EE monitor (which
    // uses Build DD market data). Mark-to-market must NOT auto-close them
    // with mock prices — refresh unrealized P&L only from a real quote.
    const eeOwned = o.strategyId === "build_ee_paper_execution" || o.strategyId === MARKET_PRICED_SIMULATED_OPEN;
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
      await settlePaperOrder({
        order: o, status, exitPrice: exitPx, pnl,
        eventMessage: o.userId != null ? `${SIMULATED_TAG} ${hit} hit at ${exitPx.toFixed(5)}, P&L ${pnl.toFixed(2)}` : null,
      });
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

/** The order, its event and both audit records commit together. No network work
 * is allowed inside this transaction. Safety Core writers serialize against
 * the shared row lock, so a committed mode change cannot be missed at booking.
 */
async function bookPaperOrder(values: typeof paperOrdersTable.$inferInsert, risk: EnforceResult,
  message: string | null, extra: Record<string, unknown> = {},
): Promise<{ ok: true; order: PaperOrderRow; replayed?: boolean } | PaperFillBlocked> {
  if (!risk.allowed || risk.auditEventId == null) return { ok: false, reason: "RISK_GOVERNOR_BLOCK", risk };
  return db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    const posture = await readPaperEntryPosture(tx);
    const reason = paperEntryPolicyReason(posture);
    if (reason) {
      const payload = { userId: values.userId, symbol: values.symbol, reason, linkedDecisionId: `risk:${risk.auditEventId}`, booked: false };
      await tx.insert(vaultEventsTable).values({ kind: "PAPER_ENTRY_HELD", source: "RISK_GOVERNOR", severity: "WARN", truthDomain: "DECISION",
        summary: reason, payload, blockers: [reason], symbol: values.symbol, linkedDecisionId: `risk:${risk.auditEventId}`, generatedAtIso: new Date().toISOString() });
      await appendAuditInTransaction(tx, { eventType: "PAPER_ENTRY_HELD", source: "RISK_GOVERNOR", severity: "WARN",
        systemMode: posture.operationalMode, globalState: posture.globalState, payload });
      return { ok: false, reason: "RISK_GOVERNOR_BLOCK", risk: { ...risk, allowed: false, decision: "BLOCK", primaryReason: reason, blockedBy: ["trading_halt"] } };
    }
    const [order] = await tx.insert(paperOrdersTable).values(values)
      .onConflictDoNothing({ target: [paperOrdersTable.userId, paperOrdersTable.clientRequestKey] }).returning();
    if (!order) {
      const [prior] = values.clientRequestKey && values.userId != null
        ? await tx.select().from(paperOrdersTable).where(and(eq(paperOrdersTable.userId, values.userId), eq(paperOrdersTable.clientRequestKey, values.clientRequestKey))).limit(1) : [];
      if (!prior) throw new Error("paper order insert returned no row");
      return { ok: true, order: prior, replayed: true };
    }
    if (message != null) await tx.insert(paperTradeEventsTable).values({ userId: order.userId, paperOrderId: order.id, eventType: "PLACED", message });
    const linkedDecisionId = `risk:${risk.auditEventId}`;
    const payload = { ...extra, userId: order.userId, orderId: order.id, linkedTradeId: String(order.id), linkedDecisionId,
      entityType: "paper_order", accountId: order.paperAccountId, symbol: order.symbol, direction: order.direction, lotSize: order.lotSize,
      simulated: true, disclaimer: SIMULATED_TAG };
    await tx.insert(vaultEventsTable).values({ kind: "PAPER_ORDER_PLACED", source: "SYSTEM", severity: "INFO", truthDomain: "EXECUTION",
      summary: "Paper order booked", payload, symbol: order.symbol, linkedTradeId: String(order.id), linkedDecisionId,
      operationalMode: posture.operationalMode, globalState: posture.globalState, generatedAtIso: new Date().toISOString() });
    await appendAuditInTransaction(tx, { eventType: "PAPER_ORDER_PLACED", source: "SYSTEM", severity: "INFO",
      systemMode: posture.operationalMode, globalState: posture.globalState, payload });
    return { ok: true, order };
  });
}

/** Open a paper order: owner check, SL/TP geometry, Risk Governor, then the simulator book. */
export async function openPaperOrder(a: PaperOpenArgs): Promise<PaperResult> {
  if (!(await ownPaperAccount(a.paperAccountId, a.userId))) return { ok: false, reason: "PAPER_ACCOUNT_NOT_FOUND" };
  // Retry-safe: a request key that already booked an order returns it, with
  // no second governor decision and no second order.
  if (a.clientRequestKey) {
    const prior = await paperOrderByRequestKey(a.userId, a.clientRequestKey);
    if (prior) return { ok: true, order: prior, replayed: true };
  }
  const nowMs = Date.now();
  const q = a.quote ?? null;
  const marketPx = q ? (a.side === "BUY" ? q.ask : q.bid) : getMockPrice(a.symbol, nowMs);
  // A quoted open is always a market fill at the quote, never at a caller price.
  const px = q ? marketPx : a.entryPrice ?? marketPx;
  // Validate SL/TP geometry to refuse malformed paper orders.
  const slOk = a.side === "BUY" ? a.stopLoss < px   : a.stopLoss > px;
  const tpOk = a.side === "BUY" ? a.takeProfit > px : a.takeProfit < px;
  if (!slOk || !tpOk) return { ok: false, reason: "INVALID_SLTP_GEOMETRY", entryPrice: px };
  // Pre-trade Risk Governor: the same rules a live order faces, priced
  // against the paper simulator's market.
  const risk = await enforcePreTradeRisk({
    userId: a.userId, venue: "PAPER", origin: paperEntryOrigin(a.origin, a.decisionId), action: "OPEN",
    symbol: a.symbol, side: a.side, lots: a.lots,
    entryPrice: q ? null : a.entryPrice, stopLoss: a.stopLoss, takeProfit: a.takeProfit,
    ...(a.intentRef ? { intentRef: a.intentRef } : {}),
  }, {
    paperAccountId: a.paperAccountId,
    facts: { quote: q
      ? { bid: q.bid, ask: q.ask, at: q.at, source: q.source }
      : { bid: marketPx, ask: marketPx, at: new Date(nowMs), source: "paper_simulator_price" } },
    auditContext: { caller: a.caller, ...(a.clientRequestKey ? { clientRequestKey: a.clientRequestKey } : {}) },
  });
  if (!risk.allowed) return governorRefusal(risk);
  const priced = q ? ` (price ${q.source} at ${q.at.toISOString()})` : "";
  const booked = await bookPaperOrder({
    userId: a.userId,
    paperAccountId: a.paperAccountId,
    symbol: a.symbol, direction: a.side, orderType: a.orderType,
    lotSize: a.lots, entryPrice: px,
    stopLoss: a.stopLoss, takeProfit: a.takeProfit,
    status: "OPEN",
    strategyId: a.strategyId,
    tradePlanId: a.tradePlanId,
    decisionId: a.decisionId,
    clientRequestKey: a.clientRequestKey ?? null,
  }, risk, `${SIMULATED_TAG} ${a.side} ${a.symbol} @ ${px.toFixed(5)} SL ${a.stopLoss} TP ${a.takeProfit} lot ${a.lots}${priced}`,
    q ? { priceSource: q.source, quoteAt: q.at.toISOString(), caller: a.caller } : { caller: a.caller });
  if (!booked.ok) return governorRefusal(booked.risk);
  if (booked.replayed) return booked;
  const order = booked.order;
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
  const updated = await db.transaction(async tx => {
    const [order] = await tx.update(paperOrdersTable).set(next)
      .where(and(eq(paperOrdersTable.id, a.orderId), eq(paperOrdersTable.userId, a.userId), eq(paperOrdersTable.status, "OPEN"))).returning();
    if (order) await recordPaperOutcome(tx, order, "UPDATED", `${SIMULATED_TAG} SL→${next.stopLoss} TP→${next.takeProfit}`, risk.auditEventId);
    return order;
  });
  if (!updated) return { ok: false, reason: "PAPER_ORDER_NOT_OPEN" };
  await markToMarket(cur.paperAccountId);
  return { ok: true, order: await ownPaperOrder(a.orderId, a.userId) };
}

/** Close using the order's price model. Market-priced orders never fall back to simulation. */
export async function closePaperOrder(a: { userId: number; orderId: number; caller: string }): Promise<PaperResult> {
  const cur = await ownPaperOrder(a.orderId, a.userId);
  if (!cur) return { ok: false, reason: "PAPER_ORDER_NOT_FOUND" };
  if (cur.status !== "OPEN") return { ok: false, reason: "PAPER_ORDER_NOT_OPEN" };
  const realPriced = cur.strategyId === MARKET_PRICED_SIMULATED_OPEN || cur.strategyId === "build_ee_paper_execution";
  const quote = realPriced ? await currentQuote(cur.symbol) : null;
  if (quote && !quote.ok) return { ok: false, reason: "NO_VALID_PRICE_SOURCE" };
  const exitPx = quote?.ok ? (cur.direction === "BUY" ? quote.bid : quote.ask) : getMockPrice(cur.symbol, Date.now());
  const priceSource = quote?.ok ? quote.source : "paper_simulator_price";
  const risk = await enforcePreTradeRisk({
    userId: a.userId, venue: "PAPER", origin: "manual", action: "CLOSE",
    symbol: cur.symbol, side: cur.direction as "BUY" | "SELL", lots: cur.lotSize,
    intentRef: `paper_close:${a.orderId}`,
  }, {
    paperAccountId: cur.paperAccountId,
    facts: { quote: { bid: exitPx, ask: exitPx, at: quote?.ok ? quote.at : new Date(), source: priceSource } },
    auditContext: { caller: a.caller, orderId: a.orderId, priceSource, quoteAt: quote?.ok ? quote.at.toISOString() : null },
  });
  if (!risk.allowed) return governorRefusal(risk);
  const pnl = pnlFor(cur.direction, cur.lotSize, cur.entryPrice, exitPx);
  const closed = await db.transaction(async tx => {
    const [order] = await tx.update(paperOrdersTable).set({
      status: "CLOSED_MANUAL", closedAt: new Date(), exitPrice: exitPx,
      profitLoss: pnl, updatedAt: new Date(),
    }).where(and(eq(paperOrdersTable.id, a.orderId), eq(paperOrdersTable.userId, a.userId), eq(paperOrdersTable.status, "OPEN"))).returning();
    if (order) await recordPaperOutcome(tx, order, "CLOSED_MANUAL", `${SIMULATED_TAG} closed @ ${exitPx.toFixed(5)}, P&L ${pnl.toFixed(2)} (${priceSource})`, risk.auditEventId);
    return order;
  });
  if (!closed) return { ok: false, reason: "PAPER_ORDER_NOT_OPEN" };
  // markToMarket recomputes balance from starting + Σ closed-order P&L, so
  // this manual close's P&L is reflected.
  await markToMarket(cur.paperAccountId);
  // (BB) Closed-loop auto-debrief on manual close. Best-effort, idempotent.
  runAutoDebrief(a.orderId, { triggeredBy: "manual_close" })
    .catch(() => { /* non-fatal */ });
  return { ok: true, order: await ownPaperOrder(a.orderId, a.userId) };
}

// ── Caller-priced fills (Build EE autopilot and monitor, operator QA fixture) ──

export type PaperFillBlocked = { ok: false; reason: "RISK_GOVERNOR_BLOCK"; risk: EnforceResult };
export type PaperFillRefusal =
  | { ok: false; reason: "NO_VALID_PRICE_SOURCE" }
  | { ok: false; reason: "PAPER_ORDER_NOT_FOUND" }
  | { ok: false; reason: "PAPER_ORDER_NOT_OPEN" }
  | PaperFillBlocked;

export interface PaperFillOpenArgs {
  userId: number;
  paperAccountId: number;
  symbol: string;
  side: "BUY" | "SELL";
  lots: number;
  /** The price this order filled at (the caller priced it from its own quote). */
  fillPrice: number;
  stopLoss: number;
  takeProfit: number;
  decisionId: number | null;
  strategyId: string | null;
  /** Governor intent fields, passed through unchanged. */
  origin: IntentOrigin;
  /** Present only when the caller's intent carries one (null = market). */
  governedEntryPrice?: number | null;
  intentRef?: string;
  quote: RiskQuote;
  auditContext: Record<string, unknown>;
  /** The PLACED event message; null writes no event (the QA fixture never did). */
  placedMessage: string | null;
}

/**
 * Book an order filled at a caller-priced quote. The caller owns its own
 * eligibility, sizing and geometry rules; this function runs the pre-trade
 * Risk Governor (venue PAPER, action OPEN) and books the order only when it
 * allows. The governor's result is returned either way so callers keep
 * their own refusal envelopes.
 */
export async function openPaperFill(a: PaperFillOpenArgs): Promise<{ ok: true; order: PaperOrderRow; risk: EnforceResult } | PaperFillBlocked> {
  const risk = await enforcePreTradeRisk({
    userId: a.userId, venue: "PAPER", origin: paperEntryOrigin(a.origin, a.decisionId), action: "OPEN",
    symbol: a.symbol, side: a.side, lots: a.lots,
    ...("governedEntryPrice" in a ? { entryPrice: a.governedEntryPrice } : {}),
    stopLoss: a.stopLoss, takeProfit: a.takeProfit,
    ...(a.intentRef !== undefined ? { intentRef: a.intentRef } : {}),
  }, {
    paperAccountId: a.paperAccountId,
    facts: { quote: a.quote },
    auditContext: a.auditContext,
  });
  if (!risk.allowed) return { ok: false, reason: "RISK_GOVERNOR_BLOCK", risk };
  const booked = await bookPaperOrder({
    userId: a.userId,
    paperAccountId: a.paperAccountId,
    symbol: a.symbol, direction: a.side, orderType: "MARKET",
    lotSize: a.lots,
    entryPrice: a.fillPrice,
    stopLoss: a.stopLoss, takeProfit: a.takeProfit,
    status: "OPEN",
    decisionId: a.decisionId,
    strategyId: a.strategyId,
  }, risk, a.placedMessage, { caller: a.auditContext.caller ?? null });
  if (!booked.ok) return booked;
  return { ok: true, order: booked.order, risk };
}

/**
 * Close an open order at a caller-priced exit (Build EE manual close). The
 * caller has loaded the order scoped to its owner. Risk Governor CLOSE,
 * venue PAPER, then the close and its event.
 */
export async function closePaperFill(a: {
  userId: number; order: PaperOrderRow; exitPrice: number;
  intentRef: string; auditContext: Record<string, unknown>; eventLabel: string;
}): Promise<{ ok: true; pnl: number } | PaperFillRefusal> {
  const o = a.order;
  if (o.userId !== a.userId) return { ok: false, reason: "PAPER_ORDER_NOT_FOUND" };
  if (o.status !== "OPEN") return { ok: false, reason: "PAPER_ORDER_NOT_OPEN" };
  // A close reduces risk, so the governor only refuses a bad quantity, but it
  // is checked and audited like every other action on the paper account.
  const risk = await enforcePreTradeRisk({
    userId: a.userId, venue: "PAPER", origin: "manual", action: "CLOSE",
    symbol: o.symbol, side: o.direction as "BUY" | "SELL", lots: o.lotSize,
    intentRef: a.intentRef,
  }, {
    paperAccountId: o.paperAccountId,
    auditContext: a.auditContext,
  });
  if (!risk.allowed) return { ok: false, reason: "RISK_GOVERNOR_BLOCK", risk };
  if (!Number.isFinite(a.exitPrice) || a.exitPrice <= 0) return { ok: false, reason: "NO_VALID_PRICE_SOURCE" };
  const pnl = pnlFor(o.direction, o.lotSize, o.entryPrice, a.exitPrice);
  const closed = await db.transaction(async tx => {
    const [order] = await tx.update(paperOrdersTable).set({
      status: "CLOSED_MANUAL", closedAt: new Date(), exitPrice: a.exitPrice, profitLoss: pnl, updatedAt: new Date(),
    }).where(and(eq(paperOrdersTable.id, o.id), eq(paperOrdersTable.userId, a.userId), eq(paperOrdersTable.status, "OPEN"))).returning();
    if (order) await recordPaperOutcome(tx, order, "CLOSED_MANUAL", `${SIMULATED_TAG} ${a.eventLabel} @ ${a.exitPrice.toFixed(5)}, P&L ${pnl.toFixed(2)}`, risk.auditEventId);
    return order;
  });
  if (!closed) return { ok: false, reason: "PAPER_ORDER_NOT_OPEN" };
  return { ok: true, pnl };
}

/**
 * The venue's own exit fill: a stop or target hit (markToMarket, the Build
 * EE monitor) or the operator QA fixture's forced result. It is a fill of an
 * order the governor already allowed, not a new order, so it is not
 * re-governed. eventMessage null writes no event.
 */
export async function settlePaperOrder(a: {
  order: Pick<PaperOrderRow, "id" | "userId">;
  status: "CLOSED_SL" | "CLOSED_TP" | "CLOSED_MANUAL" | "CANCELLED";
  exitPrice: number; pnl: number; eventMessage: string | null;
}): Promise<void> {
  await db.transaction(async tx => {
    const [order] = await tx.update(paperOrdersTable).set({
      status: a.status, closedAt: new Date(), exitPrice: a.exitPrice,
      profitLoss: a.pnl, updatedAt: new Date(),
    }).where(and(eq(paperOrdersTable.id, a.order.id), eq(paperOrdersTable.status, "OPEN"),
      a.order.userId == null ? isNull(paperOrdersTable.userId) : eq(paperOrdersTable.userId, a.order.userId))).returning();
    if (order) await recordPaperOutcome(tx, order, a.status, a.eventMessage);
  });
}

/**
 * Roll back an order booked a moment ago whose caller then lost an
 * idempotency race (Build EE: another request recorded the same decision).
 * Audit failure rolls back the cancellation and propagates to the caller.
 */
export async function voidPaperOrder(orderId: number): Promise<void> {
  await db.transaction(async tx => {
    const [order] = await tx.update(paperOrdersTable).set({ status: "CANCELLED", updatedAt: new Date() })
      .where(and(eq(paperOrdersTable.id, orderId), eq(paperOrdersTable.status, "OPEN"))).returning();
    if (order) await recordPaperOutcome(tx, order, "CANCELLED", "Paper booking cancelled after an idempotency conflict.");
  });
}
