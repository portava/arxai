import { Router } from "express";
import { db } from "@workspace/db";
import { riskSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { GetRiskSettingsResponse, UpdateRiskSettingsBody } from "@workspace/api-zod";
import { z } from "zod/v4";
import { computeRiskAudit } from "../lib/riskAudit.js";
import { calculatePositionSize } from "../lib/positionSizing.js";
import {
  evaluateDrawdownGuard, evaluateExposureGuard, evaluateMaxLossGuard,
  evaluateHardBlockRules,
} from "@workspace/domain/risk-governor";
import { shadowCapture } from "../lib/auditVault.js";
import { and } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";

const router = Router();

// ── Risk mode presets ──────────────────────────────────────────────────────

const RISK_PRESETS = {
  Conservative: {
    riskMode: "Conservative",
    riskPerTradePct: 0.25,
    maxDailyLossPct: 1,
    maxWeeklyLossPct: 3,
    maxTradesPerDay: 3,
    stopAfterLosingStreak: 2,
    minConfidenceScore: 80,
    maxOpenTrades: 1,
    cooldownAfterLossMinutes: 60,
    maxLotSize: 0.05,
  },
  Balanced: {
    riskMode: "Balanced",
    riskPerTradePct: 0.5,
    maxDailyLossPct: 2,
    maxWeeklyLossPct: 5,
    maxTradesPerDay: 5,
    stopAfterLosingStreak: 3,
    minConfidenceScore: 75,
    maxOpenTrades: 2,
    cooldownAfterLossMinutes: 30,
    maxLotSize: 0.1,
  },
  Aggressive: {
    riskMode: "Aggressive",
    riskPerTradePct: 1,
    maxDailyLossPct: 3,
    maxWeeklyLossPct: 7,
    maxTradesPerDay: 8,
    stopAfterLosingStreak: 3,
    minConfidenceScore: 70,
    maxOpenTrades: 3,
    cooldownAfterLossMinutes: 15,
    maxLotSize: 0.2,
  },
} as const;

// ── Helper ─────────────────────────────────────────────────────────────────

// Phase-2: every risk settings row is per-user. New users get a Balanced default.
async function getOrCreateRiskSettings(userId: number) {
  const rows = await db.select().from(riskSettingsTable)
    .where(eq(riskSettingsTable.userId, userId)).limit(1);
  if (rows[0]) return rows[0];
  const inserted = await db.insert(riskSettingsTable).values({ userId }).returning();
  return inserted[0];
}

// ── GET /risk/settings ─────────────────────────────────────────────────────

router.get("/risk/settings", requireUser, async (req, res) => {
  try {
    const settings = await getOrCreateRiskSettings(req.authUser!.id);
    const data = GetRiskSettingsResponse.parse(settings);
    return res.json(data);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to get risk settings" });
  }
});

// ── PATCH /risk/settings ───────────────────────────────────────────────────

router.patch("/risk/settings", requireUser, async (req, res) => {
  try {
    const body = UpdateRiskSettingsBody.parse(req.body);
    const settings = await getOrCreateRiskSettings(req.authUser!.id);
    const updated = await db
      .update(riskSettingsTable)
      .set({ ...body, riskMode: "Custom", updatedAt: new Date() })
      .where(and(eq(riskSettingsTable.id, settings.id), eq(riskSettingsTable.userId, req.authUser!.id)))
      .returning();
    const data = GetRiskSettingsResponse.parse(updated[0]);
    return res.json(data);
  } catch (err) {
    req.log.error(err);
    return res.status(400).json({ error: "Invalid risk settings" });
  }
});

// ── POST /risk/mode ────────────────────────────────────────────────────────

const RiskModeBody = z.object({
  mode: z.enum(["Conservative", "Balanced", "Aggressive"]),
});

router.post("/risk/mode", requireUser, async (req, res) => {
  try {
    const { mode } = RiskModeBody.parse(req.body);
    const preset = RISK_PRESETS[mode];
    const settings = await getOrCreateRiskSettings(req.authUser!.id);
    const updated = await db
      .update(riskSettingsTable)
      .set({ ...preset, updatedAt: new Date() })
      .where(and(eq(riskSettingsTable.id, settings.id), eq(riskSettingsTable.userId, req.authUser!.id)))
      .returning();
    const data = GetRiskSettingsResponse.parse(updated[0]);
    return res.json(data);
  } catch (err) {
    req.log.error(err);
    return res.status(400).json({ error: "Failed to apply risk mode preset" });
  }
});

// ── POST /risk/lock-live ───────────────────────────────────────────────────

const RiskLockBody = z.object({ locked: z.boolean() });

router.post("/risk/lock-live", requireUser, async (req, res) => {
  try {
    const { locked } = RiskLockBody.parse(req.body);
    const settings = await getOrCreateRiskSettings(req.authUser!.id);
    await db
      .update(riskSettingsTable)
      .set({ liveLocked: locked, updatedAt: new Date() })
      .where(and(eq(riskSettingsTable.id, settings.id), eq(riskSettingsTable.userId, req.authUser!.id)));
    return res.json({
      locked,
      message: locked
        ? "Live trading locked. Manual unlock required before going live."
        : "Live trading lock removed.",
    });
  } catch (err) {
    req.log.error(err);
    return res.status(400).json({ error: "Failed to update live lock" });
  }
});

// ── GET /risk/audit ────────────────────────────────────────────────────────

const RiskAuditQuery = z.object({
  symbol:      z.string().optional(),
  confidence:  z.coerce.number().optional(),
  riskReward:  z.coerce.number().optional(),
});

router.get("/risk/audit", requireUser, async (req, res) => {
  try {
    const query = RiskAuditQuery.parse(req.query);
    const settings = await getOrCreateRiskSettings(req.authUser!.id);
    // Use a placeholder account balance (1000 USD) — in production this comes from MT5 sync
    const accountBalance = 1000;
    const audit = await computeRiskAudit(accountBalance, {
      riskPerTradePct:       settings.riskPerTradePct,
      maxDailyLossPct:       settings.maxDailyLossPct,
      maxWeeklyLossPct:      settings.maxWeeklyLossPct,
      maxTradesPerDay:       settings.maxTradesPerDay,
      maxOpenTrades:         settings.maxOpenTrades,
      stopAfterLosingStreak: settings.stopAfterLosingStreak,
      minConfidenceScore:    settings.minConfidenceScore,
      symbol:      query.symbol,
      confidence:  query.confidence,
      riskReward:  query.riskReward,
      us30BlockNews:       settings.us30BlockNews,
      stocksBlockEarnings: settings.stocksBlockEarnings,
      forexBlockEvents:    settings.forexBlockEvents,
      vol75ExtraConfidence: settings.vol75ExtraConfidence,
    });
    return res.json(audit);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to compute risk audit" });
  }
});

// ── GET /risk/position-size ────────────────────────────────────────────────

const PositionSizeQuery = z.object({
  symbol:         z.string(),
  accountBalance: z.coerce.number(),
  riskPercent:    z.coerce.number(),
  entry:          z.coerce.number(),
  stopLoss:       z.coerce.number(),
});

router.get("/risk/position-size", requireUser, async (req, res) => {
  try {
    const query = PositionSizeQuery.parse(req.query);
    const settings = await getOrCreateRiskSettings(req.authUser!.id);
    const result = calculatePositionSize({
      ...query,
      maxLotSize: settings.maxLotSize,
    });
    return res.json(result);
  } catch (err) {
    req.log.error(err);
    return res.status(400).json({ error: "Failed to calculate position size" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1 — Risk Governor sub-guards (advisory).
//
// These endpoints run the new pure sub-engines and emit FS_GUARD_* vault
// events. They are advisory: every response carries canPlaceTrades:false and
// the existing master /risk/audit + Control Tower retain final authority.
// ═══════════════════════════════════════════════════════════════════════════

const ADVISORY_MODE = "RISK_GUARD_PIPELINE";

function envelope<T>(payload: T) {
  return { canPlaceTrades: false, mode: ADVISORY_MODE, generatedAtIso: new Date().toISOString(), result: payload };
}

async function logGuardEvent(eventType: string, severity: "INFO" | "WARN" | "DANGER", payload: unknown) {
  await shadowCapture({
    source: "risk-governor",
    eventType: eventType as never,
    severity,
    systemMode: null, globalState: null,
    payload: payload as Record<string, unknown>,
  });
}

router.post("/risk/guards/drawdown", async (req, res) => {
  try {
    const v = evaluateDrawdownGuard(req.body);
    await logGuardEvent("FS_GUARD_DRAWDOWN", v.passed ? "INFO" : "WARN", v);
    return res.json(envelope(v));
  } catch (err) {
    req.log.error(err);
    return res.status(400).json({ error: "Invalid drawdown guard input" });
  }
});

router.post("/risk/guards/exposure", async (req, res) => {
  try {
    const v = evaluateExposureGuard(req.body);
    await logGuardEvent("FS_GUARD_EXPOSURE", v.passed ? "INFO" : "WARN", v);
    return res.json(envelope(v));
  } catch (err) {
    req.log.error(err);
    return res.status(400).json({ error: "Invalid exposure guard input" });
  }
});

router.post("/risk/guards/max-loss", async (req, res) => {
  try {
    const v = evaluateMaxLossGuard(req.body);
    await logGuardEvent("FS_GUARD_MAX_LOSS", v.passed ? "INFO" : "WARN", v);
    return res.json(envelope(v));
  } catch (err) {
    req.log.error(err);
    return res.status(400).json({ error: "Invalid max-loss guard input" });
  }
});

router.post("/risk/guards/hard-block", async (req, res) => {
  try {
    const v = evaluateHardBlockRules(req.body);
    await logGuardEvent(
      "FS_GUARD_HARD_BLOCK",
      v.passed ? "INFO" : v.blockingKinds.length > 1 ? "DANGER" : "WARN",
      { passed: v.passed, blockingKinds: v.blockingKinds, dataMissing: v.dataMissing },
    );
    return res.json(envelope(v));
  } catch (err) {
    req.log.error(err);
    return res.status(400).json({ error: "Invalid hard-block input" });
  }
});

export default router;
