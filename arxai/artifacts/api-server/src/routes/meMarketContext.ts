// Phase UX6 — Market Context endpoints (user-scoped).
//
// SAFETY:
//   * Every endpoint requires an authenticated user (req.authUser.id).
//   * Trade ownership is re-checked on every :tradeKey via resolveUserTrade.
//   * No endpoint executes a trade. The recalc endpoint only writes a
//     decision-support snapshot and emits in-app alert candidates through
//     the existing trade_exit_alerts dedup path.
//   * No broker credentials, master account ids, or API keys are returned.
//   * Live market data lookups go through getMarketProvider() which uses a
//     60s candle cache. We never substitute simulator data — if the
//     provider has no candles, the response is honest about it.

import { Router, type IRouter, type Request } from "express";
import { db } from "@workspace/db";
import {
  tradeExitAlertsTable, tradeDecisionTimelineTable,
} from "@workspace/db/schema";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { resolveUserTrade } from "../lib/trades/resolveTrade.js";
import { buildMarketContext, TIMEFRAMES, type Timeframe } from "../lib/marketContext/contextBuilder.js";
import { classify } from "../lib/marketContext/classifier.js";
import { computeKeyLevels } from "../lib/marketContext/keyLevels.js";
import { buildTradeContext } from "../lib/marketContext/tradeContext.js";
import { upsertTradeMarketContext, persistSymbolSnapshot, loadPriorTradeMarketContext } from "../lib/marketContext/persistence.js";
import { evaluateMarketContextAlerts } from "../lib/marketContext/alerts.js";
import { validateSymbol } from "../lib/assistant/marketProvider.js";
import { getSymbolTradability } from "../lib/data/symbolTradability.js";

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

// Strip provider candles from the wire payload — frontend only needs the
// derived per-TF summary (trend, ATR, swings, S/R, range). Keeps payload
// small and prevents accidental leakage of bulk provider data. When
// `only` is provided, also narrows the returned TFs to the user's
// requested set (buildMarketContext backfills all 7 for type safety).
function sanitizeTimeframes(tfs: Record<string, unknown>, only?: readonly Timeframe[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const allow = only ? new Set<string>(only) : null;
  for (const [k, v] of Object.entries(tfs)) {
    if (allow && !allow.has(k)) continue;
    if (v && typeof v === "object") {
      const c = { ...(v as Record<string, unknown>) };
      delete c.candles;
      out[k] = c;
    }
  }
  return out;
}

// ─── GET /api/me/market-context/:symbol ────────────────────────────────
router.get("/me/market-context/:symbol", async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized", safety: SAFETY_ENVELOPE });
  const sym = validateSymbol(String(req.params.symbol ?? ""));
  if (!sym) return res.status(400).json({ ok: false, error: "invalid_symbol", safety: SAFETY_ENVELOPE });
  try {
    const tfsQ = z.string().optional().safeParse(req.query.tfs);
    let timeframes: Timeframe[] = [...TIMEFRAMES];
    let narrowed = false;
    if (tfsQ.success && tfsQ.data) {
      const parts = tfsQ.data.split(",").map((s) => s.trim()).filter(Boolean);
      const filtered = parts.filter((p): p is Timeframe => (TIMEFRAMES as readonly string[]).includes(p));
      if (filtered.length) { timeframes = filtered; narrowed = true; }
    }
    const ctx = await buildMarketContext({ symbol: sym, timeframes });
    const classification = classify(ctx);
    // Persist the snapshot for the per-symbol cache (non-blocking on failure).
    try { await persistSymbolSnapshot(ctx); } catch { /* honest log inside, never crash request */ }
    // Resolve tradability so Ruby's market-context responses can honestly
    // explain "analyze vs execute" for synthetic / data-only markets.
    const tradability = await getSymbolTradability(sym, userId);
    return res.json({
      ok: true,
      symbol: sym,
      context: {
        symbol: ctx.symbol,
        source: ctx.source,
        builtAtIso: ctx.builtAtIso,
        asOf: ctx.asOf,
        currentPrice: ctx.currentPrice,
        bid: ctx.bid, ask: ctx.ask, spread: ctx.spread,
        freshness: ctx.freshness, session: ctx.session,
        timeframes: sanitizeTimeframes(ctx.timeframes, narrowed ? timeframes : undefined),
        dataQuality: ctx.dataQuality,
      },
      classification: {
        label: classification.label,
        scores: classification.scores,
        explanation: classification.explanation,
        evidence: classification.evidence,
        primaryTimeframe: classification.primaryTimeframe,
        htfTimeframe: classification.htfTimeframe,
      },
      tradability: {
        assetClass: tradability.assetClass,
        dataProvider: tradability.dataProvider,
        dataAvailable: tradability.dataAvailable,
        mt5Tradable: tradability.mt5Tradable,
        executionProvider: tradability.executionProvider,
        liveExecutionAllowed: tradability.liveExecutionAllowed,
        badgeLabel: tradability.badgeLabel,
        userMessage: tradability.userMessage,
      },
      safety: SAFETY_ENVELOPE,
    });
  } catch (e) {
    req.log?.warn?.({ err: (e as Error).message }, "market-context build failed");
    return res.status(500).json({ ok: false, error: "context_build_failed", safety: SAFETY_ENVELOPE });
  }
});

// ─── GET /api/me/trades/:tradeKey/market-context ───────────────────────
router.get("/me/trades/:tradeKey/market-context", async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized", safety: SAFETY_ENVELOPE });
  const tradeKey = String(req.params.tradeKey ?? "");
  const trade = await resolveUserTrade(userId, tradeKey);
  if (!trade) return res.status(404).json({ ok: false, error: "trade_not_found_or_not_yours", safety: SAFETY_ENVELOPE });
  try {
    const ctx = await buildMarketContext({ symbol: trade.symbol });
    const classification = classify(ctx);
    const keyLevels = computeKeyLevels({
      side: trade.side,
      entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
      stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
      ctx, classification,
    });
    const tradeCtx = buildTradeContext({
      side: trade.side,
      entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
      stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
      unrealizedPnl: trade.unrealizedPnl, peakPnl: null,
      ctx, classification, keyLevels,
    });
    return res.json({
      ok: true,
      trade: {
        tradeKey: trade.tradeKey, routingMode: trade.routingMode,
        symbol: trade.symbol, side: trade.side,
        entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
        stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
      },
      classification: {
        label: classification.label, scores: classification.scores,
        explanation: classification.explanation,
        primaryTimeframe: classification.primaryTimeframe,
        htfTimeframe: classification.htfTimeframe,
      },
      tradeContext: {
        trendAlignment: tradeCtx.trendAlignment,
        tradeLabel: tradeCtx.tradeLabel,
        bullishScenario: tradeCtx.bullishScenario,
        bearishScenario: tradeCtx.bearishScenario,
        exitHoldReview: tradeCtx.exitHoldReview,
        rationale: tradeCtx.rationale,
      },
      keyLevels,
      context: {
        source: ctx.source, asOf: ctx.asOf, freshness: ctx.freshness,
        session: ctx.session, currentPrice: ctx.currentPrice,
        bid: ctx.bid, ask: ctx.ask, spread: ctx.spread,
        dataQuality: ctx.dataQuality,
        timeframes: sanitizeTimeframes(ctx.timeframes),
      },
      safety: SAFETY_ENVELOPE,
    });
  } catch (e) {
    req.log?.warn?.({ err: (e as Error).message }, "trade market-context failed");
    return res.status(500).json({ ok: false, error: "trade_context_build_failed", safety: SAFETY_ENVELOPE });
  }
});

// ─── POST /api/me/trades/:tradeKey/market-context/recalculate ──────────
router.post("/me/trades/:tradeKey/market-context/recalculate", async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized", safety: SAFETY_ENVELOPE });
  const tradeKey = String(req.params.tradeKey ?? "");
  const trade = await resolveUserTrade(userId, tradeKey);
  if (!trade) return res.status(404).json({ ok: false, error: "trade_not_found_or_not_yours", safety: SAFETY_ENVELOPE });

  // Load prior stored snapshot BEFORE upserting so transition-based alerts
  // (classification_flip, fakeout_risk_rising, etc.) can fire only on a
  // real prior→current change.
  const prior = await loadPriorTradeMarketContext(userId, trade.tradeKey);

  const ctx = await buildMarketContext({ symbol: trade.symbol });
  const classification = classify(ctx);
  const keyLevels = computeKeyLevels({
    side: trade.side,
    entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
    stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
    ctx, classification,
  });
  const tradeCtx = buildTradeContext({
    side: trade.side,
    entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
    stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
    unrealizedPnl: trade.unrealizedPnl, peakPnl: null,
    ctx, classification, keyLevels,
  });
  const saved = await upsertTradeMarketContext({
    userId, tradeKey: trade.tradeKey, routingMode: trade.routingMode,
    symbol: trade.symbol, side: trade.side,
    ctx, classification, keyLevels, tradeCtx,
  });
  try { await persistSymbolSnapshot(ctx); } catch { /* non-fatal */ }

  // Evaluate market-context alerts and insert under the existing dedup path
  // (alertType is column type text; new market types coexist with UX2/UX5).
  const candidates = evaluateMarketContextAlerts({
    symbol: trade.symbol, side: trade.side,
    currentPrice: trade.currentPrice, spread: ctx.spread,
    classification, tradeContext: tradeCtx, keyLevels,
    prior,
  });
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

  // Timeline event whenever the label changes vs the most recent timeline.
  try {
    const [recentEvt] = await db.select({ context: tradeDecisionTimelineTable.context })
      .from(tradeDecisionTimelineTable)
      .where(and(
        eq(tradeDecisionTimelineTable.userId, userId),
        eq(tradeDecisionTimelineTable.tradeKey, trade.tradeKey),
        eq(tradeDecisionTimelineTable.eventType, "market_context_updated"),
      )).orderBy(desc(tradeDecisionTimelineTable.createdAt)).limit(1);
    const prevLabel = (recentEvt?.context as { label?: string } | undefined)?.label ?? null;
    if (prevLabel !== classification.label) {
      await db.insert(tradeDecisionTimelineTable).values({
        userId, tradeKey: trade.tradeKey,
        eventType: "market_context_updated",
        severity: "info",
        title: `Market context: ${classification.label}`,
        message: classification.explanation,
        source: "engine",
        context: { label: classification.label, trendAlignment: tradeCtx.trendAlignment, primaryTimeframe: classification.primaryTimeframe },
      } as never);
    }
  } catch { /* non-fatal */ }

  return res.json({
    ok: true,
    saved: saved ? { id: saved.id, classificationLabel: saved.classificationLabel } : null,
    classification: {
      label: classification.label, scores: classification.scores,
      explanation: classification.explanation,
      primaryTimeframe: classification.primaryTimeframe,
    },
    tradeContext: {
      trendAlignment: tradeCtx.trendAlignment,
      tradeLabel: tradeCtx.tradeLabel,
    },
    keyLevels,
    alerts: { insertedCount: insertedAlerts.length, types: insertedAlerts.map((x) => x.alertType) },
    safety: SAFETY_ENVELOPE,
  });
});

export default router;
