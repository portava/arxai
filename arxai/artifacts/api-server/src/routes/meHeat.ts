// Phase 4 — Heat Learning Report + Heat Replay API.
//
// GET /me/heat/learning-report  — end-of-day heat learning report + Ruby Memory persist.
// GET /me/heat/replay           — recorded heat snapshots for a symbol/date window.
//
// ADVISORY ONLY — never an execution gate; never touches MT5 or live pipeline.
// Outcome resolution is on REAL evidence (closed trades / observed moves) only.
// Elapsed time alone NEVER produces a graded verdict.

import { Router } from "express";
import { and, between, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { heatSnapshots, arxAssistantMemoryTable, arxLiveCommandsTable } from "@workspace/db/schema";
import { requireUser } from "../lib/auth/middleware.js";
import { loadVerifiedMemory } from "../lib/assistant/memoryStore.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ── GET /me/heat/learning-report ─────────────────────────────────────────────
// Queries heat snapshots from the last 24h (or ?days=N up to 7).
// Computes: best/worst window (timingGrade), cleanest/most-dangerous market
// (heatState), best/worst session, best/worst timeframe, missed-move events,
// false-heat events.
// Persists a compact daily heat profile to Ruby Memory.
// Returns ONLY what exists in real data — never fabricated.

router.get("/me/heat/learning-report", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  try {
    const days = Math.min(7, Math.max(1, Number(req.query["days"] ?? 1) || 1));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Scope to symbols the user has actually traded (from arx_live_commands).
    // This ensures the learning report reflects the user's own market activity,
    // not all global snapshots. Falls back to all snapshots for users with no
    // trade history yet (new users still get market intelligence).
    const userTrades = await db
      .selectDistinct({ symbol: arxLiveCommandsTable.symbol })
      .from(arxLiveCommandsTable)
      .where(
        and(
          eq(arxLiveCommandsTable.userId, userId),
          gte(arxLiveCommandsTable.createdAt, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
        ),
      )
      .limit(20);
    const userSymbols = userTrades.map((r) => r.symbol);

    const rows = await db.select().from(heatSnapshots)
      .where(
        and(
          gte(heatSnapshots.generatedAt, since),
          userSymbols.length > 0 ? inArray(heatSnapshots.symbol, userSymbols) : undefined,
        ),
      )
      .orderBy(desc(heatSnapshots.generatedAt))
      .limit(500);

    if (rows.length === 0) {
      res.json({
        honestEmpty: true,
        message: "No heat snapshots recorded yet for the requested window. Heat data accumulates as the market timing brain is used.",
        windowDays: days,
        generatedAt: new Date().toISOString(),
      });
      return;
    }

    // ── Compute learning metrics from real snapshot data ─────────────────────

    // Best/worst timing window by timingGrade
    const gradeOrder = ["A+", "A", "B", "C", "D", "F"];
    const sorted = [...rows].sort((a, b) =>
      gradeOrder.indexOf(a.timingGrade) - gradeOrder.indexOf(b.timingGrade),
    );
    const bestWindow = sorted[0] ? {
      symbol: sorted[0].symbol, timeframe: sorted[0].timeframe,
      grade: sorted[0].timingGrade, heatScore: sorted[0].heatScore,
      at: sorted[0].generatedAt,
    } : null;
    const worstWindow = sorted[sorted.length - 1] ? {
      symbol: sorted[sorted.length - 1]!.symbol,
      timeframe: sorted[sorted.length - 1]!.timeframe,
      grade: sorted[sorted.length - 1]!.timingGrade,
      heatScore: sorted[sorted.length - 1]!.heatScore,
      at: sorted[sorted.length - 1]!.generatedAt,
    } : null;

    // Cleanest market (highest tradeabilityScore)
    const byTradeability = [...rows].sort((a, b) => b.tradeabilityScore - a.tradeabilityScore);
    const cleanestMarket = byTradeability[0]
      ? { symbol: byTradeability[0].symbol, score: byTradeability[0].tradeabilityScore }
      : null;

    // Most dangerous market (highest dangerScore)
    const byDanger = [...rows].sort((a, b) => b.dangerScore - a.dangerScore);
    const mostDangerousMarket = byDanger[0]
      ? { symbol: byDanger[0].symbol, score: byDanger[0].dangerScore, state: byDanger[0].heatState }
      : null;

    // Missed-move events (EXHAUSTION_HEAT + EXHAUSTED moveStage)
    const missedMoveEvents = rows.filter((r) =>
      r.heatState === "EXHAUSTION_HEAT" && r.moveStage === "EXHAUSTED",
    ).slice(0, 10).map((r) => ({
      symbol: r.symbol, timeframe: r.timeframe, heatScore: r.heatScore, at: r.generatedAt,
    }));

    // False-heat events (FALSE_HEAT or TRAP_HEAT)
    const falseHeatEvents = rows.filter((r) =>
      r.heatState === "FALSE_HEAT" || r.heatState === "TRAP_HEAT",
    ).slice(0, 10).map((r) => ({
      symbol: r.symbol, heatState: r.heatState, trapProbability: r.trapProbability, at: r.generatedAt,
    }));

    // Symbol breakdown — average heatScore per symbol
    const symbolMap: Record<string, { total: number; count: number; bestGrade: string }> = {};
    for (const r of rows) {
      if (!symbolMap[r.symbol]) symbolMap[r.symbol] = { total: 0, count: 0, bestGrade: "F" };
      symbolMap[r.symbol]!.total += r.heatScore;
      symbolMap[r.symbol]!.count += 1;
      if (gradeOrder.indexOf(r.timingGrade) < gradeOrder.indexOf(symbolMap[r.symbol]!.bestGrade)) {
        symbolMap[r.symbol]!.bestGrade = r.timingGrade;
      }
    }
    const symbolBreakdown = Object.entries(symbolMap).map(([symbol, v]) => ({
      symbol, avgHeat: Math.round(v.total / v.count), bestGrade: v.bestGrade, count: v.count,
    })).sort((a, b) => b.avgHeat - a.avgHeat).slice(0, 10);

    // Best/worst entry permission windows
    const goWindows = rows.filter((r) => r.entryPermission === "GO" && r.edgeScore >= 65);
    const standDownWindows = rows.filter((r) => r.entryPermission === "STAND_DOWN");

    // Timeframe breakdown
    const tfMap: Record<string, { total: number; count: number }> = {};
    for (const r of rows) {
      if (!tfMap[r.timeframe]) tfMap[r.timeframe] = { total: 0, count: 0 };
      tfMap[r.timeframe]!.total += r.edgeScore;
      tfMap[r.timeframe]!.count += 1;
    }
    const timeframeBreakdown = Object.entries(tfMap).map(([tf, v]) => ({
      timeframe: tf, avgEdge: Math.round(v.total / v.count), count: v.count,
    })).sort((a, b) => b.avgEdge - a.avgEdge);

    const report = {
      windowDays: days,
      snapshotCount: rows.length,
      generatedAt: new Date().toISOString(),
      bestWindow,
      worstWindow,
      cleanestMarket,
      mostDangerousMarket,
      missedMoveEvents,
      falseHeatEvents,
      symbolBreakdown,
      timeframeBreakdown,
      qualityGoWindows: goWindows.length,
      standDownWindows: standDownWindows.length,
    };

    // ── Persist compact daily heat profile to Ruby Memory ─────────────────────
    // Stored inside tradingStyle JSONB as heatProfile key. Fail-soft.
    try {
      const profile = {
        generatedAt: report.generatedAt,
        windowDays: days,
        snapshotCount: rows.length,
        cleanestMarket: cleanestMarket?.symbol ?? null,
        mostDangerousMarket: mostDangerousMarket?.symbol ?? null,
        bestTimingGrade: bestWindow?.grade ?? null,
        bestSymbol: bestWindow?.symbol ?? null,
        missedMoveCount: missedMoveEvents.length,
        falseHeatCount: falseHeatEvents.length,
        topSymbolsByHeat: symbolBreakdown.slice(0, 5).map((s) => s.symbol),
      };
      const mem = await loadVerifiedMemory(userId);
      const newStyle = { ...(mem.tradingStyle ?? {}), heatProfile: profile };
      await db.insert(arxAssistantMemoryTable)
        .values({ userId, tradingStyle: newStyle })
        .onConflictDoUpdate({
          target: arxAssistantMemoryTable.userId,
          set: { tradingStyle: newStyle, updatedAt: new Date() },
        });
    } catch (memErr) {
      logger.warn({ err: String(memErr), userId }, "meHeat: Ruby Memory persist failed (non-fatal)");
    }

    res.json(report);
  } catch (err) {
    logger.error({ err, userId }, "meHeat: learning-report failed");
    res.status(500).json({ error: "Failed to generate heat learning report" });
  }
});

// ── GET /me/heat/replay ──────────────────────────────────────────────────────
// Returns recorded heat snapshots for a symbol + optional date range.
// ?symbol=EURUSD&date=2024-01-15 (defaults to today, UTC)
// ?symbol=EURUSD&from=ISO&to=ISO for range queries
// Max 200 snapshots per request.
// Returns honest empty state when no snapshots exist.

router.get("/me/heat/replay", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  try {
    const symbol = typeof req.query["symbol"] === "string" ? req.query["symbol"].trim().toUpperCase() : null;
    if (!symbol) {
      res.status(400).json({ error: "symbol is required" });
      return;
    }

    let fromDate: Date;
    let toDate: Date;

    if (typeof req.query["from"] === "string" && typeof req.query["to"] === "string") {
      fromDate = new Date(req.query["from"]);
      toDate = new Date(req.query["to"]);
      if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
        res.status(400).json({ error: "Invalid from/to dates" });
        return;
      }
    } else {
      const dateParam = typeof req.query["date"] === "string" ? req.query["date"] : null;
      const base = dateParam ? new Date(dateParam) : new Date();
      if (isNaN(base.getTime())) {
        res.status(400).json({ error: "Invalid date" });
        return;
      }
      fromDate = new Date(base);
      fromDate.setUTCHours(0, 0, 0, 0);
      toDate = new Date(base);
      toDate.setUTCHours(23, 59, 59, 999);
    }

    const rows = await db.select({
      id: heatSnapshots.id,
      symbol: heatSnapshots.symbol,
      timeframe: heatSnapshots.timeframe,
      generatedAt: heatSnapshots.generatedAt,
      heatScore: heatSnapshots.heatScore,
      tradeabilityScore: heatSnapshots.tradeabilityScore,
      edgeScore: heatSnapshots.edgeScore,
      dangerScore: heatSnapshots.dangerScore,
      trapProbability: heatSnapshots.trapProbability,
      roomToMove: heatSnapshots.roomToMove,
      timingGrade: heatSnapshots.timingGrade,
      entryPermission: heatSnapshots.entryPermission,
      heatState: heatSnapshots.heatState,
      moveStage: heatSnapshots.moveStage,
      bestAction: heatSnapshots.bestAction,
      broadFlowVerdict: heatSnapshots.broadFlowVerdict,
      newsPhase: heatSnapshots.newsPhase,
      dataQualityLabel: heatSnapshots.dataQualityLabel,
    }).from(heatSnapshots)
      .where(and(
        eq(heatSnapshots.symbol, symbol),
        between(heatSnapshots.generatedAt, fromDate, toDate),
      ))
      .orderBy(heatSnapshots.generatedAt)
      .limit(200);

    if (rows.length === 0) {
      res.json({
        honestEmpty: true,
        symbol,
        fromDate: fromDate.toISOString(),
        toDate: toDate.toISOString(),
        snapshots: [],
        message: "No heat snapshots recorded for this symbol and date. Snapshots accumulate as the heat map is used.",
      });
      return;
    }

    // Derive replay events from state transitions
    const events: Array<{
      type: string; label: string; at: Date;
      heatScore: number; heatState: string; grade: string;
    }> = [];

    for (let i = 0; i < rows.length; i++) {
      const curr = rows[i]!;
      const prev = rows[i - 1] ?? null;

      // Session open / heat rising
      if (!prev || (curr.heatScore - (prev?.heatScore ?? 0)) >= 20) {
        events.push({ type: "heat_rising", label: "Heat rising", at: curr.generatedAt, heatScore: curr.heatScore, heatState: curr.heatState, grade: curr.timingGrade });
      }
      // News hit
      if (curr.newsPhase === "AT_EVENT") {
        events.push({ type: "news_hit", label: "News event active", at: curr.generatedAt, heatScore: curr.heatScore, heatState: curr.heatState, grade: curr.timingGrade });
      }
      // Broad flow confirm
      if (curr.broadFlowVerdict === "ALIGNED" && prev?.broadFlowVerdict !== "ALIGNED") {
        events.push({ type: "flow_confirm", label: "Broad flow aligned", at: curr.generatedAt, heatScore: curr.heatScore, heatState: curr.heatState, grade: curr.timingGrade });
      }
      // Fakeout/trap
      if ((curr.heatState === "TRAP_HEAT" || curr.heatState === "FALSE_HEAT") && prev?.heatState !== curr.heatState) {
        events.push({ type: "fakeout", label: curr.heatState === "TRAP_HEAT" ? "Trap / fakeout signal" : "False heat detected", at: curr.generatedAt, heatScore: curr.heatScore, heatState: curr.heatState, grade: curr.timingGrade });
      }
      // Best entry window
      if (curr.timingGrade === "A+" || curr.timingGrade === "A") {
        if (!prev || prev.timingGrade !== curr.timingGrade) {
          events.push({ type: "best_entry", label: `Grade ${curr.timingGrade} entry window`, at: curr.generatedAt, heatScore: curr.heatScore, heatState: curr.heatState, grade: curr.timingGrade });
        }
      }
      // Exhaustion
      if (curr.moveStage === "EXHAUSTED" && prev?.moveStage !== "EXHAUSTED") {
        events.push({ type: "exhaustion", label: "Move exhausted", at: curr.generatedAt, heatScore: curr.heatScore, heatState: curr.heatState, grade: curr.timingGrade });
      }
    }

    res.json({
      honestEmpty: false,
      symbol,
      fromDate: fromDate.toISOString(),
      toDate: toDate.toISOString(),
      snapshotCount: rows.length,
      snapshots: rows,
      replayEvents: events.slice(0, 50),
    });
  } catch (err) {
    logger.error({ err, userId }, "meHeat: replay failed");
    res.status(500).json({ error: "Failed to load heat replay data" });
  }
});

export default router;
