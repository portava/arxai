// Phase UX2 — Live Trade Intelligence + Sniper Exit Alert routes.
//
// SAFETY:
//   * Every endpoint is user-scoped via req.authUser.id.
//   * Ownership is re-checked on every :id (USER_OWNED via live_positions,
//     SHARED_MASTER via shared_trade_attribution).
//   * Never returns master MT5 credentials or other users' rows.
//   * No endpoint executes a trade. Close review is a preview only — the
//     user must still POST /api/me/trades/close with confirmedByUser:true.

import { Router, type IRouter, type Request } from "express";
import { db } from "@workspace/db";
import {
  livePositionsTable, sharedTradeAttributionTable,
  tradeIntelligenceSnapshotsTable, tradeExitAlertsTable,
  tradeAlertPreferencesTable, sharedMasterAccountsTable,
  tradeDecisionTimelineTable, tradeExitReviewsTable,
  tradeExitPlansTable,
  userNotificationsTable,
} from "@workspace/db/schema";
import { computeExitPlan } from "../lib/intelligence/exitPlan.js";
import { and, desc, eq, gte, sql } from "drizzle-orm";

// Stable 32-bit hash used to key a pg advisory transaction lock per
// (user, trade, alert type). Keeps concurrent intelligence polls from
// inserting duplicate alerts inside the dedup window.
function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h | 0; // signed int4
}
import { z } from "zod/v4";
import { getEnvelope } from "../lib/adminTrading/safetyEnvelope.js";
import { computeTradeIntelligence } from "../lib/intelligence/scoring.js";
import { getRunning, nextRunning } from "../lib/intelligence/mfeTracker.js";
import { evaluateAlerts, DEFAULT_PREFS, shouldDedup } from "../lib/intelligence/alertEngine.js";
import { createNotification } from "../lib/notificationService.js";

const router: IRouter = Router();
const uid = (req: Request) => (req as Request & { authUser?: { id?: number } }).authUser?.id ?? 0;

type ResolvedTrade = {
  tradeKey: string;
  routingMode: "USER_OWNED_MT5" | "SHARED_MASTER_MT5";
  symbol: string;
  side: "BUY" | "SELL";
  entryPrice: number | null;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  unrealizedPnl: number | null;
  lotSize: number;
  openedAt: Date | null;
  brokerLabelMasked: string | null;
  pnlIsEstimate: boolean;
};

// Resolve a `lp_<id>` or `att_<id>` key into trade data, scoped to userId.
async function resolveTrade(userId: number, tradeKey: string): Promise<ResolvedTrade | null> {
  if (tradeKey.startsWith("lp_")) {
    const id = Number(tradeKey.slice(3));
    if (!Number.isFinite(id) || id <= 0) return null;
    const [r] = await db.select().from(livePositionsTable)
      .where(and(eq(livePositionsTable.id, id), eq(livePositionsTable.userId, userId))).limit(1);
    if (!r) return null;
    return {
      tradeKey, routingMode: "USER_OWNED_MT5",
      symbol: r.symbol, side: r.direction as "BUY" | "SELL",
      entryPrice: r.entryPrice ?? null, currentPrice: r.currentPrice ?? null,
      stopLoss: r.stopLoss ?? null, takeProfit: r.takeProfit ?? null,
      unrealizedPnl: r.unrealizedProfitLoss ?? null, lotSize: r.lotSize,
      openedAt: r.openedAt ?? r.createdAt ?? null,
      brokerLabelMasked: null, pnlIsEstimate: false,
    };
  }
  if (tradeKey.startsWith("att_")) {
    const id = Number(tradeKey.slice(4));
    if (!Number.isFinite(id) || id <= 0) return null;
    const [r] = await db.select().from(sharedTradeAttributionTable)
      .where(and(eq(sharedTradeAttributionTable.id, id), eq(sharedTradeAttributionTable.userId, userId))).limit(1);
    if (!r) return null;
    let brokerLabelMasked: string | null = null;
    const [sm] = await db.select({
      broker: sharedMasterAccountsTable.brokerName,
      masked: sharedMasterAccountsTable.accountNumberMasked,
    }).from(sharedMasterAccountsTable)
      .where(eq(sharedMasterAccountsTable.id, r.sharedMasterAccountId)).limit(1);
    if (sm) brokerLabelMasked = `${sm.broker ?? "Master"} ${sm.masked ?? ""}`.trim();
    return {
      tradeKey, routingMode: "SHARED_MASTER_MT5",
      symbol: r.symbol, side: r.side as "BUY" | "SELL",
      entryPrice: r.entryPrice ?? null, currentPrice: null,
      stopLoss: r.stopLoss ?? null, takeProfit: r.takeProfit ?? null,
      unrealizedPnl: r.pnl ?? null, lotSize: r.lotSize,
      openedAt: r.openedAt ?? r.createdAt ?? null,
      brokerLabelMasked, pnlIsEstimate: true,
    };
  }
  return null;
}

async function getPrefs(userId: number) {
  const [p] = await db.select().from(tradeAlertPreferencesTable)
    .where(eq(tradeAlertPreferencesTable.userId, userId)).limit(1);
  if (p) return p;
  return { ...DEFAULT_PREFS, userId, createdAt: new Date(), updatedAt: new Date() };
}

// Compute + persist a fresh snapshot; evaluate alerts; return everything.
async function computeAndPersist(userId: number, trade: ResolvedTrade, accountType: "demo" | "live" | "unknown") {
  const running = await getRunning(userId, trade.tradeKey);
  const updated = nextRunning(running, {
    side: trade.side, entryPrice: trade.entryPrice,
    currentPrice: trade.currentPrice, unrealizedPnl: trade.unrealizedPnl,
  });
  const ageMinutes = trade.openedAt
    ? Math.floor((Date.now() - trade.openedAt.getTime()) / 60_000) : null;
  const prefs = await getPrefs(userId);
  const scoring = computeTradeIntelligence({
    side: trade.side, entryPrice: trade.entryPrice,
    currentPrice: trade.currentPrice, stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit, unrealizedPnl: trade.unrealizedPnl,
    mfe: updated.mfe, mae: updated.mae, peakPnl: updated.peakPnl,
    ageMinutes, symbol: trade.symbol,
    style: prefs.style as "scalping" | "intraday" | "swing" | "custom",
  });
  const [snap] = await db.insert(tradeIntelligenceSnapshotsTable).values({
    userId, tradeKey: trade.tradeKey,
    routingMode: trade.routingMode, accountType, symbol: trade.symbol,
    side: trade.side, entryPrice: trade.entryPrice,
    currentPrice: trade.currentPrice, unrealizedPnl: trade.unrealizedPnl,
    pnlPips: scoring.derived.pnlPips, mfe: updated.mfe, mae: updated.mae,
    peakPnl: updated.peakPnl, profitGivebackPercent: scoring.derived.profitGivebackPercent,
    continuationScore: scoring.scores.continuationScore,
    pullbackScore: scoring.scores.pullbackScore,
    reversalRiskScore: scoring.scores.reversalRiskScore,
    fakeoutRiskScore: scoring.scores.fakeoutRiskScore,
    profitProtectionScore: scoring.scores.profitProtectionScore,
    closeUrgencyScore: scoring.scores.closeUrgencyScore,
    holdConfidenceScore: scoring.scores.holdConfidenceScore,
    trendStrengthScore: scoring.scores.trendStrengthScore,
    volatilityRiskScore: scoring.scores.volatilityRiskScore,
    newsRiskScore: scoring.scores.newsRiskScore,
    label: scoring.label, recommendedAction: scoring.recommendedAction,
    explanation: scoring.explanation,
    dataQuality: scoring.dataQuality as unknown as Record<string, unknown>,
  } as never).returning();

  // UX5 — Compute Smart Exit Plan + upsert one row per (user, tradeKey).
  // Plan reuses the same prefs/scoring; never executes anything.
  const plan = computeExitPlan({
    symbol: trade.symbol, side: trade.side,
    entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
    stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
    unrealizedPnl: trade.unrealizedPnl, peakPnl: updated.peakPnl,
    mae: updated.mae, ageMinutes,
    prefs: {
      style: prefs.style, exitStyle: prefs.exitStyle ?? "balanced",
      sensitivity: prefs.sensitivity,
      profitGivebackPercent: prefs.profitGivebackPercent,
      maxHoldTimeMinutes: prefs.maxHoldTimeMinutes,
      partialClosePreference: prefs.partialClosePreference ?? "on",
      moveStopToBreakevenPref: prefs.moveStopToBreakevenPref ?? "at_1r",
      trailStopPref: prefs.trailStopPref ?? "after_1r",
    },
    scoring,
  });
  // Atomic upsert (one row per user+tradeKey, enforced by DB unique index).
  const planRow = {
    userId, tradeKey: trade.tradeKey,
    routingMode: trade.routingMode, accountType, symbol: trade.symbol,
    side: trade.side, entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
    protectProfitLevel: plan.protectProfitLevel,
    invalidationLevel: plan.invalidationLevel,
    continuationLevel: plan.continuationLevel,
    conservativeExitLevel: plan.conservativeExitLevel,
    aggressiveExitLevel: plan.aggressiveExitLevel,
    partialCloseLevel: plan.partialCloseLevel,
    trailStopLevel: plan.trailStopLevel,
    tradeEfficiencyScore: plan.tradeEfficiencyScore,
    closeUrgencyScore: plan.closeUrgencyScore,
    efficiencyLabel: plan.efficiencyLabel,
    timeWarning: plan.timeWarning,
    recommendedAction: plan.recommendedAction,
    explanation: plan.explanation,
    invalidationTrigger: plan.invalidationTrigger,
    continuationTrigger: plan.continuationTrigger,
    dataQuality: plan.dataQuality as unknown as Record<string, unknown>,
    ageMinutes,
    updatedAt: new Date(),
  };
  const upserted = await db.insert(tradeExitPlansTable).values(planRow as never)
    .onConflictDoUpdate({
      target: [tradeExitPlansTable.userId, tradeExitPlansTable.tradeKey],
      set: { ...planRow, updatedAt: new Date() } as never,
    })
    .returning({
      id: tradeExitPlansTable.id, createdAt: tradeExitPlansTable.createdAt,
      updatedAt: tradeExitPlansTable.updatedAt,
    });
  const savedPlan = upserted[0] ? { ...planRow, ...upserted[0] } as typeof tradeExitPlansTable.$inferSelect : null;
  // Emit exit_plan_created only on first insert (createdAt === updatedAt within 2s).
  const isFirstInsert = upserted[0]
    && Math.abs(new Date(upserted[0].createdAt).getTime() - new Date(upserted[0].updatedAt).getTime()) < 2000;
  if (isFirstInsert) {
    await db.insert(tradeDecisionTimelineTable).values({
      userId, tradeKey: trade.tradeKey,
      eventType: "exit_plan_created",
      severity: "info",
      title: `Exit plan created for ${trade.symbol}`,
      message: plan.explanation, source: "engine",
      context: { tradeEfficiencyScore: plan.tradeEfficiencyScore, efficiencyLabel: plan.efficiencyLabel },
    } as never);
  }

  // Evaluate candidate alerts.
  const candidates = evaluateAlerts(scoring, prefs as never, {
    symbol: trade.symbol, side: trade.side,
    unrealizedPnl: trade.unrealizedPnl, peakPnl: updated.peakPnl,
    entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
    stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
    ageMinutes, accountType,
    exitPlan: {
      protectProfitLevel: plan.protectProfitLevel,
      invalidationLevel: plan.invalidationLevel,
      continuationLevel: plan.continuationLevel,
      tradeEfficiencyScore: plan.tradeEfficiencyScore,
    },
    prefsUX5: {
      alertOnStall: prefs.alertOnStall ?? true,
      alertOnEfficiencyDrop: prefs.alertOnEfficiencyDrop ?? true,
      alertOnInvalidationBreak: prefs.alertOnInvalidationBreak ?? true,
    },
  });
  // Insert each (userId, tradeKey, alertType) under a per-type pg advisory
  // transaction lock so concurrent pollers cannot race past dedup.
  const inserted: typeof tradeExitAlertsTable.$inferSelect[] = [];
  for (const a of candidates) {
    const lockKey = hash32(`${userId}:${trade.tradeKey}:${a.alertType}`);
    const row = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);
      const recent = await tx.select({
        alertType: tradeExitAlertsTable.alertType,
        severity: tradeExitAlertsTable.severity,
        createdAt: tradeExitAlertsTable.createdAt,
      }).from(tradeExitAlertsTable).where(and(
        eq(tradeExitAlertsTable.userId, userId),
        eq(tradeExitAlertsTable.tradeKey, trade.tradeKey),
        eq(tradeExitAlertsTable.alertType, a.alertType),
        gte(tradeExitAlertsTable.createdAt, new Date(Date.now() - 5 * 60_000)),
      ));
      if (shouldDedup(recent, a.alertType, a.severity)) return null;
      const [r] = await tx.insert(tradeExitAlertsTable).values({
        userId, tradeKey: trade.tradeKey,
        alertType: a.alertType, severity: a.severity,
        title: a.title, message: a.message,
        recommendedAction: a.recommendedAction,
        context: a.context as unknown as Record<string, unknown>,
      } as never).returning();
      return r ?? null;
    });
    if (row) inserted.push(row);
  }
  // UX3 — Bridge each new alert into user_notifications (in-app channel) and
  // into the per-trade decision timeline. Both inserts are user-scoped and
  // race-safe (bucket dedup on notifications; advisory-locked dedup above on
  // alerts means timeline rows mirror alerts 1:1).
  for (const a of inserted) {
    try {
      // Route via central notificationService so the web-push fanout, dedup,
      // and quiet-hours/preference logic all apply uniformly. Falls back
      // silently when push is unconfigured.
      // T024 — STABLE dedupe key per (trade, alertType). Previously entityId was
      // the per-emission trade_exit_alerts row id, so every re-fire produced a
      // brand-new notification (the "holding longer than your intraday window"
      // spam). Keying on the trade itself lets createNotification collapse
      // repeats into one row (repeatCount + lastOccurrenceAt). A persistent
      // condition like hold_time_exceeded gets a longer cooldown so it does not
      // re-surface as a new row every hour.
      const persistentCondition = a.alertType === "hold_time_exceeded";
      await createNotification(userId, {
        notificationType: `trade_${a.alertType}`,
        severity: a.severity === "urgent" || a.severity === "warning" ? "critical" : "info",
        title: a.title,
        message: a.message,
        source: "trade",
        entityType: `trade_exit:${trade.tradeKey}`,
        entityId: 0,
        actionLabel: "Review",
        actionTarget: `/my-trades/${encodeURIComponent(trade.tradeKey)}`,
        cooldownMs: persistentCondition ? 6 * 60 * 60_000 : undefined,
      });
    } catch { /* never block alert path on notification errors */ }
    await db.insert(tradeDecisionTimelineTable).values({
      userId, tradeKey: trade.tradeKey,
      eventType: "alert_fired",
      severity: a.severity,
      title: a.title, message: a.message,
      source: "engine",
      context: { alertId: a.id, alertType: a.alertType },
    } as never);
  }
  return { snap: snap!, scoring, alerts: inserted, prefs, plan, savedPlan };
}

// UX4 — Background worker entry point. Resolves the trade by key, runs the
// same computeAndPersist pipeline used by user-facing routes, and returns a
// compact summary suitable for the monitor's status counters. Safety/ownership
// is preserved because resolveTrade re-checks (userId, key) on every call.
export async function computeAndPersistForKey(
  userId: number,
  tradeKey: string,
): Promise<{ alertsCreated: number; dataStale: boolean } | null> {
  const trade = await resolveTrade(userId, tradeKey);
  if (!trade) return null;
  const env = await getEnvelope(userId);
  const r = await computeAndPersist(userId, trade, env.accountType);
  const dq = (r.snap.dataQuality ?? {}) as { stale?: boolean };
  return { alertsCreated: r.alerts.length, dataStale: Boolean(dq.stale) };
}

// ─── GET /api/me/trades/:tradeKey/intelligence ────────────────────────
router.get("/me/trades/:tradeKey/intelligence", async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  try {
    const trade = await resolveTrade(userId, String(req.params["tradeKey"]));
    if (!trade) { res.status(404).json({ ok: false, error: "TRADE_NOT_FOUND" }); return; }
    const env = await getEnvelope(userId);
    const r = await computeAndPersist(userId, trade, env.accountType);
    res.json({
      ok: true,
      trade: {
        tradeKey: trade.tradeKey, routingMode: trade.routingMode,
        symbol: trade.symbol, side: trade.side, lotSize: trade.lotSize,
        entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
        stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
        unrealizedPnl: trade.unrealizedPnl, pnlIsEstimate: trade.pnlIsEstimate,
        brokerLabelMasked: trade.brokerLabelMasked,
      },
      snapshot: r.snap,
      newAlerts: r.alerts,
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET trade intelligence failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ─── POST /api/me/trades/:tradeKey/close-review ───────────────────────
router.post("/me/trades/:tradeKey/close-review", async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  try {
    const trade = await resolveTrade(userId, String(req.params["tradeKey"]));
    if (!trade) { res.status(404).json({ ok: false, error: "TRADE_NOT_FOUND" }); return; }
    const env = await getEnvelope(userId);
    const r = await computeAndPersist(userId, trade, env.accountType);
    res.json({
      ok: true,
      preview: {
        tradeKey: trade.tradeKey, symbol: trade.symbol, side: trade.side,
        lotSize: trade.lotSize, currentPnl: trade.unrealizedPnl,
        peakPnl: r.snap.peakPnl, profitGivebackPercent: r.snap.profitGivebackPercent,
        accountType: env.accountType, routingMode: trade.routingMode,
        label: r.snap.label, recommendedAction: r.snap.recommendedAction,
        explanation: r.snap.explanation,
      },
      warningIfLive: env.accountType === "live"
        ? "This will close a LIVE trade and may realize profit or loss."
        : null,
      requiresUserConfirmation: true,
      requiresLiveAck: env.accountType === "live" || env.tradingMode === "LIVE",
      nextStep: "POST /api/me/trades/close with { tradeKey, confirmedByUser:true }",
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "POST trade close-review failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ─── GET /api/me/trade-alerts ─────────────────────────────────────────
router.get("/me/trade-alerts", async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  const limit = Math.min(200, Number(req.query["limit"] ?? 50));
  try {
    const rows = await db.select().from(tradeExitAlertsTable)
      .where(eq(tradeExitAlertsTable.userId, userId))
      .orderBy(desc(tradeExitAlertsTable.createdAt)).limit(limit);
    res.json({ ok: true, alerts: rows });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET trade-alerts failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

router.post("/me/trade-alerts/:id/ack", async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) { res.status(400).json({ ok: false, error: "BAD_ID" }); return; }
  try {
    // user-scoped update — only acks alerts owned by the caller.
    await db.update(tradeExitAlertsTable)
      .set({ acknowledgedAt: new Date() })
      .where(and(eq(tradeExitAlertsTable.id, id), eq(tradeExitAlertsTable.userId, userId)));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err: String(err) }, "POST ack failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ─── GET / PATCH /api/me/trade-alert-preferences ──────────────────────
router.get("/me/trade-alert-preferences", async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  const p = await getPrefs(userId);
  res.json({ ok: true, preferences: p });
});

const prefSchema = z.object({
  alertsEnabled: z.boolean().optional(),
  pushEnabled: z.boolean().optional(),
  inAppEnabled: z.boolean().optional(),
  style: z.enum(["scalping", "intraday", "swing", "custom"]).optional(),
  sensitivity: z.enum(["conservative", "balanced", "aggressive"]).optional(),
  profitGivebackPercent: z.number().min(5).max(95).optional(),
  minProfitBeforeAlert: z.number().min(0).max(1_000_000).optional(),
  maxHoldTimeMinutes: z.number().int().min(1).max(60 * 24 * 30).optional(),
  alertBeforeTakeProfit: z.boolean().optional(),
  alertBeforeStopLoss: z.boolean().optional(),
  alertNearBreakeven: z.boolean().optional(),
  alertReversalRisk: z.boolean().optional(),
  // UX5
  exitStyle: z.enum(["conservative", "balanced", "aggressive"]).optional(),
  partialClosePreference: z.enum(["on", "off"]).optional(),
  moveStopToBreakevenPref: z.enum(["off", "at_50pct_tp", "at_1r"]).optional(),
  trailStopPref: z.enum(["off", "after_1r", "after_2r", "atr"]).optional(),
  alertOnStall: z.boolean().optional(),
  alertOnEfficiencyDrop: z.boolean().optional(),
  alertOnInvalidationBreak: z.boolean().optional(),
});

router.patch("/me/trade-alert-preferences", async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  const parsed = prefSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: "INVALID_BODY", details: parsed.error.message }); return; }
  try {
    const existing = await db.select().from(tradeAlertPreferencesTable)
      .where(eq(tradeAlertPreferencesTable.userId, userId)).limit(1);
    if (existing.length === 0) {
      await db.insert(tradeAlertPreferencesTable).values({
        userId, ...DEFAULT_PREFS, ...parsed.data, updatedAt: new Date(),
      } as never);
    } else {
      await db.update(tradeAlertPreferencesTable)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(eq(tradeAlertPreferencesTable.userId, userId));
    }
    const p = await getPrefs(userId);
    res.json({ ok: true, preferences: p });
  } catch (err) {
    req.log.error({ err: String(err) }, "PATCH prefs failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ─── UX3 ──────────────────────────────────────────────────────────────
// GET /api/me/sniper-watchlist
// Scans the caller's open trades, computes a fresh snapshot for each, and
// returns only those needing attention. Ranked by closeUrgencyScore desc.
router.get("/me/sniper-watchlist", async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  try {
    const env = await getEnvelope(userId);
    // Gather open trade keys depending on routing mode (user-scoped reads).
    const keys: string[] = [];
    if (env.accountRoutingMode === "USER_OWNED_MT5") {
      const rows = await db.select({ id: livePositionsTable.id })
        .from(livePositionsTable)
        .where(and(eq(livePositionsTable.userId, userId), eq(livePositionsTable.status, "OPEN")));
      for (const r of rows) keys.push(`lp_${r.id}`);
    } else {
      const rows = await db.select({ id: sharedTradeAttributionTable.id })
        .from(sharedTradeAttributionTable)
        .where(and(eq(sharedTradeAttributionTable.userId, userId), eq(sharedTradeAttributionTable.status, "open")));
      for (const r of rows) keys.push(`att_${r.id}`);
    }

    const items: Array<{
      tradeKey: string; symbol: string; side: string; lotSize: number;
      unrealizedPnl: number | null; peakPnl: number | null;
      profitGivebackPercent: number | null; closeUrgencyScore: number | null;
      reversalRiskScore: number | null; fakeoutRiskScore: number | null;
      volatilityRiskScore: number | null;
      label: string | null; recommendedAction: string | null;
      reasons: string[]; urgencyTier: "info" | "watch" | "warning" | "urgent";
    }> = [];

    for (const k of keys) {
      const trade = await resolveTrade(userId, k);
      if (!trade) continue;
      const r = await computeAndPersist(userId, trade, env.accountType);
      const s = r.snap;
      const reasons: string[] = [];
      const urg = s.closeUrgencyScore ?? 0;
      const giveback = s.profitGivebackPercent ?? 0;
      const rev = s.reversalRiskScore ?? 0;
      const fake = s.fakeoutRiskScore ?? 0;
      const vol = s.volatilityRiskScore ?? 0;
      const pnl = trade.unrealizedPnl ?? 0;
      const peak = s.peakPnl ?? 0;
      if (giveback >= 30 && pnl > 0) reasons.push(`profit fading (${giveback}% giveback)`);
      if (urg >= 60) reasons.push(`close urgency ${urg}`);
      if (rev >= 60) reasons.push(`reversal risk ${rev}`);
      if (fake >= 60) reasons.push(`possible fakeout (${fake})`);
      if (vol >= 70) reasons.push(`high volatility (${vol})`);
      if (peak > 0 && pnl <= 0) reasons.push("returned to break-even or worse");
      // Near-SL / Near-TP fired as separate alerts; surface here too if relevant.
      if (trade.stopLoss != null && trade.currentPrice != null && trade.entryPrice != null) {
        const total = Math.abs(trade.entryPrice - trade.stopLoss);
        const dist = Math.abs(trade.currentPrice - trade.stopLoss);
        if (total > 0 && dist / total < 0.3) reasons.push("price near stop loss");
      }
      if (trade.takeProfit != null && trade.currentPrice != null && trade.entryPrice != null) {
        const total = Math.abs(trade.takeProfit - trade.entryPrice);
        const dist = Math.abs(trade.takeProfit - trade.currentPrice);
        if (total > 0 && dist / total < 0.2 && pnl > 0) reasons.push("price near take profit");
      }
      if (reasons.length === 0) continue; // only attention-needing trades
      const tier: "info" | "watch" | "warning" | "urgent" =
        urg >= 85 ? "urgent" : urg >= 65 ? "warning" : urg >= 40 ? "watch" : "info";
      items.push({
        tradeKey: k, symbol: trade.symbol, side: trade.side, lotSize: trade.lotSize,
        unrealizedPnl: trade.unrealizedPnl, peakPnl: s.peakPnl,
        profitGivebackPercent: s.profitGivebackPercent,
        closeUrgencyScore: s.closeUrgencyScore,
        reversalRiskScore: s.reversalRiskScore,
        fakeoutRiskScore: s.fakeoutRiskScore,
        volatilityRiskScore: s.volatilityRiskScore,
        label: s.label, recommendedAction: s.recommendedAction,
        reasons, urgencyTier: tier,
      });
    }
    items.sort((a, b) => (b.closeUrgencyScore ?? 0) - (a.closeUrgencyScore ?? 0));
    res.json({
      ok: true,
      count: items.length,
      items,
      accountType: env.accountType,
      routingMode: env.accountRoutingMode,
      lastUpdatedAt: new Date().toISOString(),
      dataFreshness: "fresh",
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET sniper-watchlist failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// GET /api/me/trades/:tradeKey/timeline — per-trade decision timeline.
router.get("/me/trades/:tradeKey/timeline", async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  const tradeKey = String(req.params["tradeKey"]);
  // Verify the caller owns the trade BEFORE returning timeline rows so a user
  // cannot probe another user's tradeKey to see whether it exists.
  const trade = await resolveTrade(userId, tradeKey);
  if (!trade) { res.status(404).json({ ok: false, error: "TRADE_NOT_FOUND" }); return; }
  try {
    const rows = await db.select().from(tradeDecisionTimelineTable)
      .where(and(
        eq(tradeDecisionTimelineTable.userId, userId),
        eq(tradeDecisionTimelineTable.tradeKey, tradeKey),
      ))
      .orderBy(desc(tradeDecisionTimelineTable.createdAt))
      .limit(200);
    res.json({ ok: true, timeline: rows });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET trade timeline failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// POST /api/me/trades/:tradeKey/timeline — record a user-side event
// (alert_ignored | hold_decided | stop_review_opened | partial_close_review_opened).
const timelineEventSchema = z.object({
  eventType: z.enum([
    "alert_ignored", "hold_decided", "stop_review_opened",
    "partial_close_review_opened", "user_asked_ai", "close_reviewed",
  ]),
  message: z.string().max(500).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});
router.post("/me/trades/:tradeKey/timeline", async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  const tradeKey = String(req.params["tradeKey"]);
  const trade = await resolveTrade(userId, tradeKey);
  if (!trade) { res.status(404).json({ ok: false, error: "TRADE_NOT_FOUND" }); return; }
  const parsed = timelineEventSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: "INVALID_BODY" }); return; }
  try {
    const [row] = await db.insert(tradeDecisionTimelineTable).values({
      userId, tradeKey,
      eventType: parsed.data.eventType,
      severity: "info",
      title: parsed.data.eventType.replace(/_/g, " "),
      message: parsed.data.message ?? "",
      source: "user",
      context: parsed.data.context ?? {},
    } as never).returning();
    res.json({ ok: true, event: row });
  } catch (err) {
    req.log.error({ err: String(err) }, "POST timeline failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// GET /api/me/trades/:tradeKey/exit-review — fetch most-recent review.
router.get("/me/trades/:tradeKey/exit-review", async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  const tradeKey = String(req.params["tradeKey"]);
  try {
    const [row] = await db.select().from(tradeExitReviewsTable)
      .where(and(
        eq(tradeExitReviewsTable.userId, userId),
        eq(tradeExitReviewsTable.tradeKey, tradeKey),
      ))
      .orderBy(desc(tradeExitReviewsTable.createdAt))
      .limit(1);
    res.json({ ok: true, review: row ?? null });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET exit-review failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// GET /api/me/trade-exit-reviews — recent reviews across all trades.
router.get("/me/trade-exit-reviews", async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  const limit = Math.min(100, Number(req.query["limit"] ?? 25));
  try {
    const rows = await db.select().from(tradeExitReviewsTable)
      .where(eq(tradeExitReviewsTable.userId, userId))
      .orderBy(desc(tradeExitReviewsTable.createdAt))
      .limit(limit);
    res.json({ ok: true, reviews: rows });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET trade-exit-reviews failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ════════════════════════════════════════════════════════════════════
// Phase UX5 — Smart Exit Plan endpoints
// ════════════════════════════════════════════════════════════════════
// All endpoints are user-scoped, decision-support only. None of them
// move stops, close positions, or modify broker state.

// GET — return the latest persisted plan + a freshly recomputed one.
router.get("/me/trades/:tradeKey/exit-plan", async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  try {
    const trade = await resolveTrade(userId, String(req.params["tradeKey"]));
    if (!trade) { res.status(404).json({ ok: false, error: "TRADE_NOT_FOUND" }); return; }
    const env = await getEnvelope(userId);
    const r = await computeAndPersist(userId, trade, env.accountType);
    res.json({
      ok: true,
      trade: {
        tradeKey: trade.tradeKey, symbol: trade.symbol, side: trade.side,
        entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
        stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
        unrealizedPnl: trade.unrealizedPnl,
      },
      plan: r.savedPlan,
      safety: {
        decisionSupportOnly: true,
        requiresUserConfirmation: true,
        noAutoClose: true,
        noStopMove: true,
        accountType: env.accountType,
      },
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET exit-plan failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// POST — force a fresh recompute (records a timeline event).
router.post("/me/trades/:tradeKey/exit-plan/recalculate", async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  try {
    const trade = await resolveTrade(userId, String(req.params["tradeKey"]));
    if (!trade) { res.status(404).json({ ok: false, error: "TRADE_NOT_FOUND" }); return; }
    const env = await getEnvelope(userId);
    const r = await computeAndPersist(userId, trade, env.accountType);
    await db.insert(tradeDecisionTimelineTable).values({
      userId, tradeKey: trade.tradeKey,
      eventType: "exit_plan_recalculated",
      severity: "info",
      title: `Exit plan recalculated for ${trade.symbol}`,
      message: r.plan.explanation, source: "user",
      context: { tradeEfficiencyScore: r.plan.tradeEfficiencyScore },
    } as never);
    res.json({ ok: true, plan: r.savedPlan });
  } catch (err) {
    req.log.error({ err: String(err) }, "POST exit-plan recalc failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// POST — review-only preview for "move stop to break-even".
// Records a timeline event but DOES NOT modify the stop. The user must
// still take the action manually in their broker UI / MT5 EA.
router.post("/me/trades/:tradeKey/review-move-stop", async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  try {
    const trade = await resolveTrade(userId, String(req.params["tradeKey"]));
    if (!trade) { res.status(404).json({ ok: false, error: "TRADE_NOT_FOUND" }); return; }
    const env = await getEnvelope(userId);
    const r = await computeAndPersist(userId, trade, env.accountType);
    await db.insert(tradeDecisionTimelineTable).values({
      userId, tradeKey: trade.tradeKey,
      eventType: "stop_review_opened",
      severity: "info",
      title: `Reviewed move-stop suggestion for ${trade.symbol}`,
      message: `Suggested new stop ≈ ${r.plan.protectProfitLevel ?? "n/a"} (preview only — ARX does not move broker stops).`,
      source: "user",
      context: { suggestedStop: r.plan.protectProfitLevel, currentStop: trade.stopLoss },
    } as never);
    res.json({
      ok: true,
      preview: {
        symbol: trade.symbol, currentStop: trade.stopLoss,
        suggestedStop: r.plan.protectProfitLevel,
        rationale: r.plan.explanation,
      },
      executes: false,
      message: "ARX never moves stops automatically. To apply, change it in your broker or MT5 terminal.",
      requiresUserConfirmation: true,
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "POST review-move-stop failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// POST — review-only preview for "partial close" (e.g. close half).
router.post("/me/trades/:tradeKey/review-partial-close", async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" }); return; }
  const portion = Math.min(0.95, Math.max(0.05, Number(req.body?.portion ?? 0.5)));
  try {
    const trade = await resolveTrade(userId, String(req.params["tradeKey"]));
    if (!trade) { res.status(404).json({ ok: false, error: "TRADE_NOT_FOUND" }); return; }
    const env = await getEnvelope(userId);
    const r = await computeAndPersist(userId, trade, env.accountType);
    await db.insert(tradeDecisionTimelineTable).values({
      userId, tradeKey: trade.tradeKey,
      eventType: "partial_close_review_opened",
      severity: "info",
      title: `Reviewed partial close (${Math.round(portion * 100)}%) for ${trade.symbol}`,
      message: `Suggested level ${r.plan.partialCloseLevel ?? "n/a"} (preview only).`,
      source: "user",
      context: { portion, suggestedLevel: r.plan.partialCloseLevel },
    } as never);
    res.json({
      ok: true,
      preview: {
        symbol: trade.symbol, currentLotSize: trade.lotSize,
        proposedCloseLotSize: Math.round(trade.lotSize * portion * 1000) / 1000,
        remainingLotSize: Math.round(trade.lotSize * (1 - portion) * 1000) / 1000,
        suggestedLevel: r.plan.partialCloseLevel,
        rationale: r.plan.explanation,
      },
      executes: false,
      message: "ARX never executes partial closes automatically. To apply, place the order in your broker or MT5 terminal.",
      requiresUserConfirmation: true,
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "POST review-partial-close failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

export default router;
