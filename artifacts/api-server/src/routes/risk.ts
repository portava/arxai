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
import { shadowCapture, shadowCaptureFAF } from "../lib/auditVault.js";
import { and, desc } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { riskPendingIncreasesTable } from "@workspace/db";
import {
  planRiskSettingsUpdate,
  canConfirmPendingIncrease,
  RISK_CEILING_FIELDS,
  RISK_INCREASE_DELAY_MS,
} from "../lib/riskVault/delayedIncrease.js";

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

// ── PATCH /risk/settings — capability #42: tighten instantly, loosen delayed ─
//
// The asymmetry: any change classified TIGHTEN (less risk) is written
// immediately; any LOOSEN (more risk) is queued as a PENDING increase behind a
// mandatory waiting period and must be explicitly re-confirmed via
// POST /risk/pending-increases/:id/confirm AFTER the period ends. If the
// pending store cannot be written, the loosenings simply do not happen (fail
// closed on the risky direction) and the response says so — tightenings are
// never held hostage by that failure.

async function queuePendingIncreases(
  userId: number,
  queue: ReturnType<typeof planRiskSettingsUpdate>["queue"],
): Promise<{ queued: Array<Record<string, unknown>>; queueFailure: string | null }> {
  const queued: Array<Record<string, unknown>> = [];
  let queueFailure: string | null = null;
  for (const q of queue) {
    try {
      // A newer request for the same field supersedes any older pending one —
      // exactly one live pending increase per field, always the latest press.
      await db
        .update(riskPendingIncreasesTable)
        .set({ status: "SUPERSEDED" })
        .where(and(
          eq(riskPendingIncreasesTable.userId, userId),
          eq(riskPendingIncreasesTable.field, q.field),
          eq(riskPendingIncreasesTable.status, "PENDING"),
        ));
      const inserted = await db.insert(riskPendingIncreasesTable).values({
        userId,
        field: q.field,
        valueKind: q.valueKind,
        currentValue: q.currentValue,
        targetValue: q.targetValue,
        direction: "LOOSEN",
        status: "PENDING",
        effectiveAt: q.effectiveAt,
      }).returning();
      const row = inserted[0]!;
      queued.push({
        id: row.id,
        field: row.field,
        currentValue: row.currentValue,
        targetValue: row.targetValue,
        effectiveAt: row.effectiveAt.toISOString(),
        status: row.status,
      });
      shadowCaptureFAF({
        eventType: "RISK_INCREASE_QUEUED",
        source: "risk-vault",
        severity: "WARN",
        systemMode: null,
        globalState: null,
        payload: { userId, field: q.field, currentValue: q.currentValue, targetValue: q.targetValue, effectiveAt: q.effectiveAt.toISOString() },
      });
    } catch {
      queueFailure =
        "RISK_PENDING_STORE_UNAVAILABLE: the requested increase(s) were NOT queued and will NOT apply — increases fail closed. Reductions in this request were applied.";
      break;
    }
  }
  return { queued, queueFailure };
}

router.patch("/risk/settings", requireUser, async (req, res) => {
  try {
    const body = UpdateRiskSettingsBody.parse(req.body);
    const settings = await getOrCreateRiskSettings(req.authUser!.id);
    const now = new Date();
    const plan = planRiskSettingsUpdate({
      current: settings as unknown as Record<string, unknown>,
      requested: body as Record<string, unknown>,
      now,
    });
    const updated = await db
      .update(riskSettingsTable)
      .set({ ...plan.applyNow, riskMode: "Custom", updatedAt: now })
      .where(and(eq(riskSettingsTable.id, settings.id), eq(riskSettingsTable.userId, req.authUser!.id)))
      .returning();
    const { queued, queueFailure } = await queuePendingIncreases(req.authUser!.id, plan.queue);
    const data = GetRiskSettingsResponse.parse(updated[0]);
    return res.json({
      ...data,
      appliedNow: Object.keys(plan.applyNow),
      pendingIncreases: queued,
      classifications: plan.classifications,
      increaseDelayMs: RISK_INCREASE_DELAY_MS,
      queueFailure,
    });
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
    const now = new Date();
    // Capability #42 — presets obey the same asymmetry: the preset's
    // tightening fields apply now; its loosening fields are queued behind the
    // waiting period. The riskMode label is only stamped with the preset name
    // when nothing was held back, so the label never claims a looser posture
    // than what is actually in force.
    const { riskMode: presetName, ...presetFields } = preset;
    const plan = planRiskSettingsUpdate({
      current: settings as unknown as Record<string, unknown>,
      requested: presetFields as unknown as Record<string, unknown>,
      now,
    });
    const fullyApplied = plan.queue.length === 0;
    const updated = await db
      .update(riskSettingsTable)
      .set({ ...plan.applyNow, riskMode: fullyApplied ? presetName : "Custom", updatedAt: now })
      .where(and(eq(riskSettingsTable.id, settings.id), eq(riskSettingsTable.userId, req.authUser!.id)))
      .returning();
    const { queued, queueFailure } = await queuePendingIncreases(req.authUser!.id, plan.queue);
    const data = GetRiskSettingsResponse.parse(updated[0]);
    return res.json({
      ...data,
      requestedMode: presetName,
      appliedNow: Object.keys(plan.applyNow),
      pendingIncreases: queued,
      increaseDelayMs: RISK_INCREASE_DELAY_MS,
      queueFailure,
    });
  } catch (err) {
    req.log.error(err);
    return res.status(400).json({ error: "Failed to apply risk mode preset" });
  }
});

// ── Capability #42 — pending-increase lifecycle ────────────────────────────

router.get("/risk/pending-increases", requireUser, async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(riskPendingIncreasesTable)
      .where(eq(riskPendingIncreasesTable.userId, req.authUser!.id))
      .orderBy(desc(riskPendingIncreasesTable.requestedAt))
      .limit(50);
    const now = Date.now();
    return res.json({
      pendingIncreases: rows.map((r) => ({
        id: r.id,
        field: r.field,
        valueKind: r.valueKind,
        currentValue: r.currentValue,
        targetValue: r.targetValue,
        status: r.status,
        requestedAt: r.requestedAt.toISOString(),
        effectiveAt: r.effectiveAt.toISOString(),
        confirmedAt: r.confirmedAt?.toISOString() ?? null,
        cancelledAt: r.cancelledAt?.toISOString() ?? null,
        confirmableNow: r.status === "PENDING" && r.effectiveAt.getTime() <= now,
        remainingMs: r.status === "PENDING" ? Math.max(0, r.effectiveAt.getTime() - now) : 0,
      })),
      increaseDelayMs: RISK_INCREASE_DELAY_MS,
    });
  } catch (err) {
    req.log.error(err);
    return res.status(503).json({ error: "RISK_PENDING_STORE_UNAVAILABLE" });
  }
});

const PendingIdParam = z.coerce.number().int().positive();

router.post("/risk/pending-increases/:id/confirm", requireUser, async (req, res) => {
  const idParse = PendingIdParam.safeParse(req.params.id);
  if (!idParse.success) return res.status(400).json({ error: "INVALID_ID" });
  try {
    const userId = req.authUser!.id;
    const rows = await db
      .select()
      .from(riskPendingIncreasesTable)
      .where(and(eq(riskPendingIncreasesTable.id, idParse.data), eq(riskPendingIncreasesTable.userId, userId)))
      .limit(1);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "NOT_FOUND" });

    const now = new Date();
    const verdict = canConfirmPendingIncrease(row, now);
    if (!verdict.ok) {
      // The re-confirmation gate: too early or no longer pending → refused,
      // with the remaining wait reported honestly.
      return res.status(409).json({ error: verdict.reason, remainingMs: verdict.remainingMs ?? null });
    }
    if (!RISK_CEILING_FIELDS.includes(row.field)) {
      // A row naming an unclassified field cannot be applied — refuse rather
      // than write an arbitrary column.
      return res.status(409).json({ error: "UNRECOGNISED_FIELD" });
    }
    const value: number | boolean = row.valueKind === "boolean" ? row.targetValue !== 0 : row.targetValue;
    const settings = await getOrCreateRiskSettings(userId);
    await db
      .update(riskSettingsTable)
      .set({ [row.field]: value, riskMode: "Custom", updatedAt: now } as Record<string, unknown>)
      .where(and(eq(riskSettingsTable.id, settings.id), eq(riskSettingsTable.userId, userId)));
    const applied = await db
      .update(riskPendingIncreasesTable)
      .set({ status: "APPLIED", confirmedAt: now })
      .where(and(
        eq(riskPendingIncreasesTable.id, row.id),
        eq(riskPendingIncreasesTable.userId, userId),
        eq(riskPendingIncreasesTable.status, "PENDING"),
      ))
      .returning();
    if (!applied[0]) return res.status(409).json({ error: "NOT_PENDING" });
    shadowCaptureFAF({
      eventType: "RISK_INCREASE_CONFIRMED",
      source: "risk-vault",
      severity: "WARN",
      systemMode: null,
      globalState: null,
      payload: { userId, field: row.field, targetValue: row.targetValue, confirmedAt: now.toISOString() },
    });
    return res.json({ applied: true, field: row.field, value, confirmedAt: now.toISOString() });
  } catch (err) {
    req.log.error(err);
    return res.status(503).json({ error: "RISK_PENDING_STORE_UNAVAILABLE" });
  }
});

router.post("/risk/pending-increases/:id/cancel", requireUser, async (req, res) => {
  const idParse = PendingIdParam.safeParse(req.params.id);
  if (!idParse.success) return res.status(400).json({ error: "INVALID_ID" });
  try {
    const now = new Date();
    const cancelled = await db
      .update(riskPendingIncreasesTable)
      .set({ status: "CANCELLED", cancelledAt: now })
      .where(and(
        eq(riskPendingIncreasesTable.id, idParse.data),
        eq(riskPendingIncreasesTable.userId, req.authUser!.id),
        eq(riskPendingIncreasesTable.status, "PENDING"),
      ))
      .returning();
    if (!cancelled[0]) return res.status(404).json({ error: "NOT_FOUND_OR_NOT_PENDING" });
    return res.json({ cancelled: true, field: cancelled[0].field, cancelledAt: now.toISOString() });
  } catch (err) {
    req.log.error(err);
    return res.status(503).json({ error: "RISK_PENDING_STORE_UNAVAILABLE" });
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
    // Placeholder account balance (1000 USD) — no MT5 sync feeds this yet.
    // balanceSource below marks the figure so no consumer can mistake it for
    // a real account balance.
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
    return res.json({ ...audit, balanceSource: "PLACEHOLDER_1000" });
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
