// AI Strategy Brain HTTP surface.
//
// SAFETY: every response is tagged dataSource="SIMULATOR".
// Mutating endpoints (replay start/stop/step) require ADMIN.
// No code path here calls placeLiveOrderGuarded() or touches live_positions /
// mt5_commands.
import { Router, type Request, type Response, type NextFunction } from "express";
import { readRoleFromRequest, requireAdmin } from "../lib/security/middleware.js";
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
import { eq } from "drizzle-orm";

const router = Router();

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

type JournalRow = typeof tradeJournalTable.$inferSelect;
/** A journal row whose trade has a known result: BUY/SELL with a finite P&L. */
function hasRecordedOutcome(j: JournalRow): j is JournalRow & { pnl: number } {
  return j.direction !== "WAIT" && typeof j.pnl === "number" && Number.isFinite(j.pnl);
}

/** A mistake tag that names a mistake ("None" / blank are not mistakes). */
function realMistakeTag(tag: string | null | undefined): string | null {
  const t = (tag ?? "").trim();
  return t && t.toLowerCase() !== "none" ? t : null;
}

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

    const wins = journal.filter((j) => (j.pnl ?? 0) > 0).length;
    const losses = journal.filter((j) => (j.pnl ?? 0) < 0).length;
    const total = journal.length;
    const winRate = total ? Math.round((wins / total) * 100) : 0;
    const pnl = journal.reduce((a, j) => a + (j.pnl ?? 0), 0);
    // Entries whose P&L is actually known. totalPnl above treats a missing P&L
    // as 0, so the client needs this count to tell "net $0" from "unknown".
    const tradesWithRecordedPnl = journal.filter(hasRecordedOutcome).length;

    // Best/worst symbol rank recorded results only (a missing P&L is
    // unknown, not 0). "Best" must be net profitable and "worst" net losing,
    // so one symbol is never both and a losing symbol is never "strongest".
    const bySymbol = new Map<string, { count: number; pnl: number }>();
    for (const j of journal.filter(hasRecordedOutcome)) {
      const k = j.symbol;
      const cur = bySymbol.get(k) ?? { count: 0, pnl: 0 };
      cur.count++; cur.pnl += j.pnl;
      bySymbol.set(k, cur);
    }
    const symRows = Array.from(bySymbol.entries()).map(([symbol, v]) => ({ symbol, ...v }));
    const topSym = [...symRows].sort((a, b) => b.pnl - a.pnl)[0];
    const lowSym = [...symRows].sort((a, b) => a.pnl - b.pnl)[0];
    const bestSymbol = topSym && topSym.pnl > 0 ? topSym.symbol : null;
    const worstSymbol = lowSym && lowSym.pnl < 0 ? lowSym.symbol : null;

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
    // Untagged rows and the explicit "None" tag are not a mistake pattern.
    for (const j of journal) {
      const tag = realMistakeTag(j.mistakeTag);
      if (tag) mistakeDist.set(tag, (mistakeDist.get(tag) ?? 0) + 1);
    }

    // Source truth: this handler reads ONLY trade_journal. That table has no
    // environment column, so every entry is reported in one JOURNAL bucket
    // (never filed under PAPER), and the other environments — which this
    // handler does not read — carry an unknown (null) count, not a zero.
    return res.json({
      environments: {
        JOURNAL: {
          trades: total, wins, losses, winRate, pnl: Math.round(pnl * 100) / 100,
          note: "All your journal entries. Journal entries record no environment, so paper, demo and live are not separated here.",
        },
        DEMO_SIMULATOR: { trades: null, note: "Not read by this report — demo simulator results are kept in a separate table." },
        LIVE_TESTER_INTENT: { trades: null, note: "Not read by this report — live intents are not tracked per user." },
        REAL_BROKER: { trades: null, status: "Not read by this report — real broker execution is deferred and has never executed." },
      },
      headline: { winRate, totalPnl: Math.round(pnl * 100) / 100, totalTrades: total, tradesWithRecordedPnl },
      bestSymbol, worstSymbol,
      strategyRanking,
      mistakeDistribution: Object.fromEntries(mistakeDist),
      gradeDistribution: { note: "Grades computed on-demand via /api/ai/grade-trade" },
      dataSource: "TRADE_JOURNAL",
      dataSourceLabel: "your trade journal entries",
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
        confidenceCalibration: "No trades yet — confidence cannot be calibrated.",
        dataSource: "SIMULATOR",
        perUserScoped: true,
        generatedAt: new Date().toISOString(),
      });
    }
    const total = journal.length;
    // Only rows with a recorded P&L on an actual BUY/SELL have an outcome.
    // WAIT rows are decisions not to trade; rows with no P&L are undecided.
    // Neither is a loss, so neither enters the win-rate denominator (same
    // "decided" basis as the scalp journal).
    const outcomes = journal.filter(hasRecordedOutcome);
    const wins = outcomes.filter((j) => j.pnl > 0).length;
    const losses = outcomes.filter((j) => j.pnl < 0).length;
    const decided = wins + losses;
    const withoutOutcome = total - outcomes.length;
    const winRate: number | null = decided ? Math.round((wins / decided) * 100) : null;
    const excludedNote = withoutOutcome > 0
      ? ` (${withoutOutcome} journal ${withoutOutcome === 1 ? "entry" : "entries"} with no result — WAIT or no P&L entered — not counted)`
      : "";

    const bySymbol = new Map<string, number>();
    const byStrategy = new Map<string, number>();
    const byMistake = new Map<string, number>();
    // Rank on recorded results only — a missing P&L is unknown, not 0.
    for (const j of outcomes) {
      bySymbol.set(j.symbol, (bySymbol.get(j.symbol) ?? 0) + j.pnl);
      byStrategy.set(j.strategy, (byStrategy.get(j.strategy) ?? 0) + j.pnl);
    }
    for (const j of journal) {
      const tag = realMistakeTag(j.mistakeTag);
      if (tag) byMistake.set(tag, (byMistake.get(tag) ?? 0) + 1);
    }
    const sorted = (m: Map<string, number>, asc = false) =>
      Array.from(m.entries()).sort((a, b) => asc ? a[1] - b[1] : b[1] - a[1]);
    // "Best" must be net profitable and "worst" net losing, so one key is
    // never both, and a profitable strategy is never told to stop.
    const bestOf = (m: Map<string, number>) => { const top = sorted(m)[0]; return top && top[1] > 0 ? top[0] : null; };
    const worstOf = (m: Map<string, number>) => { const low = sorted(m, true)[0]; return low && low[1] < 0 ? low[0] : null; };

    const bestStrat = bestOf(byStrategy);
    const worstStrat = worstOf(byStrategy);
    const bestSym = bestOf(bySymbol);
    const worstSym = worstOf(bySymbol);
    const topMistake = sorted(byMistake)[0]?.[0] ?? "none";

    // Rule suggestions are derived ONLY from what the journal records
    // (mistake tags, strategy and symbol P/L) and cite the observed numbers.
    // A journal with no repeated mistake and no net-losing strategy/symbol
    // gets no suggestions rather than generic defaults.
    const countByStrategy = new Map<string, number>();
    const countBySymbol = new Map<string, number>();
    for (const j of journal) {
      countByStrategy.set(j.strategy, (countByStrategy.get(j.strategy) ?? 0) + 1);
      countBySymbol.set(j.symbol, (countBySymbol.get(j.symbol) ?? 0) + 1);
    }
    const money2 = (n: number) => (n < 0 ? "-" : "+") + Math.abs(Math.round(n * 100) / 100).toFixed(2);
    const suggestedRuleChanges: string[] = [];
    const topMistakeCount = topMistake !== "none" ? (byMistake.get(topMistake) ?? 0) : 0;
    if (topMistakeCount >= 2) {
      suggestedRuleChanges.push(
        `Add a pre-trade check against "${topMistake}" — tagged on ${topMistakeCount} of your ${total} journal entries.`);
    }
    const losingStrat = sorted(byStrategy, true)[0];
    if (losingStrat && losingStrat[1] < 0) {
      suggestedRuleChanges.push(
        `Pause "${losingStrat[0]}" — net ${money2(losingStrat[1])} across ${countByStrategy.get(losingStrat[0]) ?? 0} journal entries.`);
    }
    const losingSym = sorted(bySymbol, true)[0];
    if (losingSym && losingSym[1] < 0) {
      suggestedRuleChanges.push(
        `Reduce size on ${losingSym[0]} — net ${money2(losingSym[1])} across ${countBySymbol.get(losingSym[0]) ?? 0} journal entries.`);
    }

    return res.json({
      doingWell: winRate == null
        ? `None of your ${total} journal ${total === 1 ? "entry has" : "entries have"} a recorded win or loss yet, so there is no win rate to report. Enter the P&L on closed trades to build one.`
        : winRate >= 50
          ? `Win rate ${winRate}% across ${decided} simulated trades with a recorded result${excludedNote} — keep the same selection criteria.`
          : `${wins} winners out of ${decided} simulated trades with a recorded result${excludedNote} — discipline before frequency.`,
      winRate,
      tradesWithOutcome: decided,
      entriesWithoutOutcome: withoutOutcome,
      doingPoorly: topMistake !== "none"
        ? `Most common mistake: "${topMistake}". Add a pre-trade check that blocks this case.`
        : "No clear pattern of mistakes yet — log more trades.",
      bestStrategy: bestStrat, worstStrategy: worstStrat,
      bestSymbol: bestSym, weakestSymbol: worstSym,
      mostCommonMistake: topMistake,
      recommendedFocus: worstStrat
        ? `Stop trading "${worstStrat}" until you can show 5 paper wins on it in replay.`
        : "No strategy shows a net loss in your recorded results. Pick one strategy and run 10 replays before taking any live intent.",
      suggestedRuleChanges,
      // trade_journal records no confidence score, so calibration (confidence
      // vs. outcome) is never measured here. Say so instead of comparing the
      // win rate with a constant.
      confidenceCalibration:
        "Confidence calibration not measured — your journal entries do not record a confidence score to compare with your win rate.",
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
