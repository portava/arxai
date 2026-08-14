// Build TT — Live Intent Queue API.
//
// SAFETY: This module captures live-style trade intents from the FULL TESTER
// ACCESS tester UI. It NEVER:
//   - calls placeLiveOrderGuarded()
//   - inserts into live_positions
//   - inserts into mt5_commands
//   - flips canPlaceTrades / killSwitch / live mode
//   - claims a real broker order was placed
// Every successful submit returns status=PENDING_MT5_CONNECTION (or
// REJECTED_BY_RISK / TESTER_CAPTURED) and writes to the audit vault.
import { Router } from "express";
import { z } from "zod/v4";
import { db, liveIntentsTable, vaultEventsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { selectBrokerKind } from "../lib/broker/secrets.js";
import { getBrokerProvider } from "../lib/broker/registry.js";
import { randomUUID } from "node:crypto";

const router = Router();

const SubmitBody = z.object({
  source: z.enum(["MANUAL", "AI_ASSIST", "AI_AUTO"]),
  symbol: z.string().min(1).max(32),
  direction: z.enum(["BUY", "SELL"]),
  orderType: z.enum(["MARKET", "LIMIT", "STOP"]).default("MARKET"),
  lotSize: z.number().positive().max(100),
  entryPrice: z.number().positive().nullable().optional(),
  stopLoss: z.number().positive().nullable().optional(),
  takeProfit: z.number().positive().nullable().optional(),
  estimatedRisk: z.number().nonnegative().nullable().optional(),
  maxLossUsd: z.number().nonnegative().nullable().optional(),
  maxLossPercent: z.number().nonnegative().nullable().optional(),
  confidenceScore: z.number().int().min(0).max(100).nullable().optional(),
  riskScore: z.number().int().min(0).max(100).nullable().optional(),
  riskRewardRatio: z.number().nonnegative().nullable().optional(),
  reasonForTrade: z.string().max(2000).optional(),
  invalidationReason: z.string().max(2000).optional(),
  marketCondition: z.string().max(500).optional(),
  note: z.string().max(2000).optional(),
});

// Conservative tester caps — match the spec's AI auto-tester defaults.
const TESTER_CAPS = {
  maxLotSize: 0.01,
  maxLossUsdPerTrade: 5,
  requiresStopLoss: true,
};

async function isMt5Connected(): Promise<boolean> {
  if (selectBrokerKind() !== "mt5") return false;
  try {
    const provider = getBrokerProvider();
    const status = await provider.status();
    return !!status.connected;
  } catch { return false; }
}

router.post("/live-intent/submit", async (req, res) => {
  try {
    const body = SubmitBody.parse(req.body);

    const intentId = `intent_${randomUUID()}`;
    const mt5Connected = await isMt5Connected();

    // Run risk-governor style checks at the API layer. These are tester-side
    // checks; even if they pass we still never place a real order here.
    const failedChecks: string[] = [];
    if (body.lotSize > TESTER_CAPS.maxLotSize) {
      failedChecks.push(`lotSize ${body.lotSize} exceeds tester cap ${TESTER_CAPS.maxLotSize}`);
    }
    if (TESTER_CAPS.requiresStopLoss && !body.stopLoss) {
      failedChecks.push("stopLoss is required for live-intent capture");
    }
    if (typeof body.maxLossUsd === "number" && body.maxLossUsd > TESTER_CAPS.maxLossUsdPerTrade) {
      failedChecks.push(`maxLossUsd ${body.maxLossUsd} exceeds tester cap ${TESTER_CAPS.maxLossUsdPerTrade}`);
    }

    const riskCheckPassed = failedChecks.length === 0;
    const status = !riskCheckPassed
      ? "REJECTED_BY_RISK"
      : mt5Connected
        ? "READY_FOR_BROKER_WHEN_CONNECTED"
        : "PENDING_MT5_CONNECTION";

    // Write audit vault entry (severity WARN on tester live-intent capture so
    // it shows up clearly in the safety log feed).
    const [vault] = await db.insert(vaultEventsTable).values({
      kind: "TESTER_LIVE_INTENT",
      severity: riskCheckPassed ? "WARN" : "ERROR",
      source: `LIVE_INTENT_${body.source}`,
      truthDomain: "SAFETY",
      summary: `Live tester intent ${body.direction} ${body.lotSize} ${body.symbol} (source=${body.source}) → ${status}`,
      payload: {
        intentId, source: body.source, symbol: body.symbol, direction: body.direction,
        lotSize: body.lotSize, stopLoss: body.stopLoss ?? null, takeProfit: body.takeProfit ?? null,
        confidenceScore: body.confidenceScore ?? null, riskScore: body.riskScore ?? null,
        mt5Connected, status, failedChecks,
        // Inviolable: never claim broker execution.
        brokerOrderPlaced: false,
        livePositionsTouched: false,
        mt5CommandsTouched: false,
      },
      reasons: failedChecks.length ? failedChecks : ["Tester live-intent captured — no broker order placed."],
      blockers: mt5Connected ? [] : ["MT5 bridge not connected"],
      generatedAtIso: new Date().toISOString(),
    }).returning();

    const [inserted] = await db.insert(liveIntentsTable).values({
      intentId,
      source: body.source,
      symbol: body.symbol,
      direction: body.direction,
      orderType: body.orderType,
      lotSize: body.lotSize,
      entryPrice: body.entryPrice ?? null,
      stopLoss: body.stopLoss ?? null,
      takeProfit: body.takeProfit ?? null,
      estimatedRisk: body.estimatedRisk ?? null,
      maxLossUsd: body.maxLossUsd ?? null,
      maxLossPercent: body.maxLossPercent ?? null,
      confidenceScore: body.confidenceScore ?? null,
      riskScore: body.riskScore ?? null,
      riskRewardRatio: body.riskRewardRatio ?? null,
      reasonForTrade: body.reasonForTrade ?? null,
      invalidationReason: body.invalidationReason ?? null,
      marketCondition: body.marketCondition ?? null,
      note: body.note ?? null,
      status,
      rejectionReason: failedChecks[0] ?? null,
      riskCheckPassed,
      riskCheckDetails: { failedChecks, caps: TESTER_CAPS },
      mt5ConnectedAtSubmit: mt5Connected,
      brokerExecuted: false,
      auditEventId: vault?.id ?? null,
    }).returning();

    // Per spec: `accepted` reflects broker-acceptance, not risk-acceptance.
    // We never place a real broker order here, so `accepted` is always false
    // until the placement layer + MT5 are wired. Risk-check outcome is exposed
    // separately as `riskCheckPassed`.
    return res.json({
      accepted: false,
      riskCheckPassed,
      testerAccess: true,
      brokerExecution: false,
      status,
      intentId,
      mt5Connected,
      reason: !riskCheckPassed
        ? `Risk check failed: ${failedChecks.join("; ")}`
        : "MT5 bridge is not connected yet. Tester workflow was captured, but no real broker order was placed.",
      intent: inserted,
      auditEventId: vault?.id ?? null,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid body", details: err.issues });
    req.log.error({ err: String(err) }, "POST /live-intent/submit failed");
    return res.status(500).json({ error: "Failed to capture live intent" });
  }
});

router.get("/live-intent/queue", async (req, res) => {
  try {
    // T006 — per-user mode scoping. The legacy live_intents table has NO
    // userId column (rows are global tester-captured intents from the
    // pre-Build-TT era). Returning them to normal users would be a
    // cross-user leak, so:
    //   * Real admins (effective role ADMIN/OWNER) still get the full
    //     queue for diagnostic / operator review.
    //   * Admin-preview-as-user sessions and normal users get an empty
    //     queue with a clean note. They never see another user's intent.
    // Admin-preview is the same downgrade pattern used in
    // meUnifiedMode.ts: `req.authUser.role` is "USER" when previewing,
    // `realRole` retains the admin level.
    const role = String(
      (req as unknown as { authUser?: { role?: string } }).authUser?.role ?? "",
    ).toUpperCase();
    const isAdmin = role === "ADMIN" || role === "OWNER";

    const empty = {
      intents: [],
      counts: { total: 0, pendingMt5: 0, ready: 0, rejected: 0, executedLater: 0 },
      modeScopeApplied: true,
      scopeNote: "Live Intent Queue is admin-only operator data.",
    };
    if (!isAdmin) {
      return res.json(empty);
    }

    const limit = Math.min(500, Math.max(1, Number(req.query["limit"]) || 100));
    const rows = await db.select().from(liveIntentsTable)
      .orderBy(desc(liveIntentsTable.createdAt))
      .limit(limit);
    const counts = {
      total: rows.length,
      pendingMt5: rows.filter(r => r.status === "PENDING_MT5_CONNECTION").length,
      ready: rows.filter(r => r.status === "READY_FOR_BROKER_WHEN_CONNECTED").length,
      rejected: rows.filter(r => r.status === "REJECTED_BY_RISK").length,
      executedLater: rows.filter(r => r.status === "EXECUTED_LATER").length,
    };
    return res.json({ intents: rows, counts, modeScopeApplied: true, adminScope: true });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /live-intent/queue failed");
    return res.status(500).json({ error: "Failed to load live intent queue" });
  }
});

router.get("/live-intent/:id", async (req, res) => {
  try {
    // T006 — admin-only. Same reasoning as /live-intent/queue: the
    // legacy live_intents table has no userId column so any direct
    // ID lookup is a cross-user read. Restrict to real admins.
    const role = String(
      (req as unknown as { authUser?: { role?: string } }).authUser?.role ?? "",
    ).toUpperCase();
    const isAdmin = role === "ADMIN" || role === "OWNER";
    if (!isAdmin) {
      return res.status(404).json({ error: "Live intent not found" });
    }
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
    const [row] = await db.select().from(liveIntentsTable).where(eq(liveIntentsTable.id, id)).limit(1);
    if (!row) return res.status(404).json({ error: "Live intent not found" });
    return res.json({ ...row, adminScope: true });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /live-intent/:id failed");
    return res.status(500).json({ error: "Failed to load live intent" });
  }
});

export default router;
