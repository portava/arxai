// Phase 6B/6E — Per-user AI trade review, performance insights, coaching plan.
// SAFETY: read-only over user's own data. No broker calls anywhere.
import { Router } from "express";
import {
  db, paperTradesTable, tradingSessionsTable,
  aiTradeReviewsTable, tradeJournalEntriesTable,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { reviewTrade, detectPatterns, buildCoachingPlan } from "../lib/aiReviewEngine.js";

const router = Router();

async function ownTrade(userId: number, id: number) {
  const r = await db.select().from(paperTradesTable)
    .where(and(eq(paperTradesTable.id, id), eq(paperTradesTable.userId, userId))).limit(1);
  return r[0] ?? null;
}
async function ownSession(userId: number, id: number) {
  const r = await db.select().from(tradingSessionsTable)
    .where(and(eq(tradingSessionsTable.id, id), eq(tradingSessionsTable.userId, userId))).limit(1);
  return r[0] ?? null;
}
async function latestJournalForTrade(userId: number, tradeId: number) {
  const r = await db.select().from(tradeJournalEntriesTable)
    .where(and(eq(tradeJournalEntriesTable.userId, userId), eq(tradeJournalEntriesTable.tradeId, tradeId)))
    .orderBy(desc(tradeJournalEntriesTable.createdAt)).limit(1);
  return r[0] ?? null;
}

function serialize(r: typeof aiTradeReviewsTable.$inferSelect) {
  return {
    ...r,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    safetyMode: "paper_only" as const,
    educationalOnly: true as const,
  };
}

// LIST all reviews for current user
router.get("/me/ai-trade-reviews", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const rows = await db.select().from(aiTradeReviewsTable)
    .where(eq(aiTradeReviewsTable.userId, userId))
    .orderBy(desc(aiTradeReviewsTable.createdAt)).limit(500);
  res.json({ reviews: rows.map(serialize), isEmpty: rows.length === 0 });
});

// GET review for a specific trade
router.get("/me/paper-trades/:id/review", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const tradeId = Number(req.params.id);
  if (!Number.isFinite(tradeId)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!(await ownTrade(userId, tradeId))) { res.status(404).json({ error: "Trade not found" }); return; }
  const r = await db.select().from(aiTradeReviewsTable)
    .where(and(eq(aiTradeReviewsTable.userId, userId), eq(aiTradeReviewsTable.paperTradeId, tradeId))).limit(1);
  if (!r[0]) { res.status(404).json({ error: "No review yet", hint: "POST /me/paper-trades/:id/review to generate" }); return; }
  res.json(serialize(r[0]));
});

// POST: generate (or regenerate) review for a trade
router.post("/me/paper-trades/:id/review", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const tradeId = Number(req.params.id);
    if (!Number.isFinite(tradeId)) { res.status(400).json({ error: "Invalid id" }); return; }
    const trade = await ownTrade(userId, tradeId);
    if (!trade) { res.status(404).json({ error: "Trade not found" }); return; }
    if (trade.status !== "closed") { res.status(409).json({ error: "Close the trade before reviewing" }); return; }
    const journal = await latestJournalForTrade(userId, tradeId);
    const journalNotes = journal?.userNotes ?? null;
    const disciplineScore = journal?.confidenceLevel ?? null;
    const meta = (journal?.aiReview && (journal.aiReview as { _meta?: Record<string, unknown> })._meta) ?? {};
    const executionScore = (meta as { executionScore?: number }).executionScore ?? null;

    const out = reviewTrade({ trade, journalNotes, disciplineScore, executionScore });

    // Upsert (unique on userId+paperTradeId)
    const existing = await db.select().from(aiTradeReviewsTable)
      .where(and(eq(aiTradeReviewsTable.userId, userId), eq(aiTradeReviewsTable.paperTradeId, tradeId))).limit(1);
    let row;
    if (existing[0]) {
      const u = await db.update(aiTradeReviewsTable).set({
        reviewStatus: "completed",
        tradingSessionId: trade.tradingSessionId,
        setupGrade: out.setupGrade, entryGrade: out.entryGrade, exitGrade: out.exitGrade,
        riskGrade: out.riskGrade, disciplineGrade: out.disciplineGrade, overallGrade: out.overallGrade,
        overallScore: out.overallScore, aiConfidence: out.aiConfidence,
        strengths: out.strengths, weaknesses: out.weaknesses, mistakeTags: out.mistakeTags,
        riskNotes: out.riskNotes, entryNotes: out.entryNotes, exitNotes: out.exitNotes,
        disciplineNotes: out.disciplineNotes,
        improvementPlan: out.improvementPlan, nextTradeFocus: out.nextTradeFocus,
        updatedAt: new Date(),
      }).where(and(eq(aiTradeReviewsTable.id, existing[0].id), eq(aiTradeReviewsTable.userId, userId))).returning();
      row = u[0]!;
    } else {
      const ins = await db.insert(aiTradeReviewsTable).values({
        userId, paperTradeId: tradeId, tradingSessionId: trade.tradingSessionId,
        reviewStatus: "completed",
        setupGrade: out.setupGrade, entryGrade: out.entryGrade, exitGrade: out.exitGrade,
        riskGrade: out.riskGrade, disciplineGrade: out.disciplineGrade, overallGrade: out.overallGrade,
        overallScore: out.overallScore, aiConfidence: out.aiConfidence,
        strengths: out.strengths, weaknesses: out.weaknesses, mistakeTags: out.mistakeTags,
        riskNotes: out.riskNotes, entryNotes: out.entryNotes, exitNotes: out.exitNotes,
        disciplineNotes: out.disciplineNotes,
        improvementPlan: out.improvementPlan, nextTradeFocus: out.nextTradeFocus,
      }).returning();
      row = ins[0]!;
    }
    res.status(201).json(serialize(row));
  } catch (err) {
    req.log.error({ err: String(err) }, "POST /me/paper-trades/:id/review failed");
    res.status(500).json({ error: "Review failed" });
  }
});

// Session AI summary — only this user's trades in that session
router.get("/me/trading-sessions/:id/ai-summary", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const sid = Number(req.params.id);
  if (!Number.isFinite(sid)) { res.status(400).json({ error: "Invalid id" }); return; }
  const sess = await ownSession(userId, sid);
  if (!sess) { res.status(404).json({ error: "Session not found" }); return; }
  const trades = await db.select().from(paperTradesTable)
    .where(and(eq(paperTradesTable.userId, userId), eq(paperTradesTable.tradingSessionId, sid)));
  const closed = trades.filter((t) => t.status === "closed");
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
  const losses = closed.filter((t) => (t.pnl ?? 0) < 0).length;
  const totalPnl = Number(closed.reduce((s, t) => s + (t.pnl ?? 0), 0).toFixed(4));
  const patterns = detectPatterns(trades);
  res.json({
    sessionId: sid, title: sess.title, status: sess.status, mode: sess.mode,
    tradesCount: trades.length, closedCount: closed.length, wins, losses,
    winRate: closed.length ? Number(((wins / closed.length) * 100).toFixed(1)) : 0,
    totalPnl, expectancy: patterns.averages.expectancy,
    insights: patterns.insights, topMistakes: patterns.topMistakes,
    isEmpty: trades.length === 0,
    educationalOnly: true, safetyMode: "paper_only",
  });
});

// Performance insights (account-wide, user-scoped)
router.get("/me/performance-insights", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const trades = await db.select().from(paperTradesTable).where(eq(paperTradesTable.userId, userId));
  const p = detectPatterns(trades);
  res.json({
    ...p,
    sampleSize: trades.length,
    isEmpty: trades.length === 0,
    educationalOnly: true, safetyMode: "paper_only",
  });
});

// Coaching plan
router.get("/me/coaching-plan", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const trades = await db.select().from(paperTradesTable).where(eq(paperTradesTable.userId, userId));
  const plan = buildCoachingPlan(trades);
  res.json({
    ...plan,
    sampleSize: trades.length,
    isEmpty: trades.length === 0,
    educationalOnly: true, safetyMode: "paper_only",
    note: "Educational paper-trading guidance only. AI cannot place trades.",
  });
});

// Avoid unused-import on sql while keeping the type available for future use
void sql;
export default router;
