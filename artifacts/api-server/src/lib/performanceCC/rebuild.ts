// Build GG — Rebuild snapshots idempotently.

import { db } from "@workspace/db";
import {
  performanceDailySnapshotsTable,
  performanceSymbolSnapshotsTable,
  aiPerformanceSnapshotsTable,
  paperOrdersTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  computeDailyStats, computeSymbolStats, computeRangeSummary,
  computeDecisionQuality, rangeToWindow, type RangeKey,
} from "./aggregator.js";
import { buildCommandCenter } from "./commandCenter.js";
import {
  paperOrdersTable as _paperOrdersTable,
  tradeDecisionLogsTable, learningEventsTable, postTradeDebriefsTable,
} from "@workspace/db";
import { and, gte, lte } from "drizzle-orm";

interface RebuildLogger {
  info: (m: string, meta?: Record<string, unknown>) => void;
  warn: (m: string, meta?: Record<string, unknown>) => void;
}

export async function rebuildSnapshots(log: RebuildLogger) {
  const startedAt = new Date();
  log.info("GG rebuild started");

  // Determine date range from paper_orders.
  const minMax = await db.execute(
    sql`SELECT MIN(opened_at)::date AS min_d, MAX(COALESCE(closed_at, opened_at))::date AS max_d FROM paper_orders`,
  );
  const row = (minMax.rows?.[0] ?? {}) as { min_d?: string | Date | null; max_d?: string | Date | null };
  const dailySnapshots: Array<{ date: string; net_pnl: number }> = [];

  if (row.min_d && row.max_d) {
    const minDate = new Date(row.min_d);
    const maxDate = new Date(row.max_d);
    log.info("GG rebuild date range", { from: minDate.toISOString(), to: maxDate.toISOString() });

    for (let d = new Date(minDate); d <= maxDate; d.setUTCDate(d.getUTCDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      const stats = await computeDailyStats(dateStr);
      // Upsert.
      await db.insert(performanceDailySnapshotsTable).values({
        date: stats.date,
        totalTrades: stats.total_trades,
        wins: stats.wins,
        losses: stats.losses,
        breakEven: stats.break_even,
        manualCloses: stats.manual_closes,
        cancelled: stats.cancelled,
        winRate: stats.win_rate,
        grossProfit: stats.gross_profit,
        grossLoss: stats.gross_loss,
        netPnl: stats.net_pnl,
        avgWin: stats.avg_win,
        avgLoss: stats.avg_loss,
        profitFactor: stats.profit_factor,
        bestTradeId: stats.best_trade_id,
        worstTradeId: stats.worst_trade_id,
        symbolsTraded: stats.symbols_traded,
        mistakeTags: stats.mistake_tags,
        topLesson: stats.top_lesson,
        dayRating: stats.day_rating,
        dayStatus: stats.day_status,
        aiDecisionsCount: stats.ai_decisions_count,
        paperTradesOpened: stats.paper_trades_opened,
        paperTradesClosed: stats.paper_trades_closed,
        debriefsCreated: stats.debriefs_created,
        learningEventsCreated: stats.learning_events_created,
      }).onConflictDoUpdate({
        target: performanceDailySnapshotsTable.date,
        set: {
          totalTrades: stats.total_trades, wins: stats.wins, losses: stats.losses,
          breakEven: stats.break_even, manualCloses: stats.manual_closes, cancelled: stats.cancelled,
          winRate: stats.win_rate, grossProfit: stats.gross_profit, grossLoss: stats.gross_loss,
          netPnl: stats.net_pnl, avgWin: stats.avg_win, avgLoss: stats.avg_loss,
          profitFactor: stats.profit_factor, bestTradeId: stats.best_trade_id,
          worstTradeId: stats.worst_trade_id, symbolsTraded: stats.symbols_traded,
          mistakeTags: stats.mistake_tags, topLesson: stats.top_lesson,
          dayRating: stats.day_rating, dayStatus: stats.day_status,
          aiDecisionsCount: stats.ai_decisions_count,
          paperTradesOpened: stats.paper_trades_opened,
          paperTradesClosed: stats.paper_trades_closed,
          debriefsCreated: stats.debriefs_created,
          learningEventsCreated: stats.learning_events_created,
          updatedAt: new Date(),
        },
      });
      dailySnapshots.push({ date: stats.date, net_pnl: stats.net_pnl });
    }
  } else {
    log.warn("GG rebuild: no paper trades found — skipping daily snapshots");
  }
  log.info("GG rebuild daily snapshots written", { count: dailySnapshots.length });

  // Symbol snapshots × ranges.
  const ranges: RangeKey[] = ["7d", "30d", "90d", "all"];
  let symbolSnapsWritten = 0;
  for (const range of ranges) {
    const stats = await computeSymbolStats(range);
    for (const s of stats) {
      await db.insert(performanceSymbolSnapshotsTable).values({
        symbol: s.symbol, rangeKey: s.range_key,
        totalTrades: s.total_trades, wins: s.wins, losses: s.losses, winRate: s.win_rate,
        netPnl: s.net_pnl, avgPnl: s.avg_pnl,
        bestTradeId: s.best_trade_id, worstTradeId: s.worst_trade_id,
        mistakeTags: s.mistake_tags, edgeScore: s.edge_score,
        learningConfidence: s.learning_confidence,
      }).onConflictDoUpdate({
        target: [performanceSymbolSnapshotsTable.symbol, performanceSymbolSnapshotsTable.rangeKey],
        set: {
          totalTrades: s.total_trades, wins: s.wins, losses: s.losses, winRate: s.win_rate,
          netPnl: s.net_pnl, avgPnl: s.avg_pnl, bestTradeId: s.best_trade_id,
          worstTradeId: s.worst_trade_id, mistakeTags: s.mistake_tags,
          edgeScore: s.edge_score, learningConfidence: s.learning_confidence,
          updatedAt: new Date(),
        },
      });
      symbolSnapsWritten += 1;
    }
  }
  log.info("GG rebuild symbol snapshots written", { count: symbolSnapsWritten });

  // AI performance snapshots × ranges — each row is range-scoped.
  const cc = await buildCommandCenter();
  let aiSnapsWritten = 0;
  for (const range of ranges) {
    const { from, to } = rangeToWindow(range);
    const r = await computeRangeSummary(range);
    const dq = await computeDecisionQuality(range);
    const decisionsInRange = await db.select().from(tradeDecisionLogsTable)
      .where(and(
        gte(tradeDecisionLogsTable.createdAt, from),
        lte(tradeDecisionLogsTable.createdAt, to),
      ));
    const debriefsInRange = await db.select().from(postTradeDebriefsTable)
      .where(and(
        gte(postTradeDebriefsTable.createdAt, from),
        lte(postTradeDebriefsTable.createdAt, to),
      ));
    const learningsInRange = await db.select().from(learningEventsTable)
      .where(and(
        gte(learningEventsTable.createdAt, from),
        lte(learningEventsTable.createdAt, to),
      ));
    const buy = decisionsInRange.filter(d => d.action === "BUY").length;
    const sell = decisionsInRange.filter(d => d.action === "SELL").length;
    const hold = decisionsInRange.filter(d => d.action === "HOLD").length;
    const avgConf = decisionsInRange.length ? decisionsInRange.reduce((a, d) => a + d.confidence, 0) / decisionsInRange.length : 0;
    const avgRisk = decisionsInRange.length ? decisionsInRange.reduce((a, d) => a + d.riskScore, 0) / decisionsInRange.length : 0;

    const values = {
      rangeKey: range,
      decisionsCreated: decisionsInRange.length,
      shouldTradeCount: buy + sell,
      holdCount: hold,
      paperTradesCreated: r.total_trades,
      blockedTrades: dq.blocked,
      debriefsCreated: debriefsInRange.length,
      learningEventsCreated: learningsInRange.length,
      avgConfidence: Number(avgConf.toFixed(2)),
      avgRiskScore: Number(avgRisk.toFixed(2)),
      avgEdgeScore: cc.aiDecisionStats.avgEdgeScore,
      decisionToWinRate: dq.decision_to_win_rate,
      mostCommonBlocker: "",
      mostCommonMistake: r.most_repeated_mistake ?? "",
      learningSummary: `range=${range} winRate=${r.win_rate} netPnl=${r.net_pnl} debriefs=${debriefsInRange.length}`,
      improvementScore: cc.learningStats.improvementScore,
    };
    await db.insert(aiPerformanceSnapshotsTable).values(values).onConflictDoUpdate({
      target: aiPerformanceSnapshotsTable.rangeKey,
      set: { ...values, updatedAt: new Date() },
    });
    aiSnapsWritten += 1;
  }
  log.info("GG rebuild AI snapshots written", { count: aiSnapsWritten });

  const finishedAt = new Date();
  log.info("GG rebuild completed", {
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    daily: dailySnapshots.length, symbol: symbolSnapsWritten, ai: aiSnapsWritten,
  });
  return {
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    daily_snapshots_written: dailySnapshots.length,
    symbol_snapshots_written: symbolSnapsWritten,
    ai_snapshots_written: aiSnapsWritten,
    warnings: dailySnapshots.length === 0 ? ["No paper trades — daily snapshots empty"] : [],
  };
}
