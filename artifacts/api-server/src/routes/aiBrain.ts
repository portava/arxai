// AI Strategy Brain HTTP surface.
//
// SAFETY: every response is tagged dataSource="SIMULATOR".
// Mutating endpoints (replay start/stop/step) require ADMIN.
// No code path here calls placeLiveOrderGuarded() or touches live_positions /
// mt5_commands.
import { Router, type Request, type Response, type NextFunction } from "express";
import { readRoleFromRequest } from "../lib/security/middleware.js";
import {
  viewerSeesSimulatorDetail,
  maskSimulatorMarketAnalysis,
  maskSimulatorTradeCard,
  maskSimulatorEntrySniperScore,
  maskSimulatorTradeGrade,
} from "../lib/honesty/feedTruthCopy.js";

import { z } from "zod/v4";
import {
  analyzeMarket, generateTradeCard, gradeTrade, entrySniperScore,
  replayStart, replayStep, replayStop, replayGet, tradingStyles,
} from "../lib/aiBrain.js";
import { requireUser } from "../lib/auth/middleware.js";
import {
  deriveRuleChanges,
  GENERAL_COACH_RULES,
  CONFIDENCE_NOT_MEASURED_NOTE,
} from "../lib/coach/coachRules.js";

export {
  deriveRuleChanges,
  GENERAL_COACH_RULES,
  CONFIDENCE_NOT_MEASURED_NOTE,
  type DerivedRuleChange,
} from "../lib/coach/coachRules.js";
import { eq } from "drizzle-orm";

const router = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const role = readRoleFromRequest(req);
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ error: "Forbidden", requiredRole: "ADMIN" });
    return;
  }
  next();
}

const SymbolBody = z.object({
  symbol: z.string().min(1),
  timeframe: z.string().optional(),
});

// SAFETY (Task #573): these four /ai/* reads are 100% simulator-derived scored
// analysis. They obey the SAME role gate as the scanner rows — ADMIN/OWNER see
// full simulator detail; everyone else gets the scores withheld behind the
// honest "Waiting for verified feed" state. No live data is ever masked here
// (nothing on these routes is live), and no gate/role source changes.
router.post("/ai/market-analysis", (req, res) => {
  const p = SymbolBody.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "symbol required" });
  const a = analyzeMarket(p.data.symbol, p.data.timeframe);
  return res.json(viewerSeesSimulatorDetail(readRoleFromRequest(req)) ? a : maskSimulatorMarketAnalysis(a));
});

router.post("/ai/generate-trade-card", (req, res) => {
  const Body = SymbolBody.extend({ maxRiskUsd: z.number().positive().optional() });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "symbol required" });
  const card = generateTradeCard(p.data.symbol, p.data.timeframe, p.data.maxRiskUsd);
  return res.json(viewerSeesSimulatorDetail(readRoleFromRequest(req)) ? card : maskSimulatorTradeCard(card));
});

router.post("/ai/entry-sniper-score", (req, res) => {
  const Body = z.object({
    symbol: z.string(), direction: z.enum(["BUY", "SELL"]),
    entryPrice: z.number(), stopLoss: z.number().optional(), takeProfit: z.number().optional(),
  });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "symbol/direction/entryPrice required" });
  const s = entrySniperScore(p.data);
  return res.json(viewerSeesSimulatorDetail(readRoleFromRequest(req)) ? s : maskSimulatorEntrySniperScore(s));
});

router.post("/ai/grade-trade", (req, res) => {
  const Body = z.object({
    symbol: z.string(), direction: z.enum(["BUY", "SELL"]), entryPrice: z.number(),
    stopLoss: z.number().optional(), takeProfit: z.number().optional(),
    lotSize: z.number().optional(), confidenceScore: z.number().optional(),
    reason: z.string().optional(),
  });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "symbol/direction/entryPrice required" });
  const g = gradeTrade(p.data);
  return res.json(viewerSeesSimulatorDetail(readRoleFromRequest(req)) ? g : maskSimulatorTradeGrade(g));
});

router.get("/ai/trading-styles", (_req, res) => res.json({ styles: tradingStyles }));

// ── Market Replay (in-memory, simulator-backed) ────────────────────────────
router.post("/market-replay/start", requireAdmin, (req, res) => {
  const Body = z.object({
    symbol: z.string(), timeframe: z.string().optional(), strategy: z.string().optional(),
  });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "symbol required" });
  return res.json(replayStart(p.data.symbol, p.data.timeframe, p.data.strategy));
});
router.post("/market-replay/step", requireAdmin, (req, res) => {
  const Body = z.object({ replayId: z.string(), humanAction: z.string().optional() });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "replayId required" });
  const r = replayStep(p.data.replayId, p.data.humanAction);
  if (!r) return res.status(404).json({ error: "replay not found" });
  return res.json(r);
});
router.post("/market-replay/stop", requireAdmin, (req, res) => {
  const Body = z.object({ replayId: z.string() });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "replayId required" });
  const r = replayStop(p.data.replayId);
  if (!r) return res.status(404).json({ error: "replay not found" });
  return res.json(r);
});
router.get("/market-replay/:id", (req, res) => {
  const r = replayGet(req.params.id);
  if (!r) return res.status(404).json({ error: "replay not found" });
  return res.json(r);
});

// ── Performance scorecard + learning extras (read-only aggregates) ─────────
import { db, tradeJournalTable, liveIntentsTable, learningInsightsTable } from "@workspace/db";
import { sql } from "drizzle-orm";

// Phase 25 — Per-user scope. Was previously reading ALL users' journal rows
// and returning them to any authed caller (cross-user leak). Now filtered by
// req.authUser.id and gated by requireUser. liveIntentsTable has no ownership
// column today, so per-user intent count is honestly reported as 0 with a
// "ownership-not-tracked" note rather than leaking the system-wide total.
router.get("/performance/scorecard", requireUser, async (req, res) => {
  try {
    const userId = req.authUser!.id;
    const journal = await db.select().from(tradeJournalTable)
      .where(eq(tradeJournalTable.userId, userId));
    const intents: never[] = [];

    const wins = journal.filter((j) => (j.pnl ?? 0) > 0).length;
    const losses = journal.filter((j) => (j.pnl ?? 0) < 0).length;
    const total = journal.length;
    const winRate = total ? Math.round((wins / total) * 100) : 0;
    const pnl = journal.reduce((a, j) => a + (j.pnl ?? 0), 0);

    const bySymbol = new Map<string, { count: number; pnl: number }>();
    for (const j of journal) {
      const k = j.symbol;
      const cur = bySymbol.get(k) ?? { count: 0, pnl: 0 };
      cur.count++; cur.pnl += j.pnl ?? 0;
      bySymbol.set(k, cur);
    }
    const symRows = Array.from(bySymbol.entries()).map(([symbol, v]) => ({ symbol, ...v }));
    const bestSymbol = symRows.sort((a, b) => b.pnl - a.pnl)[0]?.symbol ?? null;
    const worstSymbol = symRows.sort((a, b) => a.pnl - b.pnl)[0]?.symbol ?? null;

    const byStrategy = new Map<string, { count: number; pnl: number }>();
    for (const j of journal) {
      const k = j.strategy;
      const cur = byStrategy.get(k) ?? { count: 0, pnl: 0 };
      cur.count++; cur.pnl += j.pnl ?? 0;
      byStrategy.set(k, cur);
    }
    const strategyRanking = Array.from(byStrategy.entries())
      .map(([strategy, v]) => ({ strategy, ...v }))
      .sort((a, b) => b.pnl - a.pnl);

    const mistakeDist = new Map<string, number>();
    for (const j of journal) {
      const tag = j.mistakeTag ?? "none";
      mistakeDist.set(tag, (mistakeDist.get(tag) ?? 0) + 1);
    }

    return res.json({
      environments: {
        PAPER: { trades: total, wins, losses, winRate, pnl: Math.round(pnl * 100) / 100 },
        DEMO_SIMULATOR: { trades: 0, note: "Demo simulator results stored in paper-execution table." },
        LIVE_TESTER_INTENT: { trades: intents.length, note: "Intent rows only — not executed." },
        REAL_BROKER: { trades: 0, status: "MT5_DEFERRED — never executed" },
      },
      headline: { winRate, totalPnl: Math.round(pnl * 100) / 100, totalTrades: total },
      bestSymbol, worstSymbol,
      strategyRanking,
      mistakeDistribution: Object.fromEntries(mistakeDist),
      gradeDistribution: { note: "Grades computed on-demand via /api/ai/grade-trade" },
      dataSource: "SIMULATOR_AND_TESTER_INTENTS",
      perUserScoped: true,
      intentsNote: "Live-intent count not shown — liveIntentsTable has no per-user ownership column.",
      isEmpty: total === 0,
      emptyMessage: total === 0 ? "No journal entries yet. Add a paper trade or journal entry to start building your scorecard." : undefined,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// Phase 25 — Per-user scope. Was leaking system-wide journal + insights.
router.get("/learning/performance", requireUser, async (req, res) => {
  try {
    const userId = req.authUser!.id;
    const insights = await db.select().from(learningInsightsTable)
      .where(eq(learningInsightsTable.userId, userId)).limit(50);
    const journal = await db.select().from(tradeJournalTable)
      .where(eq(tradeJournalTable.userId, userId));
    const total = journal.length;
    const wins = journal.filter((j) => (j.pnl ?? 0) > 0).length;
    return res.json({
      totalTrades: total, wins, losses: total - wins,
      winRate: total ? Math.round((wins / total) * 100) : 0,
      insightCount: insights.length,
      strengths: insights.filter((i) => i.insightType === "STRENGTH").length,
      weaknesses: insights.filter((i) => i.insightType === "WEAKNESS").length,
      patterns: insights.filter((i) => i.insightType === "PATTERN").length,
      dataSource: "SIMULATOR",
    });
  } catch (e) { return res.status(500).json({ error: String(e) }); }
});

// Phase 25 — Per-user scope. Was leaking system-wide insights.
router.get("/learning/recommendations", requireUser, async (req, res) => {
  try {
    const userId = req.authUser!.id;
    const insights = await db.select().from(learningInsightsTable)
      .where(eq(learningInsightsTable.userId, userId)).limit(20);
    const recs = insights
      .filter((i) => i.recommendation)
      .map((i) => ({
        id: i.id, insightType: i.insightType, symbol: i.symbol,
        strategy: i.strategy, recommendation: i.recommendation, strength: i.strength,
      }));
    if (recs.length === 0) {
      recs.push({
        id: 0, insightType: "PATTERN", symbol: null, strategy: null,
        recommendation: "Run more demo trades and journal entries to generate personalized recommendations.",
        strength: 50,
      } as typeof recs[number]);
    }
    return res.json({ recommendations: recs, dataSource: "SIMULATOR" });
  } catch (e) { return res.status(500).json({ error: String(e) }); }
});

// Phase 25 — Per-user scope. Was leaking the entire journal table across
// all users (the coach was literally summarising other users' mistakes back
// to the caller). Now filtered to req.authUser.id with an honest empty state.
router.get("/ai/coach-summary", requireUser, async (req, res) => {
  try {
    const userId = req.authUser!.id;
    const journal = await db.select().from(tradeJournalTable)
      .where(eq(tradeJournalTable.userId, userId));
    if (journal.length === 0) {
      return res.json({
        isEmpty: true,
        doingWell: "Not enough journal data yet — log a few paper trades to build your scorecard.",
        doingPoorly: "Not enough journal data yet.",
        bestStrategy: null, worstStrategy: null,
        bestSymbol: null, weakestSymbol: null,
        mostCommonMistake: "none",
        recommendedFocus: "Place a paper trade and add a journal note to begin.",
        suggestedRuleChanges: [],
        generalRules: GENERAL_COACH_RULES,
        confidenceCalibrationAvailable: false,
        confidenceCalibrationNote: CONFIDENCE_NOT_MEASURED_NOTE,
        dataSource: "SIMULATOR",
        perUserScoped: true,
        generatedAt: new Date().toISOString(),
      });
    }
    const total = journal.length;
    const wins = journal.filter((j) => (j.pnl ?? 0) > 0).length;
    const winRate = total ? Math.round((wins / total) * 100) : 0;

    const bySymbol = new Map<string, number>();
    const byStrategy = new Map<string, number>();
    const byMistake = new Map<string, number>();
    for (const j of journal) {
      bySymbol.set(j.symbol, (bySymbol.get(j.symbol) ?? 0) + (j.pnl ?? 0));
      byStrategy.set(j.strategy, (byStrategy.get(j.strategy) ?? 0) + (j.pnl ?? 0));
      if (j.mistakeTag) byMistake.set(j.mistakeTag, (byMistake.get(j.mistakeTag) ?? 0) + 1);
    }
    const sorted = (m: Map<string, number>, asc = false) =>
      Array.from(m.entries()).sort((a, b) => asc ? a[1] - b[1] : b[1] - a[1]);

    const bestStrat = sorted(byStrategy)[0]?.[0] ?? null;
    const worstStrat = sorted(byStrategy, true)[0]?.[0] ?? null;
    const bestSym = sorted(bySymbol)[0]?.[0] ?? null;
    const worstSym = sorted(bySymbol, true)[0]?.[0] ?? null;
    const topMistake = sorted(byMistake)[0]?.[0] ?? "none";

    return res.json({
      doingWell: winRate >= 50
        ? `Win rate ${winRate}% across ${total} simulated trades — keep the same selection criteria.`
        : `${wins} winners out of ${total} so far — discipline before frequency.`,
      doingPoorly: topMistake !== "none"
        ? `Most common mistake: "${topMistake}". Add a pre-trade check that blocks this case.`
        : "No clear pattern of mistakes yet — log more trades.",
      bestStrategy: bestStrat, worstStrategy: worstStrat,
      bestSymbol: bestSym, weakestSymbol: worstSym,
      mostCommonMistake: topMistake,
      recommendedFocus: worstStrat
        ? `Stop trading "${worstStrat}" until you can show 5 paper wins on it in replay.`
        : "Pick one strategy and run 10 replays before taking any live intent.",
      // HONESTY: `suggestedRuleChanges` used to be this same three-element
      // literal returned to every caller under a heading that reads as
      // personalised analysis. The fixed list is now labelled `generalRules`
      // (it IS general — that is fine, said plainly), and
      // `suggestedRuleChanges` carries only rules derived from THIS caller's
      // journal, each with the evidence it came from. Empty when the journal
      // does not support any.
      suggestedRuleChanges: deriveRuleChanges({ byMistake, byStrategy, bySymbol, total }),
      generalRules: GENERAL_COACH_RULES,
      // HONESTY: this used to emit "Average confidence aligns with win rate
      // within N pts" from |winRate − 60| — a magic constant, not a
      // measurement. `trade_journal` has no confidence column, so no
      // confidence value exists to calibrate against. Say so.
      confidenceCalibrationAvailable: false,
      confidenceCalibrationNote: CONFIDENCE_NOT_MEASURED_NOTE,
      dataSource: "SIMULATOR",
      generatedAt: new Date().toISOString(),
    });
  } catch (e) { return res.status(500).json({ error: String(e) }); }
});

// ── Strategies CRUD by id (existing /strategies has only GET/PATCH/reset) ──
import { strategiesTable } from "@workspace/db";
router.get("/strategies/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const rows = await db.select().from(strategiesTable).where(sql`${strategiesTable.id} = ${id}`);
    if (!rows.length) return res.status(404).json({ error: "not found" });
    return res.json(rows[0]);
  } catch (e) { return res.status(500).json({ error: String(e) }); }
});
router.post("/strategies", requireAdmin, async (req, res) => {
  try {
    const Body = z.object({
      name: z.string().min(1), description: z.string().default(""),
      enabled: z.boolean().default(true), parameters: z.unknown().optional(),
    });
    const p = Body.safeParse(req.body ?? {});
    if (!p.success) return res.status(400).json({ error: "name required" });
    const [row] = await db.insert(strategiesTable).values({
      name: p.data.name, description: p.data.description,
      enabled: p.data.enabled, parameters: p.data.parameters as never,
    }).returning();
    return res.status(201).json(row);
  } catch (e) { return res.status(500).json({ error: String(e) }); }
});
router.delete("/strategies/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await db.delete(strategiesTable).where(sql`${strategiesTable.id} = ${id}`);
    return res.json({ ok: true, id });
  } catch (e) { return res.status(500).json({ error: String(e) }); }
});

export default router;
