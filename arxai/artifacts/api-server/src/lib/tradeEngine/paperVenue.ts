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
  db, paperAccountsTable, paperOrdersTable, paperExecutionsTable, paperTradeEventsTable, vaultEventsTable,
} from "@workspace/db";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { appendAuditInTransaction, type AuditTransaction } from "../auditVault.js";
import { paperEntryPolicyReason } from "../safety/entryPolicy.js";
import { readPaperEntryPosture } from "../safety/platformSwitches.js";
import {
  getMockPrice, isMarketPricedPaperOrder, MARKET_PRICED_SIMULATED_OPEN, crossedPaperLevel,
  paperExitQuote, validPaperOpenBracket,
} from "./paperMark.js";
import { runAutoDebrief } from "../autoDebriefService.js";
import { enforcePreTradeRisk, type EnforceResult } from "../riskGovernor/enforce.js";
import { currentQuote } from "./marketQuote.js";
import { bookedRealizedOf } from "./paperBookReader.js";
import {
  isUnsizedPaperClose, paperLedgerModelPnl, paperMoveSign, resolvePaperContract, sizePaperOrderPnl, type PaperPnlResult,
} from "../paperExecution/paperPnl.js";
import type { ResolvedContractSize } from "../mt5/contractSize.js";
import type { IntentOrigin, RiskQuote } from "../riskGovernor/preTrade.js";

export const SIMULATED_TAG = "Simulated — paper trading does not guarantee live results.";

// The mark price, the market-priced strategy tags and the simulator's exit
// rule live in ./paperMark.ts, so the Risk Governor reads the same mark
// without importing this venue.
export { getMockPrice, MARKET_PRICED_SIMULATED_OPEN };

/** A real market quote with its provenance (source, observation time). */
export interface PaperQuote { bid: number; ask: number; at: Date; source: string }

export type PaperOrderRow = typeof paperOrdersTable.$inferSelect;
export type PaperAccountRow = typeof paperAccountsTable.$inferSelect;

export type PaperRefusal =
  | { ok: false; reason: "NO_VALID_PRICE_SOURCE" }
  | { ok: false; reason: "PAPER_ACCOUNT_NOT_FOUND" }
  | { ok: false; reason: "PAPER_ORDER_NOT_FOUND" }
  | { ok: false; reason: "PAPER_ORDER_NOT_OPEN" }
  | { ok: false; reason: "PAPER_ORDER_CHANGED" | "PAPER_EXIT_ALREADY_REACHED" }
  | { ok: false; reason: "INVALID_SLTP_GEOMETRY"; entryPrice?: number }
  | { ok: false; reason: "RISK_GOVERNOR_BLOCK"; primaryReason: string | null; blockedBy: string[]; auditEventId: number | null };

export type PaperResult = { ok: true; order: PaperOrderRow | null; replayed?: boolean } | PaperRefusal;

type PaperExecutionInsert = Omit<typeof paperExecutionsTable.$inferInsert, "orderId">;
type BookedPaperOrder = { ok: true; order: PaperOrderRow; execution?: typeof paperExecutionsTable.$inferSelect; replayed?: boolean };

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
async function recordPaperOutcome(tx: AuditTransaction, order: PaperOrderRow, eventType: string, message: string | null, riskId?: number | null,
  extra: Record<string, unknown> = {},
) {
  if (order.decisionId != null && (eventType === "CLOSED_MANUAL" || eventType === "CLOSED_TP" || eventType === "CLOSED_SL")) {
    const sign = paperMoveSign(order.direction, order.entryPrice, order.exitPrice!);
    const status = eventType === "CLOSED_MANUAL" ? "PAPER_CLOSED_MANUAL"
      : sign > 0 ? "PAPER_CLOSED_WIN" : sign < 0 ? "PAPER_CLOSED_LOSS" : "PAPER_CLOSED_BREAK_EVEN";
    await tx.update(paperExecutionsTable).set({ status, updatedAt: new Date() })
      .where(and(eq(paperExecutionsTable.orderId, order.id), eq(paperExecutionsTable.decisionId, order.decisionId)));
  }
  if (message != null) await tx.insert(paperTradeEventsTable).values({ userId: order.userId, paperOrderId: order.id, eventType, message });
  const kind = eventType === "UPDATED" ? "PAPER_ORDER_UPDATED"
    : eventType === "CANCELLED" ? "PAPER_ORDER_CANCELLED" : "PAPER_ORDER_CLOSED";
  const linkedDecisionId = riskId != null ? `risk:${riskId}` : null;
  const payload = { userId: order.userId, orderId: order.id, linkedTradeId: String(order.id), linkedDecisionId, entityType: "paper_order",
    symbol: order.symbol, accountId: order.paperAccountId, status: order.status, stopLoss: order.stopLoss, takeProfit: order.takeProfit,
    exitPrice: order.exitPrice, pnl: order.profitLoss, ...extra, simulated: true, disclaimer: SIMULATED_TAG };
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

// ── P&L sizing ───────────────────────────────────────────────────────────
// Every path here sizes an order's P&L like the Build EE monitor
// (paperExecution/paperPnl.ts: contract size × quote→USD), so an order is
// valued in one unit whichever path values or closes it. The old
// `move × lots × 100` mis-sized every instrument (EURUSD 1,000×). A close that
// cannot be sized stores 0 in the NOT NULL profit_loss as a placeholder and
// its event says so; the balance (paperBookReader.bookedRealizedOf) counts it
// only when it lost, at the governor's paper model; a win of unknown size adds
// nothing. Risk readers count closes at the lower of their booked total and
// their paper risk model total (paperPnl.paperRiskTotals); the balance stays
// the booked sum.

/** Event text for a close whose amount could not be sized. */
function notSizedText(r: PaperPnlResult): string {
  return `P&L not sized: ${r.unavailableReason}. The 0 stored for this order is a placeholder, not a result.`;
}

/** How a valued paper account counts P&L that could not be sized. */
export interface PaperPnlSizing {
  /** Settled orders whose stored P&L is the not-sized 0 placeholder. */
  unsizedClosedOrders: number;
  /**
   * Of those, the ones that won (exit beyond entry in the trade's favour).
   * Their gain is not added to the balance (counted 0): a win of unknown size
   * never raises the balance or equity the Risk Governor reads.
   */
  unsizedClosedWins: number;
  /** Open positions whose unrealized P&L could not be sized. */
  unsizedOpenPositions: number;
  /**
   * Of those, the ones in profit on price. Their gain is not added to equity
   * (counted 0); one at a loss counts at the paper risk model. An open gain of
   * unknown size never raises the equity the Risk Governor reads.
   */
  unsizedOpenGains: number;
  /** Plain-English note for the account; null when everything was sized. */
  note: string | null;
}

export function paperPnlSizingNote(unsizedClosed: number, unsizedOpen = 0, unsizedClosedWins = 0, unsizedOpenGains = 0): string | null {
  if (unsizedClosed <= 0 && unsizedOpen <= 0) return null;
  const parts: string[] = [];
  if (unsizedClosed > 0) parts.push(`Balance includes ${unsizedClosed} closed trade${unsizedClosed === 1 ? "" : "s"}`);
  if (unsizedOpen > 0) parts.push(`${parts.length ? "equity" : "Equity"} includes ${unsizedOpen} open position${unsizedOpen === 1 ? "" : "s"}`);
  const how: string[] = [];
  if (unsizedClosed > 0) {
    const wins = Math.min(Math.max(0, unsizedClosedWins), unsizedClosed);
    const losses = unsizedClosed - wins;
    if (losses > 0) {
      how.push(`${losses === 1 ? "A closed trade that lost is" : `${losses} closed trades that lost are`} counted at the paper risk model (price move × lots × 100), not a measured amount.`);
    }
    if (wins > 0) {
      how.push(`${wins === 1 ? "A closed trade that won is" : `${wins} closed trades that won are`} not added to the balance (counted as 0), so the balance can be lower than the trades' real result.`);
    }
  }
  if (unsizedOpen > 0) {
    const gains = Math.min(Math.max(0, unsizedOpenGains), unsizedOpen);
    const rest = unsizedOpen - gains;
    if (rest > 0) {
      const all = gains === 0;
      how.push(`${rest === 1 ? (all ? "The open position is" : "An open position at a loss is") : (all ? "The open positions are" : `${rest} open positions at a loss are`)} counted at the paper risk model (price move × lots × 100), not a measured amount.`);
    }
    if (gains > 0) {
      how.push(`${gains === 1 ? "An open position in profit is" : `${gains} open positions in profit are`} not added to equity (counted as 0), so equity can be lower than the positions' real value.`);
    }
  }
  return `${parts.join("; ")} whose P&L could not be sized for the instrument `
    + `(no contract size or currency conversion). ${how.join(" ")}`;
}

/**
 * The paper risk model's scale (paperExecution/paperPnl.ts
 * PAPER_LEDGER_MODEL_CONTRACT_SIZE): price move × lots × 100. It is used only
 * for an amount that could not be sized for the instrument (pnlSizing says how
 * many), never as a measured result.
 */
export const PAPER_SIMULATOR_PNL_MULTIPLIER = 100;
/** Simulator margin per lot. Not a broker margin requirement. */
export const PAPER_SIMULATOR_MARGIN_PER_LOT = 1000;

/** Orders booked at a real market quote; every other order is opened and valued at the simulator's synthetic price. */
function isMarketPriced(o: Pick<PaperOrderRow, "strategyId">): boolean {
  return isMarketPricedPaperOrder(o);
}

/**
 * How markToMarket valued a paper account: where its prices came from and the
 * units its figures are in. A simulator-priced order's P&L is sized at a
 * synthetic price and margin is a simulator figure, so a reader is told so
 * instead of reading them as market results or broker figures.
 */
export interface PaperValuation {
  /** Price source of the open orders' current valuation. */
  priceSource: "SIMULATOR" | "MARKET_QUOTE" | "MIXED" | "NO_OPEN_ORDERS";
  openOrders: number;
  /** Open orders valued at the simulator's synthetic price (generated candles, not a market quote). */
  openPricedBySimulator: number;
  /**
   * Closed orders opened at the simulator's synthetic price (not booked at a
   * market quote). Their entry came from the simulator. A stop or target hit
   * may have been triggered by the synthetic price (mark-to-market) or by
   * market data (the paper execution monitor checks every open order's stop
   * and target), and either way is booked at the order's stop or target
   * level. A trader's close is booked at the simulator's price; an EE manual
   * close at a market price, or at the price given with the close request.
   * The order row does not record which path closed it.
   */
  closedSimulatorPriced: number;
  /**
   * PAPER_USD: P&L is sized in the paper account currency (USD) from the
   * instrument's contract size (paperExecution/paperPnl.ts); an amount that
   * could not be sized counts at the paper risk model (see pnlSizing).
   */
  units: "PAPER_USD";
  /** Multiplier of the paper risk model (price move × lots × this), used only for an amount that could not be sized. */
  pnlMultiplier: number;
  marginPerLot: number;
  note: string;
}

export function describePaperValuation(a: { openOrders: number; openPricedBySimulator: number; closedSimulatorPriced: number }): PaperValuation {
  const priceSource = a.openOrders === 0 ? "NO_OPEN_ORDERS"
    : a.openPricedBySimulator === 0 ? "MARKET_QUOTE"
    : a.openPricedBySimulator === a.openOrders ? "SIMULATOR" : "MIXED";
  const parts: string[] = [];
  const settledBy = "Simulator stops and targets settle at the crossed level. Market-priced positions close at the observed bid for a long or ask for a short.";
  if (priceSource === "SIMULATOR") {
    parts.push(`${a.openOrders === 1 ? "The open order is" : `All ${a.openOrders} open orders are`} valued at the simulator's synthetic price (generated, not a market quote). ${settledBy}`);
  } else if (priceSource === "MIXED") {
    parts.push(`${a.openPricedBySimulator} of ${a.openOrders} open orders are valued at the simulator's synthetic price (generated, not a market quote), the rest at a current market quote. ${settledBy}`);
  } else if (priceSource === "MARKET_QUOTE") {
    parts.push(`Open orders use the observed bid for a long or ask for a short.`);
  }
  if (a.closedSimulatorPriced > 0) {
    const one = a.closedSimulatorPriced === 1;
    parts.push(`${a.closedSimulatorPriced} closed order${one ? " was" : "s were"} opened at the simulator's synthetic price, not a market quote, so the balance includes synthetic results. Historical orders may have used a different exit price source. The stored exit price determines each recorded result.`);
  }
  parts.push(`Figures are simulated USD, not money in a broker account: P&L is sized in USD from the instrument's contract size; an amount that could not be sized counts at the paper risk model (price move × lots × ${PAPER_SIMULATOR_PNL_MULTIPLIER}), not a measured amount, except that a closed trade that won is not added to the balance and an open position in profit is not added to equity. Orders closed before every paper close was sized this way keep the figure stored then (price move × lots × ${PAPER_SIMULATOR_PNL_MULTIPLIER} for every symbol), so an older balance can mix the two scales. Margin is lots × ${PAPER_SIMULATOR_MARGIN_PER_LOT.toLocaleString("en-US")}, not a broker margin.`);
  return {
    priceSource,
    openOrders: a.openOrders,
    openPricedBySimulator: a.openPricedBySimulator,
    closedSimulatorPriced: a.closedSimulatorPriced,
    units: "PAPER_USD",
    pnlMultiplier: PAPER_SIMULATOR_PNL_MULTIPLIER,
    marginPerLot: PAPER_SIMULATOR_MARGIN_PER_LOT,
    note: parts.join(" "),
  };
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
// A close whose amount could not be sized (stored 0 placeholder) counts the
// way the paper book's booked figure counts it (bookedRealizedOf): a stop-out
// lowers the balance at the paper risk model, and a win of unknown size adds
// nothing. An open position that could not be sized counts the same way in
// equity: a floating loss at the paper risk model, a floating gain as 0. So an
// estimate never raises the balance or equity the Risk Governor reads. The
// balance is the booked sum; the governor lowers the equity it caps against to
// the risk count (paperPnl.paperRiskShortfall) itself.
// pnlSizing says how many closes and open positions that covers.
export async function markToMarket(accountId: number): Promise<(PaperAccountRow & { pnlSizing: PaperPnlSizing; valuation: PaperValuation }) | null> {
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
    if (!isMarketPriced(o)) continue;
    const quote = await currentQuote(o.symbol);
    if (!quote.ok) return null;
    prices.set(o.id, paperExitQuote(o.direction, quote));
  }
  let unrealized = 0;
  let margin = 0;
  let unsizedOpenPositions = 0;
  let unsizedOpenGains = 0;
  // Every order here has the account's owner, so one contract read per symbol.
  const contracts = new Map<string, Promise<ResolvedContractSize>>();
  const sized = (o: PaperOrderRow, price: number): Promise<PaperPnlResult> => {
    let c = contracts.get(o.symbol);
    if (!c) { c = resolvePaperContract(o.userId, o.symbol); contracts.set(o.symbol, c); }
    return c.then((contract) => sizePaperOrderPnl(o, price, contract));
  };
  let stillOpen = 0;
  let stillOpenBySimulator = 0;

  for (const o of open) {
    const px = prices.get(o.id) ?? getMockPrice(o.symbol, now);
    // (Build EE) EE-managed orders are owned by the Build EE monitor (which
    // uses Build DD market data). Mark-to-market must NOT auto-close them
    // with mock prices — refresh unrealized P&L only from a real quote.
    const eeOwned = isMarketPriced(o);
    const exit = eeOwned ? null : crossedPaperLevel(o, px);
    const hit: "TP" | "SL" | null = exit?.hit ?? null;
    if (exit && hit) {
      const exitPx = exit.level;
      const r = await sized(o, exitPx);
      const status = hit === "SL" ? "CLOSED_SL" : "CLOSED_TP";
      const settled = await settlePaperOrder({
        order: o, status, triggerLevel: exit.level, exitPrice: exitPx, pnl: r.amount ?? 0,
        eventMessage: o.userId == null ? null
          : `${SIMULATED_TAG} ${hit} hit at ${exitPx.toFixed(5)} on the simulator's synthetic price (not a market quote), ${r.amount != null ? `P&L ${r.amount.toFixed(2)}` : notSizedText(r)}`,
      });
      if (!settled) return null; // A concurrent close or bracket change invalidated this account snapshot.
      // (BB) Closed-loop auto-debrief on SL/TP close. Best-effort, idempotent.
      runAutoDebrief(o.id, { triggeredBy: "mark_to_market" })
        .catch(() => { /* non-fatal: never break mark-to-market */ });
    } else {
      const u = await sized(o, px);
      if (u.amount != null) unrealized += u.amount;
      else {
        // Not sized: a floating loss is counted at the governor's paper model
        // so it never drops out of equity; a floating gain of unknown size
        // adds nothing (counted 0), so an estimate never raises the equity
        // the Risk Governor reads. pnlSizing says so.
        const model = paperLedgerModelPnl(o.direction, o.lotSize, o.entryPrice, px);
        unrealized += Math.min(0, model);
        unsizedOpenPositions++;
        if (model > 0) unsizedOpenGains++;
      }
      margin += o.lotSize * PAPER_SIMULATOR_MARGIN_PER_LOT;
      stillOpen++;
      if (!prices.has(o.id)) stillOpenBySimulator++;
    }
  }

  // Authoritative balance: starting + Σ realized P&L from EVERY closed order.
  const closed = (await db.select().from(paperOrdersTable)
    .where(and(eq(paperOrdersTable.paperAccountId, accountId), ownedBy)))
    .filter((o) => o.status !== "OPEN");
  const realizedTotal = closed.reduce((s, o) => s + bookedRealizedOf(o), 0);
  const unsizedClosed = closed.filter((o) => isUnsizedPaperClose(o));
  const unsizedClosedOrders = unsizedClosed.length;
  const unsizedClosedWins = unsizedClosed
    .filter((o) => paperMoveSign(o.direction, o.entryPrice, o.exitPrice!) > 0).length;
  const newBalance = account.startingBalance + realizedTotal;
  const equity = newBalance + unrealized;
  await db.update(paperAccountsTable).set({
    currentBalance: newBalance, equity, marginUsed: margin, updatedAt: new Date(),
  }).where(eq(paperAccountsTable.id, accountId));

  const row = (await db.select().from(paperAccountsTable)
    .where(eq(paperAccountsTable.id, accountId)).limit(1))[0];
  if (!row) return null;
  // Where these figures came from and what units they are in (read-only; not stored).
  const valuation = describePaperValuation({
    openOrders: stillOpen,
    openPricedBySimulator: stillOpenBySimulator,
    closedSimulatorPriced: closed.filter((o) => o.status !== "CANCELLED" && !isMarketPriced(o)).length,
  });
  return {
    ...row,
    pnlSizing: {
      unsizedClosedOrders, unsizedClosedWins, unsizedOpenPositions, unsizedOpenGains,
      note: paperPnlSizingNote(unsizedClosedOrders, unsizedOpenPositions, unsizedClosedWins, unsizedOpenGains),
    },
    valuation,
  };
}

/** The order, its event and both audit records commit together. No network work
 * is allowed inside this transaction. Safety Core writers serialize against
 * the shared row lock, so a committed mode change cannot be missed at booking.
 */
async function bookPaperOrder(values: typeof paperOrdersTable.$inferInsert, risk: EnforceResult,
  message: string | null, extra: Record<string, unknown> = {}, execution?: PaperExecutionInsert,
): Promise<BookedPaperOrder | PaperFillBlocked> {
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
    // The unique decision receipt and its order must appear together, including on retries.
    const [receipt] = execution
      ? await tx.insert(paperExecutionsTable).values({ ...execution, orderId: order.id }).returning()
      : [];
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
    return { ok: true, order, ...(receipt && { execution: receipt }) };
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
  const exitPx = q ? paperExitQuote(a.side, q) : px;
  if (!validPaperOpenBracket(a.side, a.stopLoss, a.takeProfit, px, exitPx)) {
    return { ok: false, reason: "INVALID_SLTP_GEOMETRY", entryPrice: px };
  }
  // Pre-trade Risk Governor: the same rules a live order faces, priced
  // against the paper simulator's market.
  const risk = await enforcePreTradeRisk({
    userId: a.userId, venue: "PAPER", origin: a.origin ?? "manual", action: "OPEN",
    symbol: a.symbol, side: a.side, lots: a.lots,
    entryPrice: q ? null : a.entryPrice, stopLoss: a.stopLoss, takeProfit: a.takeProfit,
    ...(a.intentRef ? { intentRef: a.intentRef } : {}),
  }, {
    paperAccountId: a.paperAccountId,
    facts: { quote: q
      ? { bid: q.bid, ask: q.ask, at: q.at, source: q.source }
      : { bid: marketPx, ask: marketPx, at: new Date(nowMs), source: "paper_simulator_price" } },
    auditContext: { caller: a.caller, ...(a.clientRequestKey ? { clientRequestKey: a.clientRequestKey } : {}) },
    generatedEntry: a.decisionId != null,
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

async function currentOrderQuote(order: PaperOrderRow): ReturnType<typeof currentQuote> {
  if (isMarketPriced(order)) return currentQuote(order.symbol);
  const at = new Date();
  const price = getMockPrice(order.symbol, at.getTime());
  return { ok: true, bid: price, ask: price, at, source: "paper_simulator_price" };
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
  };
  const quote = await currentOrderQuote(cur);
  if (!quote.ok || (isMarketPriced(cur) && (quote.at < cur.openedAt || quote.at < cur.updatedAt))) {
    return { ok: false, reason: "NO_VALID_PRICE_SOURCE" };
  }
  const exitPx = paperExitQuote(cur.direction, quote);
  const crossed = crossedPaperLevel(cur, exitPx);
  if (crossed) {
    const fill = isMarketPriced(cur) ? exitPx : crossed.level;
    const sized = await sizePaperOrderPnl(cur, fill);
    const resultText = sized.amount != null ? `P&L ${sized.amount.toFixed(2)}` : notSizedText(sized);
    const settled = await settlePaperOrder({
      order: cur, status: crossed.hit === "SL" ? "CLOSED_SL" : "CLOSED_TP",
      triggerLevel: crossed.level, triggerObservedAt: isMarketPriced(cur) ? quote.at : undefined, exitPrice: fill, pnl: sized.amount ?? 0,
      eventMessage: `${SIMULATED_TAG} ${crossed.hit} reached before bracket change at ${fill} (${quote.source}), ${resultText}`,
    });
    if (!settled) return { ok: false, reason: "PAPER_ORDER_CHANGED" };
    await markToMarket(cur.paperAccountId);
    runAutoDebrief(cur.id, { triggeredBy: "mark_to_market" }).catch(() => {});
    return { ok: false, reason: "PAPER_EXIT_ALREADY_REACHED" };
  }
  const validBracket = cur.direction === "BUY"
    ? next.stopLoss < exitPx && exitPx < next.takeProfit
    : next.takeProfit < exitPx && exitPx < next.stopLoss;
  if (!validBracket) return { ok: false, reason: "INVALID_SLTP_GEOMETRY" };
  const risk = await enforcePreTradeRisk({
    userId: a.userId, venue: "PAPER", origin: "manual", action: "MODIFY",
    symbol: cur.symbol, side: cur.direction as "BUY" | "SELL", lots: cur.lotSize,
    stopLoss: next.stopLoss, takeProfit: next.takeProfit,
    position: { entryPrice: cur.entryPrice, stopLoss: cur.stopLoss },
  }, {
    paperAccountId: cur.paperAccountId,
    facts: { quote },
    auditContext: { caller: a.caller, orderId: a.orderId },
  });
  if (!risk.allowed) return governorRefusal(risk);
  const updated = await db.transaction(async tx => {
    const [order] = await tx.update(paperOrdersTable).set({ ...next, updatedAt: sql`clock_timestamp() AT TIME ZONE 'UTC'` })
      .where(and(eq(paperOrdersTable.id, a.orderId), eq(paperOrdersTable.userId, a.userId), eq(paperOrdersTable.status, "OPEN"),
        eq(paperOrdersTable.stopLoss, cur.stopLoss), eq(paperOrdersTable.takeProfit, cur.takeProfit))).returning();
    if (order) await recordPaperOutcome(tx, order, "UPDATED", `${SIMULATED_TAG} SL→${next.stopLoss} TP→${next.takeProfit}`, risk.auditEventId);
    return order;
  });
  if (!updated) {
    const latest = await ownPaperOrder(a.orderId, a.userId);
    return { ok: false, reason: latest?.status === "OPEN" ? "PAPER_ORDER_CHANGED" : "PAPER_ORDER_NOT_OPEN" };
  }
  await markToMarket(cur.paperAccountId);
  return { ok: true, order: await ownPaperOrder(a.orderId, a.userId) };
}

/** Close using the order's price model. Market-priced orders never fall back to simulation. */
export async function closePaperOrder(a: { userId: number; orderId: number; caller: string }): Promise<PaperResult> {
  const cur = await ownPaperOrder(a.orderId, a.userId);
  if (!cur) return { ok: false, reason: "PAPER_ORDER_NOT_FOUND" };
  if (cur.status !== "OPEN") return { ok: false, reason: "PAPER_ORDER_NOT_OPEN" };
  const quote = await currentOrderQuote(cur);
  if (!quote.ok) return { ok: false, reason: "NO_VALID_PRICE_SOURCE" };
  const exitPx = paperExitQuote(cur.direction, quote);
  const priceSource = quote.source;
  const risk = await enforcePreTradeRisk({
    userId: a.userId, venue: "PAPER", origin: "manual", action: "CLOSE",
    symbol: cur.symbol, side: cur.direction as "BUY" | "SELL", lots: cur.lotSize,
    intentRef: `paper_close:${a.orderId}`,
  }, {
    paperAccountId: cur.paperAccountId,
    facts: { quote },
    auditContext: { caller: a.caller, orderId: a.orderId, priceSource, quoteAt: isMarketPriced(cur) ? quote.at.toISOString() : null },
  });
  if (!risk.allowed) return governorRefusal(risk);
  const r = await sizePaperOrderPnl(cur, exitPx);
  const closed = await db.transaction(async tx => {
    const [order] = await tx.update(paperOrdersTable).set({
      status: "CLOSED_MANUAL", closedAt: new Date(), exitPrice: exitPx,
      profitLoss: r.amount ?? 0, updatedAt: new Date(),
    }).where(and(eq(paperOrdersTable.id, a.orderId), eq(paperOrdersTable.userId, a.userId), eq(paperOrdersTable.status, "OPEN"))).returning();
    if (order) await recordPaperOutcome(tx, order, "CLOSED_MANUAL", r.amount != null
      ? `${SIMULATED_TAG} closed @ ${exitPx.toFixed(5)}, P&L ${r.amount.toFixed(2)} (${priceSource})`
      : `${SIMULATED_TAG} closed @ ${exitPx.toFixed(5)} (${priceSource}), ${notSizedText(r)}`,
      risk.auditEventId, { pnl: r.amount, manual: true, ...(r.amount == null ? { pnlUnavailableReason: r.unavailableReason } : {}) });
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
  execution?: PaperExecutionInsert;
}

/**
 * Book an order filled at a caller-priced quote. The caller owns its own
 * eligibility, sizing and geometry rules; this function runs the pre-trade
 * Risk Governor (venue PAPER, action OPEN) and books the order only when it
 * allows. The governor's result is returned either way so callers keep
 * their own refusal envelopes.
 */
export async function openPaperFill(a: PaperFillOpenArgs): Promise<(BookedPaperOrder & { risk: EnforceResult }) | PaperFillBlocked> {
  const risk = await enforcePreTradeRisk({
    userId: a.userId, venue: "PAPER", origin: a.origin, action: "OPEN",
    symbol: a.symbol, side: a.side, lots: a.lots,
    ...("governedEntryPrice" in a ? { entryPrice: a.governedEntryPrice } : {}),
    stopLoss: a.stopLoss, takeProfit: a.takeProfit,
    ...(a.intentRef !== undefined ? { intentRef: a.intentRef } : {}),
  }, {
    paperAccountId: a.paperAccountId,
    facts: { quote: a.quote },
    auditContext: a.auditContext,
    generatedEntry: a.decisionId != null,
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
  }, risk, a.placedMessage, { caller: a.auditContext.caller ?? null }, a.execution);
  if (!booked.ok) return booked;
  return { ...booked, risk };
}

/**
 * Close an open order at a caller-priced exit (Build EE manual close). The
 * caller has loaded the order scoped to its owner. Risk Governor CLOSE,
 * venue PAPER, then the close and its event.
 */
export async function closePaperFill(a: {
  userId: number; order: PaperOrderRow; exitPrice: number;
  intentRef: string; auditContext: Record<string, unknown>; eventLabel: string;
}): Promise<{ ok: true; pnl: number | null; pnlUnavailableReason: string | null } | PaperFillRefusal> {
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
  const r = await sizePaperOrderPnl(o, a.exitPrice);
  const closed = await db.transaction(async tx => {
    const [order] = await tx.update(paperOrdersTable).set({
      status: "CLOSED_MANUAL", closedAt: new Date(), exitPrice: a.exitPrice, profitLoss: r.amount ?? 0, updatedAt: new Date(),
    }).where(and(eq(paperOrdersTable.id, o.id), eq(paperOrdersTable.userId, a.userId), eq(paperOrdersTable.status, "OPEN"))).returning();
    if (order) await recordPaperOutcome(tx, order, "CLOSED_MANUAL",
      `${SIMULATED_TAG} ${a.eventLabel} @ ${a.exitPrice.toFixed(5)}, ${r.amount != null ? `P&L ${r.amount.toFixed(2)}` : notSizedText(r)}`,
      risk.auditEventId, { pnl: r.amount, ...(r.amount == null ? { pnlUnavailableReason: r.unavailableReason } : {}) });
    return order;
  });
  if (!closed) return { ok: false, reason: "PAPER_ORDER_NOT_OPEN" };
  return { ok: true, pnl: r.amount, pnlUnavailableReason: r.unavailableReason };
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
  triggerLevel?: number;
  /** Source time of the executable market quote that crossed the bracket. */
  triggerObservedAt?: Date;
  exitPrice: number; pnl: number; eventMessage: string | null;
}): Promise<boolean> {
  return db.transaction(async tx => {
    const [order] = await tx.update(paperOrdersTable).set({
      status: a.status, closedAt: new Date(), exitPrice: a.exitPrice,
      profitLoss: a.pnl, updatedAt: new Date(),
    }).where(and(eq(paperOrdersTable.id, a.order.id), eq(paperOrdersTable.status, "OPEN"),
      a.triggerObservedAt ? lte(paperOrdersTable.openedAt, a.triggerObservedAt) : undefined,
      a.triggerObservedAt ? lte(paperOrdersTable.updatedAt, a.triggerObservedAt) : undefined,
      a.triggerLevel !== undefined && a.status === "CLOSED_SL" ? eq(paperOrdersTable.stopLoss, a.triggerLevel) : undefined,
      a.triggerLevel !== undefined && a.status === "CLOSED_TP" ? eq(paperOrdersTable.takeProfit, a.triggerLevel) : undefined,
      a.order.userId == null ? isNull(paperOrdersTable.userId) : eq(paperOrdersTable.userId, a.order.userId))).returning();
    if (!order) return false;
    await recordPaperOutcome(tx, order, a.status, a.eventMessage);
    return true;
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
