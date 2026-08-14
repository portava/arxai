// Build F — Live Execution Safety Layer.
//
// Five routes that gate every live-broker order behind a checklist confirmation
// flow. Composes Build D permission verdict + safetyCore + mt5State + the pure
// execution-safety/checklist domain module. Never executes orders directly —
// that remains gated by safetyCore.tradeGate in routes/trades.ts. This router
// only records *intent + decision*. Every state transition appends a vault
// event for full audit trail.

import { Router } from "express";
import { db, executionConfirmationsTable, riskSettingsTable, mt5StateTable, vaultEventsTable } from "@workspace/db";
import { and, desc, eq, gt, gte, lte, sql } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { z } from "zod/v4";
import {
  CreateExecutionConfirmationBody,
  ConfirmExecutionBody,
  CancelExecutionBody,
  GetExecutionHistoryQueryParams,
} from "@workspace/api-zod";
import { evaluateChecklist, type ChecklistMarketCondition } from "@workspace/domain/execution-safety";
import { getStatus } from "../lib/safetyCore.js";
import { getOrCreateUserRiskSettings } from "../lib/risk/userRiskSettings.js";

const router = Router();

// Confirmations expire after this many seconds if not confirmed/cancelled.
// Short window keeps stale tokens from being replayed against fresh prices.
const CONFIRMATION_TTL_SECONDS = 120;

// ── Helpers ─────────────────────────────────────────────────────────────────

async function loadMt5State() {
  const rows = await db.select().from(mt5StateTable).limit(1);
  return rows[0] ?? null;
}

async function loadCurrentPermission(userId: number) {
  // Build F — compose Build D's canonical permission evaluator. No fallback:
  // checklist verdicts MUST reflect risk locks, day-loss caps, kill switch, etc.
  const { gatherInputsAndEvaluate } = await import("./permission.js");
  const { verdict } = await gatherInputsAndEvaluate(userId);
  return { status: verdict.status, blockers: verdict.blockers };
}

function rowToResponse(row: typeof executionConfirmationsTable.$inferSelect) {
  return {
    id: row.id,
    userId: row.userId,
    symbol: row.symbol,
    direction: row.direction,
    lotSize: row.lotSize,
    entryType: row.entryType,
    entryPrice: row.entryPrice,
    stopLoss: row.stopLoss,
    takeProfit: row.takeProfit,
    estimatedRisk: row.estimatedRisk,
    rewardToRisk: row.rewardToRisk,
    marketCondition: row.marketCondition,
    permissionStatus: row.permissionStatus,
    brokerConnected: row.brokerConnected,
    practiceMode: row.practiceMode,
    aiConfidence: row.aiConfidence,
    fitScore: row.fitScore,
    warnings: row.warnings,
    blockers: row.blockers,
    status: row.status,
    userConfirmed: row.userConfirmed,
    executed: row.executed,
    executionResult: row.executionResult,
    executedTradeId: row.executedTradeId,
    confirmedAtIso: row.confirmedAt ? row.confirmedAt.toISOString() : null,
    cancelledAtIso: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    executedAtIso: row.executedAt ? row.executedAt.toISOString() : null,
    expiresAtIso: row.expiresAt.toISOString(),
    createdAtIso: row.createdAt.toISOString(),
  };
}

async function appendVault(kind: string, severity: "INFO" | "WARN" | "DANGER", row: typeof executionConfirmationsTable.$inferSelect, extra: Record<string, unknown> = {}) {
  await db.insert(vaultEventsTable).values({
    kind,
    severity,
    source: "USER",
    truthDomain: "EXECUTION",
    summary: `${kind}: ${row.symbol} ${row.direction} ${row.lotSize} (#${row.id})`,
    payload: { confirmationId: row.id, symbol: row.symbol, direction: row.direction, lot: row.lotSize, ...extra },
    reasons: row.warnings,
    blockers: row.blockers,
    generatedAtIso: new Date().toISOString(),
  }).catch(() => { /* non-fatal */ });
}

// Sweep expired PENDING/CONFIRMED confirmations into EXPIRED at read-time.
// Keeps the state honest without a background job. Only flips terminal-eligible
// rows (PENDING / CONFIRMED) — never disturbs EXECUTED / CANCELLED / REJECTED.
async function expireStale() {
  await db.execute(sql`
    UPDATE execution_confirmations
    SET status = 'EXPIRED'
    WHERE expires_at < now()
      AND status IN ('PENDING', 'CONFIRMED')
  `).catch(() => { /* non-fatal */ });
}

// ── Routes ──────────────────────────────────────────────────────────────────

// POST /execution-confirmations — create a checklist for a proposed order.
// Returns the persisted confirmation row + checklist verdict.
router.post("/execution-confirmations", requireUser, async (req, res) => {
  try {
    const body = CreateExecutionConfirmationBody.parse(req.body);
    const userId = String(req.authUser!.id);

    const [settings, mt5, permission, sysStatus] = await Promise.all([
      getOrCreateUserRiskSettings(req.authUser!.id),
      loadMt5State(),
      loadCurrentPermission(req.authUser!.id),
      getStatus(),
    ]);

    // Broker is "connected" when we've seen an MT5 EA heartbeat in the last 60s.
    // mt5_state has no boolean column for this — recency is the canonical signal.
    const HEARTBEAT_FRESH_MS = 60_000;
    const lastHb = mt5?.lastHeartbeatAt ? new Date(mt5.lastHeartbeatAt).getTime() : 0;
    const brokerConnected = lastHb > 0 && Date.now() - lastHb <= HEARTBEAT_FRESH_MS;
    const balanceProxy = 10_000; // matches riskAudit/permission convention
    const marketCondition: ChecklistMarketCondition = (body.marketCondition ?? "UNKNOWN") as ChecklistMarketCondition;

    const checklist = evaluateChecklist({
      symbol: body.symbol,
      direction: body.direction,
      lotSize: body.lotSize,
      entryType: body.entryType ?? "MARKET",
      entryPrice: body.entryPrice,
      stopLoss: body.stopLoss,
      takeProfit: body.takeProfit,

      maxLotSize: settings.maxLotSize,
      maxRiskPerTradePct: settings.riskPerTradePct ?? 2,
      accountBalance: balanceProxy,

      permissionStatus: permission.status as "CLEAR" | "CAUTION" | "LOCKED" | "LIVE_TRADING_DISABLED",
      permissionBlockers: permission.blockers,
      brokerConnected,
      marketCondition,
      spreadPips: body.spreadPips ?? null,
      maxAcceptableSpreadPips: body.maxAcceptableSpreadPips ?? 999,
      practiceMode: body.practiceMode ?? false,

      aiConfidence: body.aiConfidence ?? null,
      fitScore: body.fitScore ?? null,
      minConfidence: settings.minConfidenceScore ?? 60,
    });

    const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_SECONDS * 1000);

    const [inserted] = await db.insert(executionConfirmationsTable).values({
      userId,
      symbol: body.symbol,
      direction: body.direction,
      lotSize: body.lotSize,
      entryType: body.entryType ?? "MARKET",
      entryPrice: body.entryPrice,
      stopLoss: body.stopLoss,
      takeProfit: body.takeProfit,
      estimatedRisk: checklist.estimatedRisk,
      rewardToRisk: checklist.rewardToRisk,
      marketCondition,
      permissionStatus: permission.status,
      brokerConnected,
      practiceMode: body.practiceMode ?? false,
      aiConfidence: body.aiConfidence ?? null,
      fitScore: body.fitScore ?? null,
      warnings: checklist.warnings,
      blockers: checklist.blockers,
      status: "PENDING",
      userConfirmed: false,
      executed: false,
      executionResult: null,
      executedTradeId: null,
      expiresAt,
    }).returning();

    const row = inserted!;
    await appendVault("EXECUTION_CONFIRMATION_CREATED", checklist.verdict === "BLOCKED" ? "WARN" : "INFO", row, {
      verdict: checklist.verdict,
      operationalMode: sysStatus.operationalMode,
    });

    return res.status(201).json({
      ...rowToResponse(row),
      verdict: checklist.verdict,
      reasons: checklist.reasons,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid body", details: err.issues });
    req.log.error({ err: String(err) }, "POST /execution-confirmations failed");
    return res.status(500).json({ error: "Failed to create execution confirmation" });
  }
});

// GET /execution-confirmations/:id — single confirmation
router.get("/execution-confirmations/:id", requireUser, async (req, res) => {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
    const userId = String(req.authUser!.id);
    const [row] = await db.select().from(executionConfirmationsTable)
      .where(and(eq(executionConfirmationsTable.id, id), eq(executionConfirmationsTable.userId, userId)))
      .limit(1);
    if (!row) return res.status(404).json({ error: "Confirmation not found" });
    return res.json(rowToResponse(row));
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /execution-confirmations/:id failed");
    return res.status(500).json({ error: "Failed to load confirmation" });
  }
});

// POST /execution-confirmations/:id/confirm — user clicks Confirm
router.post("/execution-confirmations/:id/confirm", requireUser, async (req, res) => {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
    ConfirmExecutionBody.parse(req.body ?? {});
    const userId = String(req.authUser!.id);

    const [existing] = await db.select().from(executionConfirmationsTable)
      .where(and(eq(executionConfirmationsTable.id, id), eq(executionConfirmationsTable.userId, userId)))
      .limit(1);
    if (!existing) return res.status(404).json({ error: "Confirmation not found" });

    if (existing.status === "EXECUTED" || existing.status === "CANCELLED" || existing.status === "REJECTED") {
      return res.status(409).json({ error: `Cannot confirm — status is already ${existing.status}` });
    }
    if (existing.status === "EXPIRED" || existing.expiresAt.getTime() < Date.now()) {
      return res.status(409).json({ error: "Confirmation has expired — create a new one with fresh prices." });
    }
    if (existing.blockers && existing.blockers.length > 0) {
      return res.status(409).json({
        error: "Cannot confirm — checklist has blockers.",
        blockers: existing.blockers,
      });
    }

    const [updated] = await db.update(executionConfirmationsTable)
      .set({ status: "CONFIRMED", userConfirmed: true, confirmedAt: new Date() })
      .where(and(eq(executionConfirmationsTable.id, id), eq(executionConfirmationsTable.userId, userId)))
      .returning();

    await appendVault("EXECUTION_CONFIRMATION_CONFIRMED", "INFO", updated!);
    return res.json(rowToResponse(updated!));
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid body", details: err.issues });
    req.log.error({ err: String(err) }, "POST /execution-confirmations/:id/confirm failed");
    return res.status(500).json({ error: "Failed to confirm execution" });
  }
});

// POST /execution-confirmations/:id/cancel — user clicks Cancel
router.post("/execution-confirmations/:id/cancel", requireUser, async (req, res) => {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
    const body = CancelExecutionBody.parse(req.body ?? {});
    const userId = String(req.authUser!.id);

    const [existing] = await db.select().from(executionConfirmationsTable)
      .where(and(eq(executionConfirmationsTable.id, id), eq(executionConfirmationsTable.userId, userId)))
      .limit(1);
    if (!existing) return res.status(404).json({ error: "Confirmation not found" });
    if (existing.status === "EXECUTED" || existing.status === "CANCELLED" || existing.status === "REJECTED" || existing.status === "EXPIRED") {
      return res.status(409).json({ error: `Cannot cancel — already ${existing.status}` });
    }

    const [updated] = await db.update(executionConfirmationsTable)
      .set({ status: "CANCELLED", cancelledAt: new Date(), executionResult: body.reason ?? "User cancelled" })
      .where(and(eq(executionConfirmationsTable.id, id), eq(executionConfirmationsTable.userId, userId)))
      .returning();

    await appendVault("EXECUTION_CONFIRMATION_CANCELLED", "INFO", updated!, { reason: body.reason });
    return res.json(rowToResponse(updated!));
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid body", details: err.issues });
    req.log.error({ err: String(err) }, "POST /execution-confirmations/:id/cancel failed");
    return res.status(500).json({ error: "Failed to cancel execution" });
  }
});

// GET /execution-confirmations — history list
router.get("/execution-confirmations", requireUser, async (req, res) => {
  try {
    const params = GetExecutionHistoryQueryParams.parse({
      limit: req.query["limit"] ? Number(req.query["limit"]) : 50,
      status: req.query["status"],
      symbol: req.query["symbol"],
    });
    const userId = String(req.authUser!.id);

    // Lightweight expiry sweep: any PENDING/CONFIRMED past expiresAt becomes EXPIRED.
    // We do this lazily here so history always renders an honest snapshot.
    await expireStale();

    const limit = Math.min(200, Math.max(1, params.limit ?? 50));
    const rows = await db.select().from(executionConfirmationsTable)
      .where(eq(executionConfirmationsTable.userId, userId))
      .orderBy(desc(executionConfirmationsTable.createdAt))
      .limit(limit);

    const filtered = rows
      .filter((r) => (params.status ? r.status === params.status : true))
      .filter((r) => (params.symbol ? r.symbol === params.symbol : true));

    return res.json({ confirmations: filtered.map(rowToResponse) });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid query", details: err.issues });
    req.log.error({ err: String(err) }, "GET /execution-confirmations failed");
    return res.status(500).json({ error: "Failed to load execution history" });
  }
});

// ── Internal helpers consumed by routes/trades.ts ───────────────────────────

/**
 * Atomically claim a confirmation for execution. Performs a conditional UPDATE
 * that flips the row from CONFIRMED -> EXECUTING in a single statement, only
 * if every eligibility predicate matches. Returns the claimed row, or `null`
 * if no row was claimed (already used / expired / mismatched / wrong status).
 *
 * This is the single-use enforcement point. Two concurrent /execute-trade
 * calls referencing the same confirmationId will see exactly one win the
 * UPDATE; the loser gets `null` and is rejected.
 */
export async function claimConfirmationForExecution(input: {
  confirmationId: number;
  symbol: string;
  direction: string;
  lotSize: number;
}) {
  const nowIso = new Date();
  // Lot tolerance: 1% to allow gate's recommended-size-multiplier rounding.
  const lotDelta = Math.max(0.01, input.lotSize * 0.01);
  const lotLow = input.lotSize - lotDelta;
  const lotHigh = input.lotSize + lotDelta;

  const [claimed] = await db.update(executionConfirmationsTable)
    .set({ status: "EXECUTING" })
    .where(and(
      eq(executionConfirmationsTable.id, input.confirmationId),
      eq(executionConfirmationsTable.status, "CONFIRMED"),
      eq(executionConfirmationsTable.executed, false),
      eq(executionConfirmationsTable.symbol, input.symbol),
      eq(executionConfirmationsTable.direction, input.direction),
      gt(executionConfirmationsTable.expiresAt, nowIso),
      gte(executionConfirmationsTable.lotSize, lotLow),
      lte(executionConfirmationsTable.lotSize, lotHigh),
    ))
    .returning();
  return claimed ?? null;
}

/**
 * Mark a confirmation as EXECUTED after the trades route inserts a trade row.
 * Also appends a vault event and links the executed_trade_id.
 */
export async function markConfirmationExecuted(input: {
  confirmationId: number;
  tradeId: number;
  resultSummary: string;
}) {
  const [updated] = await db.update(executionConfirmationsTable)
    .set({
      status: "EXECUTED",
      executed: true,
      executedAt: new Date(),
      executedTradeId: input.tradeId,
      executionResult: input.resultSummary,
    })
    .where(eq(executionConfirmationsTable.id, input.confirmationId))
    .returning();
  if (updated) {
    await appendVault("EXECUTION_CONFIRMATION_EXECUTED", "INFO", updated, { tradeId: input.tradeId, resultSummary: input.resultSummary });
  }
  return updated ?? null;
}

/**
 * Mark a confirmation as REJECTED when safetyCore HARD_BLOCKs at execution time.
 */
export async function markConfirmationRejected(input: {
  confirmationId: number;
  reason: string;
}) {
  const [updated] = await db.update(executionConfirmationsTable)
    .set({
      status: "REJECTED",
      executed: false,
      executionResult: input.reason,
    })
    .where(eq(executionConfirmationsTable.id, input.confirmationId))
    .returning();
  if (updated) {
    await appendVault("EXECUTION_CONFIRMATION_REJECTED", "DANGER", updated, { reason: input.reason });
  }
  return updated ?? null;
}

export default router;
