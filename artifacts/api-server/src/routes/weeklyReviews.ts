// Build J — Weekly Performance Review & AI Improvement Plan routes.
//
// COMPOSES:
//   - tradesTable                       (P/L, win rate, R:R, best/worst)
//   - tradeJournalEntriesTable          (mistake/strength tag patterns)
//   - vault_events  truthDomain="BEHAVIOR" (trend signal — append-only)
//   - weeklyPerformanceReviewsTable     (this build, idempotent on user+week)
//   - weeklyImprovementGoalsTable       (this build)
//
// Idempotency: POST /weekly-reviews/generate upserts on (user_id, week_start)
// — re-running for the same week refreshes metrics + goals; never duplicates.

import { Router } from "express";
import {
  db,
  tradesTable,
  tradeJournalEntriesTable,
  weeklyPerformanceReviewsTable,
  weeklyImprovementGoalsTable,
  vaultEventsTable,
} from "@workspace/db";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import {
  calculateWeeklyMetrics, summarizeWeek, proposeWeeklyGoals,
  type ClosedTrade, type JournalEntryLite,
} from "@workspace/domain/weekly-review";

const router = Router();

/** Authenticated caller id. `requireUser` runs first on every route below, so
 *  `req.authUser` is always populated by the time a handler body executes. */
function uid(req: import("express").Request): number {
  return req.authUser!.id;
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Monday 00:00 UTC of the ISO week containing `d`. */
function weekStartUTC(d: Date): Date {
  const day = d.getUTCDay();             // 0=Sun..6=Sat
  const diff = (day + 6) % 7;            // back to Mon
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
  return start;
}
function weekEndUTC(start: Date): Date {
  return new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
}

function serializeReview(row: typeof weeklyPerformanceReviewsTable.$inferSelect) {
  return {
    id: row.id,
    weekStartIso: row.weekStart.toISOString(),
    weekEndIso: row.weekEnd.toISOString(),
    totalTrades: row.totalTrades,
    winningTrades: row.winningTrades,
    losingTrades: row.losingTrades,
    netProfitLoss: row.netProfitLoss,
    winRate: row.winRate,
    averageRr: row.averageRr,
    bestTradeId: row.bestTradeId,
    worstTradeId: row.worstTradeId,
    bestStrategy: row.bestStrategy,
    worstStrategy: row.worstStrategy,
    bestSession: row.bestSession,
    worstSession: row.worstSession,
    strongestScoreArea: row.strongestScoreArea,
    weakestScoreArea: row.weakestScoreArea,
    biggestMistakePattern: row.biggestMistakePattern,
    biggestStrengthPattern: row.biggestStrengthPattern,
    scoreTrends: row.scoreTrends,
    aiSummary: row.aiSummary,
    nextWeekFocus: row.nextWeekFocus,
    createdAtIso: row.createdAt.toISOString(),
  };
}

function serializeGoal(row: typeof weeklyImprovementGoalsTable.$inferSelect) {
  return {
    id: row.id,
    weeklyReviewId: row.weeklyReviewId,
    goalTitle: row.goalTitle,
    goalDescription: row.goalDescription,
    targetMetric: row.targetMetric,
    startingValue: row.startingValue,
    targetValue: row.targetValue,
    status: row.status,
    createdAtIso: row.createdAt.toISOString(),
    updatedAtIso: row.updatedAt.toISOString(),
  };
}

async function vaultBehavior(kind: string, payload: Record<string, unknown>) {
  await db.insert(vaultEventsTable).values({
    kind, severity: "INFO", source: "SYSTEM", truthDomain: "BEHAVIOR",
    summary: kind, payload, reasons: [], blockers: [],
    generatedAtIso: new Date().toISOString(),
  });
}

// ── routes ─────────────────────────────────────────────────────────────────

// GET /weekly-reviews — list latest 12 weeks
router.get("/weekly-reviews", requireUser, async (req, res) => {
  try {
    const limit = Math.min(52, Math.max(1, Number(req.query.limit) || 12));
    const rows = await db.select().from(weeklyPerformanceReviewsTable)
      .where(eq(weeklyPerformanceReviewsTable.userId, uid(req)))
      .orderBy(desc(weeklyPerformanceReviewsTable.weekStart))
      .limit(limit);
    res.json({ reviews: rows.map(serializeReview) });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /weekly-reviews failed");
    res.status(500).json({ error: "Failed to load reviews" });
  }
});

// GET /weekly-reviews/latest — latest single review (for dashboard card)
router.get("/weekly-reviews/latest", requireUser, async (req, res): Promise<void> => {
  try {
    const rows = await db.select().from(weeklyPerformanceReviewsTable)
      .where(eq(weeklyPerformanceReviewsTable.userId, uid(req)))
      .orderBy(desc(weeklyPerformanceReviewsTable.weekStart)).limit(1);
    const row = rows[0];
    if (!row) { res.json({ review: null, goals: [] }); return; }
    const goals = await db.select().from(weeklyImprovementGoalsTable)
      .where(and(
        eq(weeklyImprovementGoalsTable.weeklyReviewId, row.id),
        eq(weeklyImprovementGoalsTable.userId, uid(req)),
      ))
      .orderBy(weeklyImprovementGoalsTable.id);
    res.json({ review: serializeReview(row), goals: goals.map(serializeGoal) });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /weekly-reviews/latest failed");
    res.status(500).json({ error: "Failed to load latest review" });
  }
});

// POST /weekly-reviews/generate — idempotent on (user_id, week_start).
// Body optional: { weekStart?: ISO } — defaults to current ISO week.
const GenerateBody = z.object({
  weekStart: z.string().datetime().optional(),
}).optional();

router.post("/weekly-reviews/generate", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = uid(req);
    const body = GenerateBody.parse(req.body ?? {});
    const start = body?.weekStart ? weekStartUTC(new Date(body.weekStart)) : weekStartUTC(new Date());
    const end = weekEndUTC(start);

    // Load THIS USER'S trades + journal entries created in window.
    const [allTradeRows, journalRows] = await Promise.all([
      db.select().from(tradesTable).where(
        and(
          eq(tradesTable.userId, userId),
          gte(tradesTable.createdAt, start),
          lte(tradesTable.createdAt, end),
        ),
      ),
      db.select().from(tradeJournalEntriesTable).where(
        and(
          eq(tradeJournalEntriesTable.userId, userId),
          gte(tradeJournalEntriesTable.createdAt, start),
          lte(tradeJournalEntriesTable.createdAt, end),
        ),
      ),
    ]);

    // HONESTY — a trade whose realized P/L is UNKNOWN (see trades.pnlStatus)
    // may never enter a P/L aggregate. Excluded rows are counted and reported
    // rather than silently folded in as if their P/L were known.
    const excludedUnknownPnl = allTradeRows.filter((t) => t.pnlStatus === "UNKNOWN").length;
    const tradeRows = allTradeRows.filter((t) => t.pnlStatus !== "UNKNOWN");

    // HONESTY — real (LIVE) and simulated (DEMO) money must never be presented
    // as one undifferentiated figure without saying so. We keep the single
    // weekly row (schema has no mode column) but report the split and state it
    // in the summary text whenever both are present.
    const liveRows = tradeRows.filter((t) => t.mode === "LIVE");
    const demoRows = tradeRows.filter((t) => t.mode !== "LIVE");
    const sumPnl = (rows: typeof tradeRows) => rows.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const modeBreakdown = {
      live: { trades: liveRows.length, netProfitLoss: Number(sumPnl(liveRows).toFixed(2)) },
      demo: { trades: demoRows.length, netProfitLoss: Number(sumPnl(demoRows).toFixed(2)) },
      excludedUnknownPnl,
    };

    const trades: ClosedTrade[] = tradeRows.map((t) => ({
      id: t.id,
      symbol: t.symbol,
      strategy: t.strategy,
      entryPrice: t.entryPrice,
      stopLoss: t.stopLoss,
      takeProfit: t.takeProfit,
      pnl: t.pnl,
      status: t.status,
      closedAtIso: t.closedAt?.toISOString() ?? null,
      createdAtIso: (t.createdAt ?? new Date()).toISOString(),
    }));
    const journal: JournalEntryLite[] = journalRows.map((j) => ({
      mistakeTags: j.mistakeTags ?? [],
      strengthTags: j.strengthTags ?? [],
      createdAtIso: j.createdAt.toISOString(),
    }));

    const metrics = calculateWeeklyMetrics(trades, journal);
    const summary = summarizeWeek(metrics);
    const proposed = proposeWeeklyGoals(metrics);

    // Say plainly what the headline number is made of. Never let a combined
    // real+simulated figure read as a pure live result, and never hide rows
    // dropped for an unknown realized P/L.
    const provenanceNotes: string[] = [];
    if (modeBreakdown.live.trades > 0 && modeBreakdown.demo.trades > 0) {
      provenanceNotes.push(
        `This figure combines ${modeBreakdown.live.trades} LIVE trade(s) (net ${modeBreakdown.live.netProfitLoss.toFixed(2)}) `
        + `with ${modeBreakdown.demo.trades} simulated DEMO trade(s) (net ${modeBreakdown.demo.netProfitLoss.toFixed(2)}) — real and simulated money are added together.`,
      );
    } else if (modeBreakdown.demo.trades > 0 && modeBreakdown.live.trades === 0) {
      provenanceNotes.push("All trades in this week are simulated (DEMO) — no real money was at risk.");
    }
    if (excludedUnknownPnl > 0) {
      provenanceNotes.push(
        `${excludedUnknownPnl} trade(s) were excluded from the P/L figures because their realized P/L is UNKNOWN.`,
      );
    }
    const aiSummary = provenanceNotes.length > 0
      ? `${summary.aiSummary} ${provenanceNotes.join(" ")}`
      : summary.aiSummary;

    const reviewValues = {
      userId,
      weekStart: start, weekEnd: end,
      totalTrades: metrics.totalTrades,
      winningTrades: metrics.winningTrades,
      losingTrades: metrics.losingTrades,
      netProfitLoss: metrics.netProfitLoss,
      winRate: metrics.winRate,
      averageRr: metrics.averageRr,
      bestTradeId: metrics.bestTradeId,
      worstTradeId: metrics.worstTradeId,
      bestStrategy: metrics.bestStrategy,
      worstStrategy: metrics.worstStrategy,
      bestSession: metrics.bestSession,
      worstSession: metrics.worstSession,
      strongestScoreArea: metrics.strongestScoreArea,
      weakestScoreArea: metrics.weakestScoreArea,
      biggestMistakePattern: metrics.biggestMistakePattern,
      biggestStrengthPattern: metrics.biggestStrengthPattern,
      scoreTrends: metrics.scoreTrends,
      aiSummary,
      nextWeekFocus: summary.nextWeekFocus,
    };

    // Atomic upsert + goal refresh in one transaction — fixes a race where
    // two concurrent generate calls could otherwise both insert. The conflict
    // target is the per-user composite unique index
    // `weekly_perf_reviews_user_week_uq` (user_id, week_start): one review per
    // user per week. The old single-tenant partial index
    // (`week_start WHERE user_id IS NULL`) collapsed EVERY user's week into
    // one shared row and is no longer used by this route.
    const { reviewRow, goalRows } = await db.transaction(async (tx) => {
      const inserted = await tx.insert(weeklyPerformanceReviewsTable)
        .values(reviewValues)
        .onConflictDoUpdate({
          target: [weeklyPerformanceReviewsTable.userId, weeklyPerformanceReviewsTable.weekStart],
          set: reviewValues,
        })
        .returning();
      const review = inserted[0]!;

      // Refresh ACTIVE goals only — never delete COMPLETED/MISSED history.
      await tx.delete(weeklyImprovementGoalsTable)
        .where(and(
          eq(weeklyImprovementGoalsTable.weeklyReviewId, review.id),
          eq(weeklyImprovementGoalsTable.userId, userId),
          eq(weeklyImprovementGoalsTable.status, "ACTIVE"),
        ));

      const newGoals = proposed.length === 0 ? [] : await tx.insert(weeklyImprovementGoalsTable).values(
        proposed.map((g) => ({
          userId,
          weeklyReviewId: review.id,
          goalTitle: g.goalTitle,
          goalDescription: g.goalDescription,
          targetMetric: g.targetMetric,
          startingValue: g.startingValue,
          targetValue: g.targetValue,
          status: "ACTIVE",
        })),
      ).returning();

      // Return the FULL current goal set (active + historical) so the client
      // sees a consistent view after refresh.
      const allGoals = await tx.select().from(weeklyImprovementGoalsTable)
        .where(and(
          eq(weeklyImprovementGoalsTable.weeklyReviewId, review.id),
          eq(weeklyImprovementGoalsTable.userId, userId),
        ))
        .orderBy(weeklyImprovementGoalsTable.id);

      return { reviewRow: review, goalRows: allGoals.length > 0 ? allGoals : newGoals };
    });

    await vaultBehavior("WEEKLY_REVIEW_GENERATED", {
      reviewId: reviewRow.id,
      weekStartIso: start.toISOString(),
      totalTrades: metrics.totalTrades,
      netProfitLoss: metrics.netProfitLoss,
      goalsCount: goalRows.length,
    });

    res.json({ review: serializeReview(reviewRow), goals: goalRows.map(serializeGoal), modeBreakdown });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /weekly-reviews/generate failed");
    res.status(500).json({ error: "Failed to generate review" });
  }
});

// GET /weekly-goals — by review id
router.get("/weekly-goals", requireUser, async (req, res) => {
  try {
    const reviewId = req.query.reviewId ? Number(req.query.reviewId) : null;
    const userId = uid(req);
    const rows = await db.select().from(weeklyImprovementGoalsTable)
      .where(reviewId
        ? and(
            eq(weeklyImprovementGoalsTable.userId, userId),
            eq(weeklyImprovementGoalsTable.weeklyReviewId, reviewId),
          )
        : eq(weeklyImprovementGoalsTable.userId, userId))
      .orderBy(desc(weeklyImprovementGoalsTable.id))
      .limit(100);
    res.json({ goals: rows.map(serializeGoal) });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /weekly-goals failed");
    res.status(500).json({ error: "Failed to load goals" });
  }
});

// PATCH /weekly-goals/:id — update status (ACTIVE → COMPLETED | MISSED | DROPPED)
const PatchGoal = z.object({
  status: z.enum(["ACTIVE", "COMPLETED", "MISSED", "DROPPED"]),
});
router.patch("/weekly-goals/:id", requireUser, async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const body = PatchGoal.parse(req.body ?? {});
    // Ownership is part of the WHERE clause: a foreign goal id updates zero
    // rows and answers 404, never someone else's goal.
    const updated = await db.update(weeklyImprovementGoalsTable)
      .set({ status: body.status, updatedAt: new Date() })
      .where(and(
        eq(weeklyImprovementGoalsTable.id, id),
        eq(weeklyImprovementGoalsTable.userId, uid(req)),
      ))
      .returning();
    if (!updated[0]) { res.status(404).json({ error: "Not found" }); return; }
    await vaultBehavior("WEEKLY_GOAL_STATUS_CHANGED", {
      goalId: updated[0].id, status: updated[0].status,
    });
    res.json(serializeGoal(updated[0]));
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "PATCH /weekly-goals/:id failed");
    res.status(500).json({ error: "Failed to update goal" });
  }
});

// GET /weekly-reviews/score-trends — last N weeks of score trends, for chart
router.get("/weekly-reviews/score-trends", requireUser, async (req, res) => {
  try {
    const limit = Math.min(26, Math.max(1, Number(req.query.weeks) || 8));
    const rows = await db.select().from(weeklyPerformanceReviewsTable)
      .where(eq(weeklyPerformanceReviewsTable.userId, uid(req)))
      .orderBy(desc(weeklyPerformanceReviewsTable.weekStart))
      .limit(limit);
    res.json({
      weeks: rows.reverse().map((r) => ({
        weekStartIso: r.weekStart.toISOString(),
        scoreTrends: r.scoreTrends ?? { discipline: 0, execution: 0, emotionalControl: 0, consistency: 0 },
        netProfitLoss: r.netProfitLoss,
        winRate: r.winRate,
      })),
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /weekly-reviews/score-trends failed");
    res.status(500).json({ error: "Failed to load score trends" });
  }
});

export default router;
