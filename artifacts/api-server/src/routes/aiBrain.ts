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
import { db, tradeJournalTable, tradesTable, learningInsightsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { normaliseTradeMode } from "../lib/performance/tradeScope.js";

// Phase 25 — Per-user scope. Was previously reading ALL users' journal rows
// and returning them to any authed caller (cross-user leak). Now filtered by
// req.authUser.id and gated by requireUser.
//
// The `environments` block used to be hardcoded: every trade_journal row was
// bucketed to PAPER (the table has no environment column), DEMO_SIMULATOR was
// pinned at 0, LIVE_TESTER_INTENT at 0, and REAL_BROKER at the literal
// { trades: 0, status: "MT5_DEFERRED — never executed" } — while the live
// pipeline demonstrably executes and writes broker-realised P/L into
// `trades`. Under a heading that promises "Results are never mixed across
// environments", that read as a verified statement about the user's real
// account. Each row below is now derived from a real source, and rows we
// cannot measure are absent rather than asserted as zero.
//
// Win/loss counting: a journal row with no P/L, and a `WAIT` row (a
// no-trade observation, not a trade), are UNDECIDED — they are excluded from
// the win-rate denominator instead of silently counting as losses. The
// denominator is reported so the page can show it.
router.get("/performance/scorecard", requireUser, async (req, res) => {
  try {
    const userId = req.authUser!.id;
    const journal = await db.select().from(tradeJournalTable)
      .where(eq(tradeJournalTable.userId, userId));

    const isDecided = (j: { pnl: number | null; direction: string }) =>
      typeof j.pnl === "number" && Number.isFinite(j.pnl) &&
      String(j.direction).toUpperCase() !== "WAIT";
    const decided = journal.filter(isDecided);
    const undecided = journal.length - decided.length;

    const wins = decided.filter((j) => (j.pnl ?? 0) > 0).length;
    const losses = decided.filter((j) => (j.pnl ?? 0) < 0).length;
    const total = journal.length;
    const winRate = decided.length ? Math.round((wins / decided.length) * 100) : 0;
    const pnl = decided.reduce((a, j) => a + (j.pnl ?? 0), 0);

    const bySymbol = new Map<string, { count: number; pnl: number }>();
    for (const j of decided) {
      const k = j.symbol;
      const cur = bySymbol.get(k) ?? { count: 0, pnl: 0 };
      cur.count++; cur.pnl += j.pnl ?? 0;
      bySymbol.set(k, cur);
    }
    const symRows = Array.from(bySymbol.entries()).map(([symbol, v]) => ({ symbol, ...v }));
    // With no decided rows there is no best/worst — never crown a symbol on a
    // pile of zeroes.
    const bestSymbol = symRows.length ? symRows.slice().sort((a, b) => b.pnl - a.pnl)[0]!.symbol : null;
    const worstSymbol = symRows.length ? symRows.slice().sort((a, b) => a.pnl - b.pnl)[0]!.symbol : null;

    const byStrategy = new Map<string, { count: number; pnl: number }>();
    for (const j of decided) {
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

    // ── Executed environments, derived from `trades.mode` ────────────────
    const executed = await db.select().from(tradesTable)
      .where(eq(tradesTable.userId, userId));
    function envRow(mode: "DEMO" | "LIVE") {
      const rows = executed.filter(
        (t) => normaliseTradeMode(t.mode) === mode &&
          t.status !== "OPEN" && t.status !== "CANCELLED",
      );
      // pnlStatus="UNKNOWN" — broker never reported a usable close fill.
      const unknown = rows.filter((t) => t.pnlStatus === "UNKNOWN");
      const trusted = rows.filter((t) => t.pnlStatus !== "UNKNOWN");
      const w = trusted.filter((t) => t.status === "CLOSED_WIN").length;
      const l = trusted.filter((t) => t.status === "CLOSED_LOSS").length;
      const p = trusted.reduce((a, t) => a + (t.pnl ?? 0), 0);
      const open = executed.filter(
        (t) => normaliseTradeMode(t.mode) === mode && t.status === "OPEN",
      ).length;
      const notes: string[] = [];
      if (unknown.length > 0) notes.push(`${unknown.length} excluded — P/L unavailable`);
      if (open > 0) notes.push(`${open} still open`);
      return {
        trades: trusted.length,
        wins: w,
        losses: l,
        winRate: trusted.length ? Math.round((w / trusted.length) * 100) : 0,
        pnl: Math.round(p * 100) / 100,
        excludedUnknown: unknown.length,
        openTrades: open,
        source: `trades.mode=${mode}`,
        note: notes.join(" · "),
      };
    }

    return res.json({
      environments: {
        // Journal is a user-written log, not an execution environment; its
        // P/L is whatever the user typed.
        PAPER_JOURNAL: {
          trades: decided.length,
          wins, losses, winRate,
          pnl: Math.round(pnl * 100) / 100,
          source: "trade_journal (self-reported)",
          note: undecided > 0 ? `${undecided} undecided (no P/L or WAIT) not counted` : "",
        },
        DEMO: envRow("DEMO"),
        LIVE: envRow("LIVE"),
      },
      // Headline is the JOURNAL scope only — it is never a sum across
      // environments. The client must not add these rows together.
      headline: {
        scope: "PAPER_JOURNAL",
        winRate,
        wins,
        losses,
        totalPnl: Math.round(pnl * 100) / 100,
        totalTrades: total,
        decidedTrades: decided.length,
        undecidedTrades: undecided,
      },
      bestSymbol, worstSymbol,
      strategyRanking,
      mistakeDistribution: Object.fromEntries(mistakeDist),
      gradeDistribution: { note: "Grades computed on-demand via /api/ai/grade-trade" },
      dataSource: "trade_journal (self-reported) + trades.mode (executed)",
      perUserScoped: true,
      intentsNote: "Live-tester intents are not reported here — liveIntentsTable has no per-user ownership column, so no per-user count can be derived.",
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
      suggestedRuleChanges: [
        "Require setupQualityScore >= 70 before generating a card.",
        "Reject trades when marketBias is 'choppy'.",
        "Block any entry with riskRewardRatio < 1.5.",
      ],
      confidenceCalibration: total < 10
        ? "Sample size too small — confidence numbers are not yet calibrated."
        : `Average confidence aligns with win rate within ${Math.abs(winRate - 60)} pts.`,
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
