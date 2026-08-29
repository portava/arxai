// Build EE — Paper Execution Service.
//
// SAFETY (strict freeze): this service NEVER calls executeTrade,
// /execute-trade, mt5_*, livePositions, setCanPlaceTrades, or any live broker.
// It ONLY:
//   1. Reads a Build AA TradeDecision (in-memory or via decision_id from logs)
//   2. Reads Build DD market data for the simulated fill (READ-ONLY)
//   3. Validates eligibility (15+ rules)
//   4. Inserts a row into the existing `paper_orders` table (Build Q)
//   5. Records a paper_executions row keyed by decision_id (idempotent)
//   6. Logs every step to paper_execution_logs
//
// The existing markToMarket() in routes/paperTrading.ts will pick up the new
// open paper order and trigger Build BB auto-debrief on close. EE's monitor
// also closes orders independently using DD market data and triggers BB.

import {
  db,
  paperAccountsTable,
  paperOrdersTable,
  paperExecutionsTable,
  paperExecutionLogsTable,
  paperTradeEventsTable,
  tradeDecisionLogsTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import { getMarketData } from "../marketData/marketDataService.js";
import { calculatePositionSize, PAPER_DEFAULTS } from "./positionSizing.js";
import { checkEligibility } from "./eligibility.js";
import { gateForPaperTrade } from "../riskGovernor/governor.js";
import type {
  ExecuteFromDecisionOpts,
  PaperExecutionResult,
  FillType,
} from "./types.js";
import type { TradeDecision } from "../../routes/tradeDecision.js";

const SIMULATED_TAG = "Simulated — paper trading does not guarantee live results.";
const SIM_SLIPPAGE_BPS = 0.0001; // 1 basis-point of mid as slippage on top of spread

async function logExec(args: {
  executionId: string | null;
  decisionId: number | null;
  orderId: number | null;
  symbol: string;
  action: string;
  status: string;
  message: string;
  details?: Record<string, unknown>;
}) {
  try {
    await db.insert(paperExecutionLogsTable).values({
      executionId: args.executionId,
      decisionId:  args.decisionId,
      orderId:     args.orderId,
      symbol:      args.symbol,
      action:      args.action,
      status:      args.status,
      message:     args.message,
      details:     args.details ?? {},
    });
  } catch (err) {
    // Logging must never break execution.
    logger.warn({ err: String(err) }, "Build EE: paper_execution_logs insert failed (non-fatal)");
  }
}

// ISOLATION: a paper account belongs to ONE trader. An explicit id is only
// honoured when that account is actually owned by the caller — otherwise a
// caller could execute into somebody else's sandbox by guessing an integer.
async function getActivePaperAccount(userId: number, explicitId?: number) {
  if (explicitId != null) {
    const rows = await db.select().from(paperAccountsTable)
      .where(and(eq(paperAccountsTable.id, explicitId),
                 eq(paperAccountsTable.userId, userId))).limit(1);
    return rows[0] ?? null;
  }
  const rows = await db.select().from(paperAccountsTable)
    .where(and(eq(paperAccountsTable.userId, userId),
               eq(paperAccountsTable.isActive, 1)))
    .orderBy(desc(paperAccountsTable.id)).limit(1);
  return rows[0] ?? null;
}

// The account MUST carry its owner. Created unowned, the Risk Governor could
// never find equity to apply the trader's configured daily-loss percentage to,
// so it reported dailyLossLimitBasis="UNKNOWN" and — correctly, given what it
// could see — hard-blocked the trader out of their own paper account.
async function ensurePaperAccount(userId: number, explicitId?: number): Promise<{ id: number; equity: number }> {
  const existing = await getActivePaperAccount(userId, explicitId);
  if (existing) return { id: existing.id, equity: existing.equity };
  if (explicitId != null) {
    throw new Error(`paper account ${explicitId} does not exist or is not owned by this trader`);
  }
  // Create a default sandbox account so EE can always run.
  const ins = await db.insert(paperAccountsTable).values({
    userId,
    accountName: "Build EE Sandbox",
    startingBalance: PAPER_DEFAULTS.defaultEquity,
    currentBalance: PAPER_DEFAULTS.defaultEquity,
    equity: PAPER_DEFAULTS.defaultEquity,
    isActive: 1,
  }).returning();
  return { id: ins[0]!.id, equity: ins[0]!.equity };
}

function applySimulatedFill(action: "BUY" | "SELL", md: {
  bid: number; ask: number; mid: number; spread: number;
}): { fillPrice: number; slippage: number; spread: number } {
  // BUY → fill at ask + (slippage); SELL → fill at bid - (slippage)
  const slippage = Math.max(0.00001, md.mid * SIM_SLIPPAGE_BPS);
  const fill = action === "BUY"
    ? md.ask + slippage
    : md.bid - slippage;
  return { fillPrice: Number(fill.toFixed(5)), slippage: Number(slippage.toFixed(5)), spread: md.spread };
}

export async function executePaperFromDecision(
  decision: TradeDecision,
  decisionId: number | null,
  opts: ExecuteFromDecisionOpts,
): Promise<PaperExecutionResult> {
  const userId = opts.userId;
  const executionId = `exec_${randomUUID()}`;
  const symbol = decision.symbol;
  const action = decision.action;
  const log = logger.child({ system: "paperExecution", executionId, decisionId, symbol, action });

  log.info({ shouldTrade: decision.shouldTrade, confidence: decision.confidence, riskScore: decision.riskScore },
    "Build EE: decision received");

  // ── Build HH gate: Risk Governor must allow paper trading ──
  try {
    // The gate MUST be scoped to the trader whose trade this is. Called with
    // no identity, collectMetrics() summed EVERY user's closed paper orders
    // into dailyPnl and returned dailyLossLimitBasis="UNKNOWN" — which trips
    // the (correct) DAILY_LOSS_LIMIT_UNKNOWN fail-closed block, so on any day
    // the platform's aggregate paper P&L was negative, every user's execution
    // was rejected.
    const gate = await gateForPaperTrade(userId);
    if (!gate.allowed) {
      log.warn({ governorStatus: gate.status, governorId: gate.governorId, reasons: gate.reasons },
        "Build EE: paper trade BLOCKED by Risk Governor");
      return persistRejection({
        executionId, userId, decisionId, symbol, action, decision,
        reason: `RISK_GOVERNOR_BLOCK[${gate.status}]: ${gate.reasons[0] ?? "blocked"}`,
        warnings: gate.reasons,
      });
    }
  } catch (e) {
    log.error({ err: String(e).slice(0, 200) }, "Build EE: governor gate threw — failing CLOSED (paper trade rejected)");
    return persistRejection({
      executionId, userId, decisionId, symbol, action, decision,
      reason: `RISK_GOVERNOR_GATE_ERROR: ${String(e).slice(0, 160)}`,
      warnings: ["RISK_GOVERNOR_GATE_ERROR: governor evaluation failed; defaulting to fail-closed"],
    });
  }

  // ── Idempotency: short-circuit if a paper execution already exists for this decision ──
  if (decisionId != null) {
    // idempotency lookup on the UNIQUE decision_id, and the decision itself
    // was already proven to belong to this caller by
    // loadDecisionFromLog(decisionId, userId). Not a listing.
    // isolation-ok: see the note directly above.
    const dup = await db.select().from(paperExecutionsTable)
      .where(eq(paperExecutionsTable.decisionId, decisionId)).limit(1);
    if (dup[0]) {
      const e = dup[0];
      log.info({ existingExecutionId: e.executionId, existingOrderId: e.orderId },
        "Build EE: idempotent replay — returning existing paper execution");
      await logExec({
        executionId: e.executionId, decisionId, orderId: e.orderId,
        symbol, action, status: "IDEMPOTENT_REPLAY",
        message: `Returning existing paper execution for decision_id=${decisionId}`,
      });
      return materializeResult(e, true);
    }
  }

  // Account + caps
  let acct: { id: number; equity: number };
  try {
    acct = await ensurePaperAccount(userId, opts.paperAccountId);
  } catch (e) {
    return persistRejection({
      executionId, userId, decisionId, symbol, action, decision,
      reason: `PAPER_ACCOUNT_UNAVAILABLE: ${String(e).slice(0, 160)}`,
      warnings: ["PAPER_ACCOUNT_UNAVAILABLE: no paper account owned by this trader matched the request"],
    });
  }
  const allOpen = await db.select().from(paperOrdersTable)
    .where(and(eq(paperOrdersTable.userId, userId),
               eq(paperOrdersTable.paperAccountId, acct.id),
               eq(paperOrdersTable.status, "OPEN")));
  const openSameSymbolDir = allOpen.filter((o) => o.symbol === symbol && o.direction === action).length;

  // ── Eligibility ──
  const eligibility = checkEligibility(decision, decisionId, {
    openPaperOrdersForSymbolAndDir: openSameSymbolDir,
    totalOpenPaperOrders: allOpen.length,
    duplicateExecutionExists: false, // checked above
    allowConflicts: opts.allowConflicts === true,
    maxOpenPaperTrades: PAPER_DEFAULTS.maxOpenPaperTrades,
    maxSameSymbolPaperTrades: PAPER_DEFAULTS.maxSameSymbolPaperTrades,
  });

  log.info({ ok: eligibility.ok, reason: eligibility.reason, warnings: eligibility.warnings },
    "Build EE: eligibility evaluated");

  if (!eligibility.ok) {
    return persistRejection({
      executionId, userId, decisionId, symbol, action,
      decision,
      reason: eligibility.reason ?? "rejected",
      warnings: eligibility.warnings,
    });
  }

  // ── DD market data for simulated fill ──
  const { snapshot, blockers, usedFallback, providerError } = await getMarketData({
    symbol, timeframe: "M5", limit: 100,
  });
  log.info({ source: snapshot.source, provider: snapshot.provider, dataQuality: snapshot.dataQuality.status,
    usedFallback, providerError, ddBlockers: blockers.length },
    "Build EE: DD market data fetched");

  // Defense-in-depth: re-verify DD blockers right at fill time.
  const ddCritical = blockers.find((b) => b.severity === "CRITICAL" || b.severity === "HIGH");
  if (ddCritical) {
    return persistRejection({
      executionId, userId, decisionId, symbol, action, decision,
      reason: `DD market-data blocker at fill time: ${ddCritical.reason}`,
      warnings: [...eligibility.warnings, ...snapshot.dataQuality.warnings],
      mdSnapshot: snapshot,
    });
  }

  // ── Simulated fill ──
  const fillType: FillType = "SIMULATED_MARKET";
  // Eligibility ensured action ∈ {BUY, SELL}.
  const dir = action as "BUY" | "SELL";
  const { fillPrice, slippage, spread } = applySimulatedFill(dir, snapshot);
  const stopLoss = decision.stopLoss as number;
  const takeProfit = decision.takeProfit as number;

  // Validate SL/TP geometry against the *filled* price (existing rule).
  const slOk = action === "BUY" ? stopLoss < fillPrice : stopLoss > fillPrice;
  const tpOk = action === "BUY" ? takeProfit > fillPrice : takeProfit < fillPrice;
  if (!slOk || !tpOk) {
    return persistRejection({
      executionId, userId, decisionId, symbol, action, decision,
      reason: `SL/TP geometry invalid for filled price ${fillPrice}: SL=${stopLoss} TP=${takeProfit}`,
      warnings: eligibility.warnings, mdSnapshot: snapshot,
    });
  }

  // ── Position sizing ──
  const sizing = calculatePositionSize({
    accountEquity: acct.equity,
    entryPrice: fillPrice,
    stopLoss,
  });
  const positionSize = sizing.capped_position_size;
  log.info({ sizing }, "Build EE: position sizing computed");

  if (!(positionSize > 0)) {
    return persistRejection({
      executionId, userId, decisionId, symbol, action, decision,
      reason: `Position sizing returned zero: ${sizing.reason}`,
      warnings: eligibility.warnings, mdSnapshot: snapshot,
    });
  }

  // ── Insert paper_orders (Build Q table — single source of truth for open positions) ──
  const orderIns = await db.insert(paperOrdersTable).values({
    userId,
    paperAccountId: acct.id,
    symbol, direction: action, orderType: "MARKET",
    lotSize: positionSize,
    entryPrice: fillPrice,
    stopLoss, takeProfit,
    status: "OPEN",
    decisionId: decisionId ?? null,
    strategyId: "build_ee_paper_execution",
  }).returning();
  const order = orderIns[0]!;

  // Order event
  await db.insert(paperTradeEventsTable).values({
    paperOrderId: order.id,
    eventType: "PLACED",
    message: `${SIMULATED_TAG} EE/${action} ${symbol} @ ${fillPrice} SL ${stopLoss} TP ${takeProfit} lot ${positionSize} (decision=${decisionId ?? "n/a"})`,
  }).catch(() => { /* non-fatal */ });

  // ── Insert paper_executions (idempotency mapping + audit) ──
  const decisionSnapshot = sanitizeDecisionForJson(decision);
  const marketDataSnapshot = {
    source: snapshot.source, provider: snapshot.provider,
    bid: snapshot.bid, ask: snapshot.ask, mid: snapshot.mid, spread: snapshot.spread,
    timestamp: snapshot.timestamp, timeframe: snapshot.timeframe,
    candlesAvailable: snapshot.dataQuality.candlesAvailable,
    sessionContext: snapshot.sessionContext,
    dataQuality: snapshot.dataQuality,
  };
  const executionSnapshot = {
    fillType, fillPrice, requestedPrice: snapshot.mid,
    slippageApplied: slippage, spreadApplied: spread,
    sizing,
  };
  let execRow;
  try {
    const ins = await db.insert(paperExecutionsTable).values({
      userId,
      executionId, decisionId: decisionId!, orderId: order.id,
      symbol, action, status: "PAPER_OPENED",
      fillType, executionMode: "PAPER",
      entryPriceRequested: snapshot.mid,
      entryPriceFilled: fillPrice,
      stopLoss, takeProfit,
      positionSize,
      riskAmount: sizing.risk_amount,
      spreadApplied: spread,
      slippageApplied: slippage,
      confidence: decision.confidence,
      riskScore: decision.riskScore,
      rejectionReason: null,
      warnings: [...eligibility.warnings, ...snapshot.dataQuality.warnings],
      marketDataSnapshot,
      decisionSnapshot,
      executionSnapshot,
    }).returning();
    execRow = ins[0]!;
  } catch (err) {
    // Race-condition idempotency — another caller inserted concurrently.
    log.warn({ err: String(err) }, "Build EE: paper_executions insert collision, returning existing row");
    // same UNIQUE decision_id idempotency key as above, on the
    // concurrent-insert path.
    // isolation-ok: see the note directly above.
    const racy = (await db.select().from(paperExecutionsTable)
      .where(eq(paperExecutionsTable.decisionId, decisionId!)).limit(1))[0];
    if (racy) {
      // Roll back our just-created paper_orders row to keep the system clean.
      // keyed by order.id, the primary key of the row this call inserted
      // moments ago with `userId`.
      // isolation-ok: see the note directly above.
      await db.update(paperOrdersTable).set({ status: "CANCELLED", updatedAt: new Date() })
        .where(eq(paperOrdersTable.id, order.id))
        .catch(() => {});
      return materializeResult(racy, true);
    }
    throw err;
  }

  await logExec({
    executionId, decisionId, orderId: order.id, symbol, action,
    status: "PAPER_OPENED",
    message: `Simulated ${action} fill at ${fillPrice} (lot ${positionSize})`,
    details: { fillType, slippage, spread, sizing, mdSource: snapshot.source },
  });

  log.info({ orderId: order.id, fillPrice, positionSize }, "Build EE: paper trade opened");

  return materializeResult(execRow, false);
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

function sanitizeDecisionForJson(d: TradeDecision): Record<string, unknown> {
  return {
    symbol: d.symbol, action: d.action, shouldTrade: d.shouldTrade,
    confidence: d.confidence, riskScore: d.riskScore,
    stopLoss: d.stopLoss, takeProfit: d.takeProfit, positionSize: d.positionSize,
    tradeWindow: d.tradeWindow,
    blockers: d.blockers, warnings: d.warnings,
    invalidationReason: d.invalidationReason,
    marketDataSummary: d.marketDataSummary,
    syntheticData: d.syntheticData,
  };
}

async function persistRejection(args: {
  executionId: string;
  userId: number;
  decisionId: number | null;
  symbol: string;
  action: "BUY" | "SELL" | "HOLD";
  decision: TradeDecision;
  reason: string;
  warnings: string[];
  mdSnapshot?: import("../marketData/types.js").MarketDataSnapshot;
}): Promise<PaperExecutionResult> {
  const log = logger.child({ system: "paperExecution", executionId: args.executionId, decisionId: args.decisionId });
  // Try to persist the rejection — but only if decisionId is present (idempotency
  // key) and not already taken; otherwise just log + return.
  let row: typeof paperExecutionsTable.$inferSelect | null = null;
  if (args.decisionId != null) {
    try {
      const ins = await db.insert(paperExecutionsTable).values({
        userId: args.userId,
        executionId: args.executionId,
        decisionId: args.decisionId,
        orderId: null,
        symbol: args.symbol,
        action: args.action,
        status: "PAPER_REJECTED",
        fillType: "SIMULATED_MARKET",
        executionMode: "PAPER",
        entryPriceRequested: null,
        entryPriceFilled: null,
        stopLoss: args.decision.stopLoss ?? null,
        takeProfit: args.decision.takeProfit ?? null,
        positionSize: null,
        riskAmount: null,
        spreadApplied: null,
        slippageApplied: null,
        confidence: args.decision.confidence ?? null,
        riskScore:  args.decision.riskScore ?? null,
        rejectionReason: args.reason,
        warnings: args.warnings,
        marketDataSnapshot: args.mdSnapshot
          ? { source: args.mdSnapshot.source, provider: args.mdSnapshot.provider,
              dataQuality: args.mdSnapshot.dataQuality, sessionContext: args.mdSnapshot.sessionContext }
          : {},
        decisionSnapshot: sanitizeDecisionForJson(args.decision),
        executionSnapshot: {},
      }).returning();
      row = ins[0]!;
    } catch (err) {
      // If unique violation on decisionId, fetch existing.
      // unique-violation recovery on the decision_id key this call just
      // attempted to insert.
      // isolation-ok: see the note directly above.
      const existing = (await db.select().from(paperExecutionsTable)
        .where(eq(paperExecutionsTable.decisionId, args.decisionId)).limit(1))[0];
      if (existing) row = existing;
      else log.warn({ err: String(err) }, "Build EE: rejection persist failed (non-fatal)");
    }
  }

  await logExec({
    executionId: args.executionId, decisionId: args.decisionId, orderId: null,
    symbol: args.symbol, action: args.action,
    status: "PAPER_REJECTED",
    message: args.reason,
    details: { warnings: args.warnings },
  });

  log.info({ reason: args.reason }, "Build EE: paper trade rejected");

  if (row) return materializeResult(row, false);

  // Fallback (decisionId missing): return synthetic result without persistence.
  return {
    execution_id: args.executionId,
    decision_id: args.decisionId,
    trade_id: null,
    symbol: args.symbol,
    action: args.action,
    status: "PAPER_REJECTED",
    entry_price_requested: null, entry_price_filled: null,
    stop_loss: args.decision.stopLoss ?? null,
    take_profit: args.decision.takeProfit ?? null,
    position_size: null, risk_amount: null,
    confidence: args.decision.confidence ?? null,
    risk_score:  args.decision.riskScore ?? null,
    execution_mode: "PAPER",
    fill_type: "SIMULATED_MARKET",
    slippage_applied: null, spread_applied: null,
    rejection_reason: args.reason,
    warnings: args.warnings,
    created_at: new Date().toISOString(),
    idempotent_replay: false,
  };
}

function materializeResult(
  row: typeof paperExecutionsTable.$inferSelect,
  idempotentReplay: boolean,
): PaperExecutionResult {
  return {
    execution_id: row.executionId,
    decision_id:  row.decisionId,
    trade_id:     row.orderId,
    symbol:       row.symbol,
    action:       row.action as "BUY" | "SELL" | "HOLD",
    status:       row.status as PaperExecutionResult["status"],
    entry_price_requested: row.entryPriceRequested,
    entry_price_filled:    row.entryPriceFilled,
    stop_loss:    row.stopLoss,
    take_profit:  row.takeProfit,
    position_size: row.positionSize,
    risk_amount:   row.riskAmount,
    confidence:    row.confidence,
    risk_score:    row.riskScore,
    execution_mode: "PAPER",
    fill_type: (row.fillType as FillType) ?? "SIMULATED_MARKET",
    slippage_applied: row.slippageApplied,
    spread_applied:   row.spreadApplied,
    rejection_reason: row.rejectionReason,
    warnings: Array.isArray(row.warnings) ? (row.warnings as string[]) : [],
    created_at: row.createdAt.toISOString(),
    idempotent_replay: idempotentReplay,
  };
}

/* ── Helpers callable by routes ────────────────────────────────────────── */

export async function getPaperExecutionByDecisionId(decisionId: number) {
  // keyed by the UNIQUE decision_id the caller already owns — the only caller
  // is the autopilot cycle that created that decision.
  // isolation-ok: see the note directly above.
  const rows = await db.select().from(paperExecutionsTable)
    .where(eq(paperExecutionsTable.decisionId, decisionId)).limit(1);
  return rows[0] ?? null;
}

// ISOLATION: a decision may only be executed by the trader it was produced
// for. Unscoped, /paper-execution/from-decision would open a paper order in
// the caller's account from a stranger's decision.
export async function loadDecisionFromLog(decisionId: number, userId: number): Promise<TradeDecision | null> {
  const rows = await db.select().from(tradeDecisionLogsTable)
    .where(and(eq(tradeDecisionLogsTable.id, decisionId),
               eq(tradeDecisionLogsTable.userId, userId))).limit(1);
  if (!rows[0]) return null;
  // The full decision object was logged in tradeDecisionLogsTable.decisionJson
  // by the AA orchestrator (see persistDecision in routes/tradeDecision.ts).
  const json = (rows[0] as { decisionJson?: unknown }).decisionJson;
  return (json && typeof json === "object" ? json as TradeDecision : null);
}

export async function listOpenPaperExecutions(userId: number, limit = 50) {
  return db.select().from(paperExecutionsTable)
    .where(and(eq(paperExecutionsTable.userId, userId),
               eq(paperExecutionsTable.status, "PAPER_OPENED")))
    .orderBy(desc(paperExecutionsTable.createdAt))
    .limit(limit);
}

export async function listPaperExecutions(userId: number, limit = 50) {
  return db.select().from(paperExecutionsTable)
    .where(eq(paperExecutionsTable.userId, userId))
    .orderBy(desc(paperExecutionsTable.createdAt))
    .limit(limit);
}
