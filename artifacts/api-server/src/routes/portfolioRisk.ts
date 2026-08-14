// (O) Build O — Portfolio & Exposure Risk Engine routes.
//
// Composes:
//   - live_positions    (current open positions, lot sizes, unrealized P&L)
//   - mt5_connection    (account balance / equity / margin)
//   - risk_settings     (per-trade, max-open, daily-loss caps)
//   - trades            (per-position riskAmount lookup)
//   - alertManager      (CRITICAL alert when portfolio is CRITICAL)
//   - vaultEvents       (BEHAVIOR audit on every snapshot/report)
//   - @workspace/domain/portfolio-risk (pure rules engine)
//
// Routes:
//   POST /portfolio-risk/snapshot           — generate + persist snapshot
//   GET  /portfolio-risk/latest             — most recent snapshot
//   GET  /portfolio-risk/history?limit=N    — recent snapshots (history)
//   POST /correlation-risk/generate         — generate + persist per-group reports
//   GET  /correlation-risk/latest           — most recent report set (one per group)
//
// SAFETY: never closes positions. Never writes to safetyCore. Trade-plan
// validate consumes the latest snapshot and blocks ONLY when CRITICAL.

import { Router } from "express";
import {
  db,
  livePositionsTable, riskSettingsTable, mt5ConnectionTable,
  portfolioRiskSnapshotsTable, correlationRiskReportsTable, vaultEventsTable,
} from "@workspace/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import crypto from "node:crypto";

// (O-fix) Stable rank for sorting correlation reports CRITICAL → LOW at the
// API boundary so consumers don't depend on insert order.
const LEVEL_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MODERATE: 2, LOW: 3 };
const sortByLevel = <T extends { riskLevel: string; totalExposure: number }>(rows: T[]) =>
  [...rows].sort((a, b) => (LEVEL_RANK[a.riskLevel] ?? 9) - (LEVEL_RANK[b.riskLevel] ?? 9) || b.totalExposure - a.totalExposure);
import {
  computePortfolioRisk, buildCorrelationReports,
  type OpenPositionInput,
} from "@workspace/domain/portfolio-risk";
import { createAlert } from "../lib/alerts/alertManager.js";
import { z } from "zod/v4";

const router = Router();

async function vaultBehavior(kind: string, payload: Record<string, unknown>) {
  await db.insert(vaultEventsTable).values({
    kind, severity: "INFO", source: "SYSTEM", truthDomain: "BEHAVIOR",
    summary: kind, payload, reasons: [], blockers: [],
    generatedAtIso: new Date().toISOString(),
  }).catch(() => { /* non-fatal */ });
}

const POSITION_TERMINAL = new Set(["CLOSED", "CANCELED", "REJECTED"]);

async function loadInputs() {
  const [positions, settingsRows, mt5Rows] = await Promise.all([
    db.select().from(livePositionsTable),
    db.select().from(riskSettingsTable).limit(1),
    db.select().from(mt5ConnectionTable).orderBy(desc(mt5ConnectionTable.updatedAt)).limit(1),
  ]);

  // (O) Per-position risk approximation. The trades schema doesn't carry an
  // absolute riskAmount, so we derive a proxy from SL distance × lot size:
  //   riskUnits ≈ |entryPrice - stopLoss| × lotSize × 100
  // This is broker/contract-agnostic — it's a relative concentration measure,
  // not a precise per-instrument currency value. When SL is missing, risk
  // contribution is treated as 0 here AND surfaced as a separate warning by
  // upstream "missing SL" alerts (Build H position monitor).
  const open = positions.filter((p) => !POSITION_TERMINAL.has(p.status));
  const positionsInput: OpenPositionInput[] = open.map((p) => {
    const slDistance = (typeof p.stopLoss === "number") ? Math.abs(p.entryPrice - p.stopLoss) : 0;
    const riskAmount = slDistance > 0 ? slDistance * Math.abs(p.lotSize) * 100 : 0;
    return {
      symbol: p.symbol,
      direction: (p.direction === "SELL" ? "SELL" : "BUY"),
      lotSize: p.lotSize,
      unrealizedPnl: p.unrealizedProfitLoss ?? 0,
      riskAmount,
    };
  });

  const settings = settingsRows[0];
  const mt5 = mt5Rows[0];
  return {
    positionsInput,
    accountBalance: mt5?.accountBalance ?? 0,
    accountEquity:  mt5?.accountEquity  ?? 0,
    maxOpenTrades:    settings?.maxOpenTrades    ?? 2,
    maxDailyLossPct:  settings?.maxDailyLossPct  ?? 2,
    riskPerTradePct:  settings?.riskPerTradePct  ?? 0.5,
  };
}

// ── POST /portfolio-risk/snapshot ─────────────────────────────────────────
// Portfolio QA P1: snapshots are now persisted with userId so latest/history
// reads can scope per-tenant. loadInputs() still pulls global account/risk
// settings (out of scope for this QA fix — flagged as remaining blocker).
router.post("/portfolio-risk/snapshot", requireUser, async (req, res): Promise<void> => {
  try {
    const inputs = await loadInputs();
    const result = computePortfolioRisk({
      accountBalance: inputs.accountBalance,
      accountEquity: inputs.accountEquity,
      positions: inputs.positionsInput,
      maxOpenTrades: inputs.maxOpenTrades,
      maxDailyLossPct: inputs.maxDailyLossPct,
      riskPerTradePct: inputs.riskPerTradePct,
    });

    const inserted = await db.insert(portfolioRiskSnapshotsTable).values({
      userId: req.authUser!.id,
      accountBalance: result.accountBalance,
      accountEquity: result.accountEquity,
      openPositionsCount: result.openPositionsCount,
      totalOpenLotSize: result.totalOpenLotSize,
      totalUnrealizedPnl: result.totalUnrealizedPnl,
      totalRiskAmount: result.totalRiskAmount,
      totalRiskPercent: result.totalRiskPercent,
      correlatedExposureScore: result.correlatedExposureScore,
      portfolioRiskLevel: result.portfolioRiskLevel,
      reasons: result.reasons,
      warnings: result.warnings,
      blockers: result.blockers,
      inputsSnapshot: { positions: inputs.positionsInput, settings: { maxOpenTrades: inputs.maxOpenTrades, maxDailyLossPct: inputs.maxDailyLossPct, riskPerTradePct: inputs.riskPerTradePct } },
    }).returning();

    if (result.portfolioRiskLevel === "CRITICAL" || result.portfolioRiskLevel === "HIGH") {
      const priority = result.portfolioRiskLevel === "CRITICAL" ? "CRITICAL" : "HIGH";
      const severity = result.portfolioRiskLevel === "CRITICAL" ? "danger" : "warning";
      void createAlert({
        type: "RISK_LIMIT_HIT", priority, severity,
        title: `Portfolio risk: ${result.portfolioRiskLevel}`,
        message: result.aiSummary,
        actionRequired: result.portfolioRiskLevel === "CRITICAL",
        dedupeKey: `portfolio-risk:${result.portfolioRiskLevel}:${result.openPositionsCount}:${Math.round(result.totalRiskPercent * 10)}`,
      });
    }

    await vaultBehavior("PORTFOLIO_RISK_SNAPSHOT_GENERATED", {
      id: inserted[0]!.id, level: result.portfolioRiskLevel,
      openPositionsCount: result.openPositionsCount,
      totalRiskPercent: result.totalRiskPercent,
      blocked: result.blockers.length > 0,
    });

    res.json({
      ...inserted[0]!,
      createdAt: inserted[0]!.createdAt.toISOString(),
      aiSummary: result.aiSummary,
      correlationReports: result.correlationReports,
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "POST /portfolio-risk/snapshot failed");
    res.status(500).json({ error: "Failed to generate portfolio risk snapshot" });
  }
});

// ── GET /portfolio-risk/latest ────────────────────────────────────────────
router.get("/portfolio-risk/latest", requireUser, async (req, res): Promise<void> => {
  try {
    const rows = await db.select().from(portfolioRiskSnapshotsTable)
      .where(eq(portfolioRiskSnapshotsTable.userId, req.authUser!.id))
      .orderBy(desc(portfolioRiskSnapshotsTable.createdAt)).limit(1);
    if (!rows[0]) { res.status(404).json({ error: "No snapshot yet" }); return; }
    res.json({ ...rows[0], createdAt: rows[0].createdAt.toISOString() });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /portfolio-risk/latest failed");
    res.status(500).json({ error: "Failed to load latest snapshot" });
  }
});

// ── GET /portfolio-risk/history?limit= ────────────────────────────────────
router.get("/portfolio-risk/history", requireUser, async (req, res): Promise<void> => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query["limit"]) || 50));
    const rows = await db.select().from(portfolioRiskSnapshotsTable)
      .where(eq(portfolioRiskSnapshotsTable.userId, req.authUser!.id))
      .orderBy(desc(portfolioRiskSnapshotsTable.createdAt)).limit(limit);
    res.json({ snapshots: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /portfolio-risk/history failed");
    res.status(500).json({ error: "Failed to load history" });
  }
});

// ── POST /correlation-risk/generate ───────────────────────────────────────
router.post("/correlation-risk/generate", requireUser, async (req, res): Promise<void> => {
  try {
    const inputs = await loadInputs();
    const reports = buildCorrelationReports(inputs.positionsInput);
    const batchId = crypto.randomUUID();
    const inserted = [];
    for (const r of reports) {
      const row = await db.insert(correlationRiskReportsTable).values({
        userId: req.authUser!.id,
        batchId,
        symbolGroup: r.symbolGroup,
        positionsInGroup: r.positionsInGroup,
        symbols: r.symbols,
        totalExposure: r.totalExposure,
        directionBias: r.directionBias,
        correlationWarning: r.correlationWarning,
        riskLevel: r.riskLevel,
        aiSummary: r.aiSummary,
      }).returning();
      inserted.push({ ...row[0]!, createdAt: row[0]!.createdAt.toISOString() });
    }
    await vaultBehavior("CORRELATION_RISK_REPORTS_GENERATED", {
      batchId, groupCount: reports.length,
      criticalCount: reports.filter((r) => r.riskLevel === "CRITICAL").length,
    });
    // (O-fix) Always return CRITICAL → LOW order so the UI doesn't depend on
    // insert sequence.
    res.json({ batchId, reports: sortByLevel(inserted) });
  } catch (err) {
    req.log.error({ err: String(err) }, "POST /correlation-risk/generate failed");
    res.status(500).json({ error: "Failed to generate correlation reports" });
  }
});

// ── GET /correlation-risk/latest — exactly one latest batch ───────────────
router.get("/correlation-risk/latest", requireUser, async (req, res): Promise<void> => {
  try {
    // (O-fix) Look up the batch_id of the single most recent insert and
    // return only the rows in that batch, sorted CRITICAL → LOW.
    // Portfolio QA P1: scope by userId so users only see their own batch.
    const head = await db.select({ batchId: correlationRiskReportsTable.batchId })
      .from(correlationRiskReportsTable)
      .where(eq(correlationRiskReportsTable.userId, req.authUser!.id))
      .orderBy(desc(correlationRiskReportsTable.createdAt))
      .limit(1);
    if (!head[0]) { res.json({ batchId: null, reports: [] }); return; }
    const batchId = head[0].batchId;
    const rows = await db.select().from(correlationRiskReportsTable)
      .where(and(
        eq(correlationRiskReportsTable.batchId, batchId),
        eq(correlationRiskReportsTable.userId, req.authUser!.id),
      ));
    const serialized = rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
    res.json({ batchId, reports: sortByLevel(serialized) });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /correlation-risk/latest failed");
    res.status(500).json({ error: "Failed to load correlation reports" });
  }
});

// ── helper for trade-plan validate hook ───────────────────────────────────
export async function getLatestPortfolioRiskOrCompute() {
  const inputs = await loadInputs();
  const result = computePortfolioRisk({
    accountBalance: inputs.accountBalance,
    accountEquity: inputs.accountEquity,
    positions: inputs.positionsInput,
    maxOpenTrades: inputs.maxOpenTrades,
    maxDailyLossPct: inputs.maxDailyLossPct,
    riskPerTradePct: inputs.riskPerTradePct,
  });
  return result;
}

void and; void eq; void sql; // future use
export default router;
