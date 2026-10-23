// Build CC — Learning Feedback Engine routes.
//
// SAFETY: read/process only. None of these endpoints place trades, mutate
// safetyCore, or touch live broker surfaces.

import { Router, type Response } from "express";
import { z } from "zod/v4";
import { db, tradesTable, type Trade } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import {
  GetLearningInsightsResponse,
  GetCoachExplanationResponse,
  ApplyConservativeImprovementsResponse,
} from "@workspace/api-zod";
import { requireUser } from "../lib/auth/middleware.js";
import { analyzeTradeOutcome, type TradeOutcomeInput } from "../lib/aiLearning/tradeOutcomeAnalyzer.js";
import { optimizeStrategies } from "../lib/aiLearning/strategyOptimizer.js";
import {
  processLearningPayload,
  getSymbolLearningView,
  listLearningEvents,
  listEdges,
  listMistakes,
  type LearningPayload,
} from "../lib/learningEngine.js";

const router: Router = Router();

const DISCLAIMER =
  "Learning data is reflective and bounded. It informs scoring but never overrides safety blockers, " +
  "kill-switch, risk locks, or the canPlaceTrades gate.";

function ok(res: Response, body: Record<string, unknown>) {
  return res.json({ ...body, system: "learning", disclaimer: DISCLAIMER });
}
function fail(res: Response, status: number, error: string) {
  return res.status(status).json({ error, system: "learning", disclaimer: DISCLAIMER });
}

// ── Schemas ────────────────────────────────────────────────────────────────
const SignalSchema = z.object({
  source: z.string(),
  status: z.string(),
  score: z.number(),
  detail: z.string().optional(),
});
const PayloadSchema = z.object({
  trade_id: z.number().int(),
  decision_id: z.number().int().nullable().optional().default(null),
  result: z.string(),
  pnl: z.number().default(0),
  pnl_percent: z.number().optional(),
  symbol: z.string().optional(),
  action: z.string().optional(),
  mistake_tags: z.array(z.string()).optional().default([]),
  lesson: z.string().optional().default(""),
  confidence_before_trade: z.number().nullable().optional().default(null),
  risk_score_before_trade: z.number().nullable().optional().default(null),
  signals_used: z.array(SignalSchema).optional().default([]),
  debrief_id: z.number().int(),
  ready_for_learning: z.boolean().default(true),
});

// POST /api/learning/process — accepts a Build BB learning payload.
router.post("/learning/process", async (req, res): Promise<void> => {
  try {
    const parsed = PayloadSchema.safeParse(req.body ?? {});
    if (!parsed.success) { fail(res, 400, "Invalid payload: " + parsed.error.message); return; }
    const result = await processLearningPayload(parsed.data as unknown as LearningPayload);
    ok(res, { result });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "POST /learning/process failed");
    fail(res, 500, "Failed to process learning payload");
  }
});

// GET /api/learning/events?limit=10
router.get("/learning/events", async (req, res): Promise<void> => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 10)));
    const events = await listLearningEvents(limit);
    ok(res, { count: events.length, events });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /learning/events failed");
    fail(res, 500, "Failed to list learning events");
  }
});

// GET /api/learning/edges?symbol=...
router.get("/learning/edges", async (req, res): Promise<void> => {
  try {
    const symbol = typeof req.query.symbol === "string" && req.query.symbol.length > 0 ? req.query.symbol : undefined;
    const edges = await listEdges(symbol);
    ok(res, { count: edges.length, symbol: symbol ?? null, edges });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /learning/edges failed");
    fail(res, 500, "Failed to list strategy edges");
  }
});

// GET /api/learning/mistakes?symbol=...
router.get("/learning/mistakes", async (req, res): Promise<void> => {
  try {
    const symbol = typeof req.query.symbol === "string" && req.query.symbol.length > 0 ? req.query.symbol : undefined;
    const mistakes = await listMistakes(symbol);
    ok(res, { count: mistakes.length, symbol: symbol ?? null, mistakes });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /learning/mistakes failed");
    fail(res, 500, "Failed to list mistake patterns");
  }
});

// GET /api/learning/view?symbol=...&action=BUY — what AA will see for the next decision.
router.get("/learning/view", async (req, res): Promise<void> => {
  try {
    const symbol = String(req.query.symbol ?? "Volatility 75 Index");
    const action = String(req.query.action ?? "BUY").toUpperCase() as "BUY" | "SELL" | "HOLD";
    if (!["BUY", "SELL", "HOLD"].includes(action)) { fail(res, 400, "action must be BUY|SELL|HOLD"); return; }
    const view = await getSymbolLearningView(symbol, action);
    ok(res, { view });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /learning/view failed");
    fail(res, 500, "Failed to compute learning view");
  }
});

// POST /api/learning/demo — synthesize a payload to prove the loop end-to-end.
const DemoBody = z.object({
  symbol: z.string().default("Volatility 75 Index"),
  action: z.enum(["BUY", "SELL"]).default("BUY"),
  result: z.enum(["WIN", "LOSS", "BREAKEVEN", "CANCELLED"]).default("WIN"),
  pnl: z.number().optional(),
  mistakeTags: z.array(z.string()).optional().default([]),
});
router.post("/learning/demo", async (req, res): Promise<void> => {
  try {
    const parsed = DemoBody.safeParse(req.body ?? {});
    if (!parsed.success) { fail(res, 400, "Invalid demo body: " + parsed.error.message); return; }
    const { symbol, action, result, mistakeTags } = parsed.data;
    const pnl = parsed.data.pnl ?? (result === "WIN" ? 12 : result === "LOSS" ? -8 : 0);
    // Keep IDs inside int32. Use offset > real-row range to avoid collisions.
    const fakeDebriefId = 2_000_000_000 + Math.floor(Math.random() * 100_000_000);
    const fakeTradeId   = 1_900_000_000 + Math.floor(Math.random() * 100_000_000);
    const payload: LearningPayload = {
      trade_id: fakeTradeId, decision_id: null, debrief_id: fakeDebriefId,
      result, pnl, pnl_percent: pnl, symbol, action,
      confidence_before_trade: result === "WIN" ? 78 : 64,
      risk_score_before_trade: result === "LOSS" ? 75 : 35,
      signals_used: [
        { source: "strategyEngine", status: "PASS", score: 32, detail: "demo signal" },
        { source: "session",        status: "PASS", score: 5,  detail: "demo session" },
        { source: "edge",           status: "PASS", score: 7,  detail: "demo edge" },
      ],
      mistake_tags: result === "LOSS" ? (mistakeTags.length ? mistakeTags : ["EXITED_TOO_QUICKLY"]) : [],
      lesson: `Demo ${result}`, ready_for_learning: true,
    };
    const learning = await processLearningPayload(payload);
    const view = await getSymbolLearningView(symbol, action);
    ok(res, { demoPayload: payload, learning, viewAfter: view });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "POST /learning/demo failed");
    fail(res, 500, "Failed to run learning demo");
  }
});

// ── Per-user insights & coaching (spec: getLearningInsights,
//    getCoachExplanation, applyConservativeImprovements) ────────────────────
//
// HONESTY (Theme A3): the `trades` table records no close price and no market
// context (session, chop, news, volatility). Nothing below cites an exit
// price, assumes a winner closed at TP or a loser at SL, or invents market
// conditions. Closed rows without a trustworthy P/L (pnl null, or pnlStatus
// "UNKNOWN" — see lib/db schema/trades.ts) are excluded from every aggregate
// and disclosed, never estimated.

type ClosedTradeWithPnl = Trade & { pnl: number };

function hasTrustworthyPnl(t: Trade): t is ClosedTradeWithPnl {
  return t.pnl != null && t.pnlStatus !== "UNKNOWN";
}

function holdMinutes(t: Trade): number | undefined {
  if (!t.createdAt || !t.closedAt) return undefined;
  return Math.round((t.closedAt.getTime() - t.createdAt.getTime()) / 60_000);
}

function toAnalyzerInput(t: ClosedTradeWithPnl): TradeOutcomeInput {
  // Only fields the row actually records. `trades` carries no session, market
  // condition, news, or volatility context — none is supplied, so the
  // analyzer can never emit tags that depend on them.
  return {
    symbol: t.symbol,
    strategy: t.strategy,
    confidence: t.confidence,
    entry: t.entryPrice,
    stopLoss: t.stopLoss,
    takeProfit: t.takeProfit,
    profitLoss: t.pnl,
    holdTimeMinutes: holdMinutes(t),
  };
}

function entryLine(t: Trade): string {
  return `${t.direction} ${t.symbol} ${t.lot} lots at ${t.entryPrice} — ${t.strategy}, confidence ${t.confidence}%`;
}

function geometryLine(t: Trade): string {
  const risk = Math.abs(t.entryPrice - t.stopLoss);
  const rr = risk > 0 ? Math.abs(t.takeProfit - t.entryPrice) / risk : 0;
  return `Recorded entry ${t.entryPrice}, stop ${t.stopLoss}, target ${t.takeProfit} — risk:reward ${rr.toFixed(2)} at ${t.confidence}% confidence.`;
}

// The record carries no market-condition fields, so this is a constant honest
// refusal rather than invented chop/news/volatility advice.
const NO_MARKET_CONTEXT =
  "This trade record carries no market-condition, news, or volatility data, so no avoidance rule can be evidenced from it.";

function buildCoachExplanation(t: Trade): {
  whatHappened: string; setupValid: string; whatCouldBeBetter: string;
  strategyAdjustment: string; marketAvoidance: string;
} {
  if (t.status === "OPEN") {
    return {
      whatHappened: `${entryLine(t)}. Still open — there is no outcome to explain yet.`,
      setupValid: geometryLine(t),
      whatCouldBeBetter: "The trade has not completed; outcome-based coaching would be guesswork, so none is offered yet.",
      strategyAdjustment: "No adjustment is suggested from a trade that has not finished.",
      marketAvoidance: NO_MARKET_CONTEXT,
    };
  }
  if (t.status === "CANCELLED") {
    return {
      whatHappened: `${entryLine(t)}. Cancelled — it never completed, so there is no outcome to explain.`,
      setupValid: geometryLine(t),
      whatCouldBeBetter: "A cancelled trade carries no outcome evidence.",
      strategyAdjustment: "No adjustment — nothing was risked or realized.",
      marketAvoidance: NO_MARKET_CONTEXT,
    };
  }
  if (!hasTrustworthyPnl(t)) {
    const why = t.pnlStatus === "UNKNOWN" ? "its P/L is marked UNKNOWN" : "no P/L was recorded";
    return {
      whatHappened: `${entryLine(t)}. Recorded as a ${t.status === "CLOSED_WIN" ? "win" : "loss"}, but ${why} — no figure is claimed.`,
      setupValid: geometryLine(t),
      whatCouldBeBetter: "Without a trustworthy P/L, outcome-based coaching would be guesswork; only the recorded entry geometry can be assessed.",
      strategyAdjustment: "No adjustment can be evidenced without a recorded P/L for this trade.",
      marketAvoidance: NO_MARKET_CONTEXT,
    };
  }
  const r = analyzeTradeOutcome(toAnalyzerInput(t));
  const held = holdMinutes(t);
  const pnlText = t.pnl >= 0 ? `+${t.pnl.toFixed(2)}` : t.pnl.toFixed(2);
  const evidence =
    (r.successTags.length > 0 ? ` Supporting evidence: ${r.successTags.join(", ")}.` : "") +
    (r.mistakeTags.length > 0 ? ` Working against it: ${r.mistakeTags.join(", ")}.` : "");
  return {
    whatHappened:
      `${entryLine(t)}. Closed as a ${r.outcome} with P/L ${pnlText}` +
      `${held != null ? ` after ${held} minutes` : ""}. ` +
      "The record carries no close price, so none is quoted.",
    setupValid: geometryLine(t) + (evidence || " No further setup evidence in this record."),
    whatCouldBeBetter: r.mistakeTags.length > 0
      ? `Evidenced in this record: ${r.mistakeTags.join(", ")}.`
      : "No mistakes are evidenced by this record.",
    strategyAdjustment: r.suggestedAdjustment,
    marketAvoidance: NO_MARKET_CONTEXT,
  };
}

// GET /api/learning/insights — per-user aggregates over real closed trades.
router.get("/learning/insights", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const rows = await db.select().from(tradesTable)
      .where(eq(tradesTable.userId, userId))
      .orderBy(desc(tradesTable.createdAt));
    const closed = rows.filter((t) => t.status === "CLOSED_WIN" || t.status === "CLOSED_LOSS");
    const usable = closed.filter(hasTrustworthyPnl);
    const excluded = closed.length - usable.length;

    const opt = optimizeStrategies(usable);

    const tagCounts = new Map<string, number>();
    const lessons: string[] = [];
    for (const t of usable) {
      const r = analyzeTradeOutcome(toAnalyzerInput(t));
      for (const tag of r.mistakeTags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      if (lessons.length < 8 && !lessons.includes(r.lesson)) lessons.push(r.lesson);
    }
    const commonMistakes = [...tagCounts]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const warningParts: string[] = [];
    if (excluded > 0) {
      warningParts.push(
        `${excluded} closed trade${excluded === 1 ? "" : "s"} excluded: no trustworthy P/L is recorded for ${excluded === 1 ? "it" : "them"}, and none is invented.`,
      );
    }
    if (usable.length === 0) {
      warningParts.push("No closed trades with a recorded P/L yet — insights unlock after your first completed trade.");
    } else if (opt.warning) {
      warningParts.push(opt.warning);
    }

    const payload = GetLearningInsightsResponse.parse({
      sampleSize: usable.length,
      bestStrategies: opt.bestStrategies,
      worstStrategies: opt.worstStrategies,
      bestSymbols: opt.bestSymbols,
      worstSymbols: opt.worstSymbols,
      bestSessions: opt.bestSessions,
      worstSessions: opt.worstSessions,
      recommendedEnabledStrategies: opt.recommendedEnabledStrategies,
      recommendedDisabledStrategies: opt.recommendedDisabledStrategies,
      commonMistakes,
      lessons,
      confidenceAdjustment: opt.confidenceAdjustment,
      riskAdjustment: opt.riskAdjustment,
      warning: warningParts.length > 0 ? warningParts.join(" ") : null,
    });
    ok(res, payload);
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /learning/insights failed");
    fail(res, 500, "Failed to compute learning insights");
  }
});

// GET /api/learning/coach/:tradeId — coach copy for one of the user's trades.
router.get("/learning/coach/:tradeId", requireUser, async (req, res): Promise<void> => {
  try {
    const tradeId = Number(req.params.tradeId);
    if (!Number.isInteger(tradeId) || tradeId <= 0) { fail(res, 400, "tradeId must be a positive integer"); return; }
    const userId = req.authUser!.id;
    // Scoped lookup: another user's trade (or a legacy row with no owner) is
    // indistinguishable from a missing one — both 404.
    const [trade] = await db.select().from(tradesTable)
      .where(and(eq(tradesTable.id, tradeId), eq(tradesTable.userId, userId)))
      .limit(1);
    if (!trade) { fail(res, 404, "Trade not found"); return; }
    ok(res, GetCoachExplanationResponse.parse(buildCoachExplanation(trade)));
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /learning/coach/:tradeId failed");
    fail(res, 500, "Failed to build coach explanation");
  }
});

// POST /api/learning/apply-improvements — the spec's "apply conservative
// improvements" operation. There is no engine-facing store to apply them to:
// bot_settings.enabledStrategies / riskMode are echoed by the /bot routes but
// read by no scanning or execution path, so mutating them would only pretend
// the bot changed behavior. Until a real consumer exists this endpoint
// reports applied:false with a machine-readable reason instead of claiming a
// mutation that has no effect.
router.post("/learning/apply-improvements", requireUser, (req, res): void => {
  try {
    const payload = ApplyConservativeImprovementsResponse.parse({ applied: false, changes: [] });
    ok(res, {
      ...payload,
      reason: "NO_BACKING_STORE",
      detail: "Strategy enable/disable and risk adjustments have no engine-facing store to apply to; no settings were changed.",
    });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "POST /learning/apply-improvements failed");
    fail(res, 500, "Failed to apply improvements");
  }
});

export default router;
