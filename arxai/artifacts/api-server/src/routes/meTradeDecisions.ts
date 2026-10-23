// Phase UX7 — Trade Decision endpoints (user-scoped).
//
// SAFETY:
//   * Every endpoint requires an authenticated user (req.authUser.id).
//   * Trade ownership is re-checked on every :tradeKey via
//     resolveUserTrade. No cross-user reads possible.
//   * No endpoint executes a trade, moves a stop, or closes a position.
//     The recalc endpoint only writes a decision-support snapshot and
//     emits dedup'd alert candidates through trade_exit_alerts.
//   * No broker credentials, master account ids, or API keys are
//     returned in any payload.
//   * Safety envelope is attached to every response — success AND error.

import { Router, type IRouter, type Request } from "express";
import { db } from "@workspace/db";
import {
  tradeExitAlertsTable, tradeDecisionTimelineTable,
} from "@workspace/db/schema";
import { and, desc, eq, gte, sql } from "drizzle-orm";

import { resolveUserTrade } from "../lib/trades/resolveTrade.js";
import {
  buildTradeDecision, loadUserDecisionPrefs,
} from "../lib/decision/orchestrator.js";
import {
  upsertTradeDecision, loadPriorTradeDecision, loadAllActiveDecisions,
} from "../lib/decision/persistence.js";
import { evaluateDecisionAlerts } from "../lib/decision/decisionAlerts.js";

const router: IRouter = Router();
const uid = (req: Request) => (req as Request & { authUser?: { id?: number } }).authUser?.id ?? 0;

const SAFETY_ENVELOPE = {
  safetyMode: "paper_only" as const,
  liveLocked: true as const,
  readOnlyMode: true as const,
  allowOrderExecution: false as const,
};

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h | 0;
}

function decisionPayload(d: Awaited<ReturnType<typeof buildTradeDecision>>, trade: { tradeKey: string; routingMode: string; symbol: string; side: "BUY" | "SELL" }) {
  return {
    tradeKey: trade.tradeKey,
    routingMode: trade.routingMode,
    symbol: trade.symbol,
    side: trade.side,
    decision: {
      decisionLabel: d.decision.decisionLabel,
      decisionAction: d.decision.decisionAction,
      confidenceScore: d.decision.confidenceScore,
      urgencyScore: d.decision.urgencyScore,
      riskScore: d.decision.riskScore,
      reasonSummary: d.decision.reasonSummary,
      mainReason: d.decision.mainReason,
      supportingReasons: d.decision.supportingReasons,
      invalidationLevel: d.decision.invalidationLevel,
      protectProfitLevel: d.decision.protectProfitLevel,
      continuationLevel: d.decision.continuationLevel,
      suggestedButton: d.decision.suggestedButton,
      requiresConfirmation: d.decision.requiresConfirmation,
      whatWouldChange: d.decision.whatWouldChange,
      dataQuality: d.decision.dataQuality,
    },
    classification: {
      label: d.classification.label,
      primaryTimeframe: d.classification.primaryTimeframe,
    },
    exitPlan: {
      efficiencyLabel: d.exitPlan.efficiencyLabel,
      recommendedAction: d.exitPlan.recommendedAction,
      protectProfitLevel: d.exitPlan.protectProfitLevel,
      continuationLevel: d.exitPlan.continuationLevel,
      invalidationLevel: d.exitPlan.invalidationLevel,
    },
  };
}

// ─── GET /api/me/trades/:tradeKey/decision ──────────────────────────────
router.get("/me/trades/:tradeKey/decision", async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized", safety: SAFETY_ENVELOPE });
  const tradeKey = String(req.params.tradeKey ?? "");
  const trade = await resolveUserTrade(userId, tradeKey);
  if (!trade) return res.status(404).json({ ok: false, error: "trade_not_found_or_not_yours", safety: SAFETY_ENVELOPE });
  try {
    const prefs = await loadUserDecisionPrefs(userId);
    const result = await buildTradeDecision({
      tradeKey: trade.tradeKey, routingMode: trade.routingMode,
      symbol: trade.symbol, side: trade.side,
      entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
      stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
      unrealizedPnl: trade.unrealizedPnl, lotSize: trade.lotSize,
      openedAt: trade.openedAt,
    }, prefs);
    return res.json({ ok: true, ...decisionPayload(result, trade), safety: SAFETY_ENVELOPE });
  } catch (e) {
    req.log?.warn?.({ err: (e as Error).message }, "decision build failed");
    return res.status(500).json({ ok: false, error: "decision_build_failed", safety: SAFETY_ENVELOPE });
  }
});

// ─── POST /api/me/trades/:tradeKey/decision/recalculate ─────────────────
router.post("/me/trades/:tradeKey/decision/recalculate", async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized", safety: SAFETY_ENVELOPE });
  const tradeKey = String(req.params.tradeKey ?? "");
  const trade = await resolveUserTrade(userId, tradeKey);
  if (!trade) return res.status(404).json({ ok: false, error: "trade_not_found_or_not_yours", safety: SAFETY_ENVELOPE });

  try {
  // Load prior BEFORE compute so transition-only alerts work.
  const prior = await loadPriorTradeDecision(userId, trade.tradeKey);

  const prefs = await loadUserDecisionPrefs(userId);
  const result = await buildTradeDecision({
    tradeKey: trade.tradeKey, routingMode: trade.routingMode,
    symbol: trade.symbol, side: trade.side,
    entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
    stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
    unrealizedPnl: trade.unrealizedPnl, lotSize: trade.lotSize,
    openedAt: trade.openedAt,
  }, prefs);

  const saved = await upsertTradeDecision({
    userId, tradeKey: trade.tradeKey, routingMode: trade.routingMode,
    symbol: trade.symbol, side: trade.side,
    decision: result.decision,
  });

  // Dedup'd alerts via existing trade_exit_alerts path.
  const candidates = evaluateDecisionAlerts(trade.symbol, result.decision, prior);
  const insertedAlerts: Array<{ id: number; alertType: string }> = [];
  for (const a of candidates) {
    const lockKey = hash32(`${userId}:${trade.tradeKey}:${a.alertType}`);
    const ins = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);
      const recent = await tx.select({ id: tradeExitAlertsTable.id })
        .from(tradeExitAlertsTable)
        .where(and(
          eq(tradeExitAlertsTable.userId, userId),
          eq(tradeExitAlertsTable.tradeKey, trade.tradeKey),
          eq(tradeExitAlertsTable.alertType, a.alertType),
          gte(tradeExitAlertsTable.createdAt, new Date(Date.now() - 5 * 60_000)),
        )).limit(1);
      if (recent.length) return null;
      const [r] = await tx.insert(tradeExitAlertsTable).values({
        userId, tradeKey: trade.tradeKey,
        alertType: a.alertType, severity: a.severity,
        title: a.title, message: a.message,
        recommendedAction: a.recommendedAction,
        context: a.context as unknown as Record<string, unknown>,
      } as never).returning({ id: tradeExitAlertsTable.id });
      return r ?? null;
    });
    if (ins) insertedAlerts.push({ id: ins.id, alertType: a.alertType });
  }

  // Timeline entry when label changes.
  try {
    if (prior?.decisionLabel !== result.decision.decisionLabel) {
      await db.insert(tradeDecisionTimelineTable).values({
        userId, tradeKey: trade.tradeKey,
        eventType: "decision_changed",
        severity: result.decision.urgencyScore != null && result.decision.urgencyScore >= 70 ? "warning" : "info",
        title: `Decision: ${result.decision.decisionLabel}`,
        message: result.decision.reasonSummary,
        source: "decision_orchestrator",
        context: {
          label: result.decision.decisionLabel,
          action: result.decision.decisionAction,
          urgency: result.decision.urgencyScore,
          confidence: result.decision.confidenceScore,
          previousLabel: prior?.decisionLabel ?? null,
        },
      } as never);
    }
  } catch { /* non-fatal */ }

  return res.json({
    ok: true,
    saved: saved ? { id: saved.id, decisionLabel: saved.decisionLabel } : null,
    ...decisionPayload(result, trade),
    alerts: { insertedCount: insertedAlerts.length, types: insertedAlerts.map((x) => x.alertType) },
    safety: SAFETY_ENVELOPE,
  });
  } catch (e) {
    req.log.error({ err: e, userId, tradeKey: trade.tradeKey }, "decision_recalculate_failed");
    return res.status(500).json({ ok: false, error: "decision_recalculate_failed", safety: SAFETY_ENVELOPE });
  }
});

// ─── GET /api/me/trade-decisions/active ─────────────────────────────────
// Returns ALL stored decisions for the user (one per trade — upsert keeps
// only the latest). Ownership is implicit via user_id filter.
router.get("/me/trade-decisions/active", async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized", safety: SAFETY_ENVELOPE });
  try {
  const rows = await loadAllActiveDecisions(userId);
  return res.json({
    ok: true,
    count: rows.length,
    decisions: rows.map((r) => ({
      tradeKey: r.tradeKey,
      symbol: r.symbol, side: r.side,
      routingMode: r.routingMode,
      decisionLabel: r.decisionLabel,
      decisionAction: r.decisionAction,
      confidenceScore: r.confidenceScore,
      urgencyScore: r.urgencyScore,
      riskScore: r.riskScore,
      reasonSummary: r.reasonSummary,
      mainReason: r.mainReason,
      suggestedButton: r.suggestedButton,
      requiresConfirmation: r.requiresConfirmation,
      updatedAt: r.updatedAt,
      dataQuality: r.dataQuality,
    })),
    safety: SAFETY_ENVELOPE,
  });
  } catch (e) {
    req.log.error({ err: e, userId }, "decisions_active_failed");
    return res.status(500).json({ ok: false, error: "decisions_active_failed", safety: SAFETY_ENVELOPE });
  }
});

// ─── POST /api/me/trades/:tradeKey/decision/ask-ai ──────────────────────
// Records a "user asked AI why" timeline entry and returns the canonical
// 7-section explanation derived from the stored / freshly-computed
// decision. This endpoint never calls the chat model — that happens via
// the existing assistant SSE channel. We expose the structured payload so
// the assistant tool layer can read it verbatim and stream it to the user.
router.post("/me/trades/:tradeKey/decision/ask-ai", async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized", safety: SAFETY_ENVELOPE });
  const tradeKey = String(req.params.tradeKey ?? "");
  const trade = await resolveUserTrade(userId, tradeKey);
  if (!trade) return res.status(404).json({ ok: false, error: "trade_not_found_or_not_yours", safety: SAFETY_ENVELOPE });

  try {
  const prefs = await loadUserDecisionPrefs(userId);
  const result = await buildTradeDecision({
    tradeKey: trade.tradeKey, routingMode: trade.routingMode,
    symbol: trade.symbol, side: trade.side,
    entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
    stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
    unrealizedPnl: trade.unrealizedPnl, lotSize: trade.lotSize,
    openedAt: trade.openedAt,
  }, prefs);

  // Audit: user asked AI why.
  try {
    await db.insert(tradeDecisionTimelineTable).values({
      userId, tradeKey: trade.tradeKey,
      eventType: "user_asked_ai",
      severity: "info",
      title: `Asked AI: why ${result.decision.decisionLabel.toLowerCase()}?`,
      message: result.decision.reasonSummary,
      source: "user",
      context: { decisionLabel: result.decision.decisionLabel },
    } as never);
  } catch { /* non-fatal */ }

  const explanation = {
    currentDecision: result.decision.decisionLabel,
    mainReason: result.decision.mainReason,
    supportingEvidence: result.decision.supportingReasons,
    whatWouldConfirmContinuation: result.classification.evidence
      .filter((e) => /continuation|trend/i.test(e)).slice(0, 3),
    whatWouldInvalidate: result.decision.whatWouldChange,
    suggestedReviewAction: result.decision.suggestedButton,
    dataQualityWarning: result.decision.dataQuality.missing.length
      ? `Based on available data — missing: ${result.decision.dataQuality.missing.slice(0, 4).join(", ")}.`
      : "Based on available data. This is not guaranteed. Execution requires your confirmation.",
  };

  return res.json({
    ok: true,
    ...decisionPayload(result, trade),
    aiExplanation: explanation,
    safety: SAFETY_ENVELOPE,
  });
  } catch (e) {
    req.log.error({ err: e, userId, tradeKey: trade.tradeKey }, "decision_ask_ai_failed");
    return res.status(500).json({ ok: false, error: "decision_ask_ai_failed", safety: SAFETY_ENVELOPE });
  }
});

export default router;
