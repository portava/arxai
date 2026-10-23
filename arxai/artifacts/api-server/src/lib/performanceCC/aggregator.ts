// Build GG — Performance aggregation service.
//
// SAFETY: Read-only against existing AA-FF tables. Never writes to live
// trading surfaces. Computes daily/symbol stats from paper_orders + decision
// logs + debriefs + learning events.

import { db } from "@workspace/db";
import {
  paperOrdersTable,
  tradeDecisionLogsTable,
  postTradeDebriefsTable,
  learningEventsTable,
  strategyEdgesTable,
  mistakePatternsTable,
  autopilotCyclesTable,
} from "@workspace/db";
import { and, eq, gte, lte, desc, sql, inArray } from "drizzle-orm";

export type RangeKey = "7d" | "30d" | "90d" | "all";

export function rangeToWindow(range: RangeKey): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date(to);
  if (range === "7d") from.setUTCDate(to.getUTCDate() - 7);
  else if (range === "30d") from.setUTCDate(to.getUTCDate() - 30);
  else if (range === "90d") from.setUTCDate(to.getUTCDate() - 90);
  else from.setUTCFullYear(2020); // "all"
  return { from, to };
}

function ymd(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const dt = typeof d === "string" ? new Date(d) : d;
  if (isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
}

function rateDay(netPnl: number, trades: number, winRate: number): "A" | "B" | "C" | "D" | "F" {
  if (trades === 0) return "F";
  if (netPnl > 0 && winRate >= 70) return "A";
  if (netPnl > 0 && winRate >= 50) return "B";
  if (netPnl >= 0) return "C";
  if (winRate >= 30) return "D";
  return "F";
}

function statusForDay(netPnl: number, trades: number): "WINNING_DAY" | "LOSING_DAY" | "BREAK_EVEN_DAY" | "NO_TRADE_DAY" {
  if (trades === 0) return "NO_TRADE_DAY";
  if (netPnl > 0.001) return "WINNING_DAY";
  if (netPnl < -0.001) return "LOSING_DAY";
  return "BREAK_EVEN_DAY";
}

export interface DailyStats {
  date: string;
  total_trades: number;
  wins: number;
  losses: number;
  break_even: number;
  manual_closes: number;
  cancelled: number;
  win_rate: number;
  gross_profit: number;
  gross_loss: number;
  net_pnl: number;
  best_trade: number | null;
  worst_trade: number | null;
  best_trade_id: number | null;
  worst_trade_id: number | null;
  avg_win: number;
  avg_loss: number;
  profit_factor: number;
  symbols_traded: string[];
  ai_decisions_count: number;
  paper_trades_opened: number;
  paper_trades_closed: number;
  debriefs_created: number;
  learning_events_created: number;
  mistake_tags: string[];
  top_lesson: string;
  day_rating: "A" | "B" | "C" | "D" | "F";
  day_status: "WINNING_DAY" | "LOSING_DAY" | "BREAK_EVEN_DAY" | "NO_TRADE_DAY";
}

/** Compute the daily stats payload for one calendar date (YYYY-MM-DD, UTC). */
export async function computeDailyStats(date: string): Promise<DailyStats> {
  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd = new Date(`${date}T23:59:59.999Z`);

  // Paper trades closed THIS DAY (drives PnL).
  const closedToday = await db.select().from(paperOrdersTable)
    .where(and(
      gte(paperOrdersTable.closedAt, dayStart),
      lte(paperOrdersTable.closedAt, dayEnd),
    ));

  // Paper trades opened THIS DAY.
  const openedToday = await db.select().from(paperOrdersTable)
    .where(and(
      gte(paperOrdersTable.openedAt, dayStart),
      lte(paperOrdersTable.openedAt, dayEnd),
    ));

  const wins = closedToday.filter(t => (t.profitLoss ?? 0) > 0.001);
  const losses = closedToday.filter(t => (t.profitLoss ?? 0) < -0.001);
  const breakEven = closedToday.filter(t => Math.abs(t.profitLoss ?? 0) <= 0.001);
  const manualCloses = closedToday.filter(t => t.status === "CLOSED_MANUAL" || t.status === "PAPER_CLOSED_MANUAL");
  const cancelledRows = closedToday.filter(t => t.status === "CANCELLED");
  const grossProfit = wins.reduce((a, t) => a + (t.profitLoss ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + (t.profitLoss ?? 0), 0));
  const netPnl = closedToday.reduce((a, t) => a + (t.profitLoss ?? 0), 0);
  const winRate = closedToday.length > 0 ? (wins.length / closedToday.length) * 100 : 0;
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 9.99 : 0);
  const sortedByPnl = [...closedToday].sort((a, b) => (b.profitLoss ?? 0) - (a.profitLoss ?? 0));
  const bestTrade = sortedByPnl[0]?.profitLoss ?? null;
  const worstTrade = sortedByPnl[sortedByPnl.length - 1]?.profitLoss ?? null;
  const bestTradeId = sortedByPnl[0]?.id ?? null;
  const worstTradeId = sortedByPnl[sortedByPnl.length - 1]?.id ?? null;

  const symbolsTraded = Array.from(new Set([
    ...closedToday.map(t => t.symbol),
    ...openedToday.map(t => t.symbol),
  ]));

  // AI decisions THIS DAY.
  const decisions = await db.select().from(tradeDecisionLogsTable)
    .where(and(
      gte(tradeDecisionLogsTable.createdAt, dayStart),
      lte(tradeDecisionLogsTable.createdAt, dayEnd),
    ));

  // Debriefs THIS DAY.
  const debriefs = await db.select().from(postTradeDebriefsTable)
    .where(and(
      gte(postTradeDebriefsTable.createdAt, dayStart),
      lte(postTradeDebriefsTable.createdAt, dayEnd),
    ));

  // Learning events THIS DAY.
  const learnings = await db.select().from(learningEventsTable)
    .where(and(
      gte(learningEventsTable.createdAt, dayStart),
      lte(learningEventsTable.createdAt, dayEnd),
    ));

  // Aggregate mistake tags + top lesson.
  const mistakeBuckets: Record<string, number> = {};
  for (const lev of learnings) {
    const tags = Array.isArray(lev.mistakeTags) ? (lev.mistakeTags as string[]) : [];
    for (const t of tags) mistakeBuckets[t] = (mistakeBuckets[t] ?? 0) + 1;
  }
  const mistakeTags = Object.entries(mistakeBuckets).sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const topLesson = debriefs.find(d => d.lessonLearned && d.lessonLearned.length > 0)?.lessonLearned
    ?? learnings.find(l => l.lesson)?.lesson
    ?? "";

  return {
    date,
    total_trades: closedToday.length,
    wins: wins.length,
    losses: losses.length,
    break_even: breakEven.length,
    manual_closes: manualCloses.length,
    cancelled: cancelledRows.length,
    win_rate: Number(winRate.toFixed(2)),
    gross_profit: Number(grossProfit.toFixed(2)),
    gross_loss: Number(grossLoss.toFixed(2)),
    net_pnl: Number(netPnl.toFixed(2)),
    best_trade: bestTrade !== null ? Number(bestTrade.toFixed(2)) : null,
    worst_trade: worstTrade !== null ? Number(worstTrade.toFixed(2)) : null,
    best_trade_id: bestTradeId,
    worst_trade_id: worstTradeId,
    avg_win: Number(avgWin.toFixed(2)),
    avg_loss: Number(avgLoss.toFixed(2)),
    profit_factor: Number(profitFactor.toFixed(2)),
    symbols_traded: symbolsTraded,
    ai_decisions_count: decisions.length,
    paper_trades_opened: openedToday.length,
    paper_trades_closed: closedToday.length,
    debriefs_created: debriefs.length,
    learning_events_created: learnings.length,
    mistake_tags: mistakeTags,
    top_lesson: topLesson,
    day_rating: rateDay(netPnl, closedToday.length, winRate),
    day_status: statusForDay(netPnl, closedToday.length),
  };
}

/** Compute per-symbol stats over a range. */
export async function computeSymbolStats(range: RangeKey) {
  const { from, to } = rangeToWindow(range);
  const closed = await db.select().from(paperOrdersTable)
    .where(and(
      gte(paperOrdersTable.closedAt, from),
      lte(paperOrdersTable.closedAt, to),
    ));
  const bySymbol: Record<string, typeof closed> = {};
  for (const t of closed) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = [];
    bySymbol[t.symbol]!.push(t);
  }
  const edges = await db.select().from(strategyEdgesTable);
  const edgeBySymbol: Record<string, number> = {};
  for (const e of edges) {
    edgeBySymbol[e.symbol] = Math.max(edgeBySymbol[e.symbol] ?? -Infinity, e.edgeScore);
  }
  return Object.entries(bySymbol).map(([symbol, trades]) => {
    const wins = trades.filter(t => (t.profitLoss ?? 0) > 0.001);
    const losses = trades.filter(t => (t.profitLoss ?? 0) < -0.001);
    const netPnl = trades.reduce((a, t) => a + (t.profitLoss ?? 0), 0);
    const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
    const sorted = [...trades].sort((a, b) => (b.profitLoss ?? 0) - (a.profitLoss ?? 0));
    return {
      symbol,
      range_key: range,
      total_trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      win_rate: Number(winRate.toFixed(2)),
      net_pnl: Number(netPnl.toFixed(2)),
      avg_pnl: Number((netPnl / trades.length).toFixed(2)),
      best_trade_id: sorted[0]?.id ?? null,
      worst_trade_id: sorted[sorted.length - 1]?.id ?? null,
      mistake_tags: [] as string[],
      edge_score: Number((edgeBySymbol[symbol] ?? 0).toFixed(2)),
      learning_confidence: trades.length >= 30 ? 80 : trades.length >= 10 ? 50 : 20,
    };
  }).sort((a, b) => b.net_pnl - a.net_pnl);
}

/** Equity curve for a range — cumulative paper PnL by closed_at order. */
export async function computeEquityCurve(range: RangeKey) {
  const { from, to } = rangeToWindow(range);
  const closed = await db.select().from(paperOrdersTable)
    .where(and(
      gte(paperOrdersTable.closedAt, from),
      lte(paperOrdersTable.closedAt, to),
    ))
    .orderBy(paperOrdersTable.closedAt);
  let cumulative = 0;
  const points = closed.map(t => {
    cumulative += t.profitLoss ?? 0;
    return {
      trade_id: t.id,
      closed_at: t.closedAt,
      symbol: t.symbol,
      pnl: Number((t.profitLoss ?? 0).toFixed(2)),
      cumulative: Number(cumulative.toFixed(2)),
    };
  });
  return { points, final: Number(cumulative.toFixed(2)), trades: points.length };
}

/** Mistake-pattern ranking over a range (joined with learning events). */
export async function computeMistakes(range: RangeKey) {
  const { from, to } = rangeToWindow(range);
  const learnings = await db.select().from(learningEventsTable)
    .where(and(
      gte(learningEventsTable.createdAt, from),
      lte(learningEventsTable.createdAt, to),
    ));
  const bucket: Record<string, { count: number; lastLesson: string; lastTradeId: number | null }> = {};
  for (const lev of learnings) {
    const tags = Array.isArray(lev.mistakeTags) ? (lev.mistakeTags as string[]) : [];
    for (const t of tags) {
      if (!bucket[t]) bucket[t] = { count: 0, lastLesson: "", lastTradeId: null };
      bucket[t]!.count += 1;
      bucket[t]!.lastLesson = lev.lesson;
      bucket[t]!.lastTradeId = lev.tradeId;
    }
  }
  const patterns = await db.select().from(mistakePatternsTable);
  const severityBy: Record<string, number> = {};
  for (const p of patterns) severityBy[p.tag] = p.severityScore;
  return Object.entries(bucket).map(([tag, b]) => ({
    tag,
    occurrences: b.count,
    severity_score: severityBy[tag] ?? 0,
    last_lesson: b.lastLesson,
    last_trade_id: b.lastTradeId,
  })).sort((a, b) => b.occurrences - a.occurrences);
}

/** Recent lessons over a range. */
export async function computeLessons(range: RangeKey, limit = 25) {
  const { from, to } = rangeToWindow(range);
  const debriefs = await db.select().from(postTradeDebriefsTable)
    .where(and(
      gte(postTradeDebriefsTable.createdAt, from),
      lte(postTradeDebriefsTable.createdAt, to),
    ))
    .orderBy(desc(postTradeDebriefsTable.createdAt))
    .limit(limit);
  return debriefs.map(d => ({
    debrief_id: d.id,
    trade_id: d.tradeId,
    decision_id: d.decisionId,
    result: d.result,
    lesson: d.lessonLearned ?? "",
    ai_feedback: d.aiFeedback ?? "",
    created_at: d.createdAt,
  }));
}

/** Decision quality: ratio of AA decisions that became wins vs losses. */
export async function computeDecisionQuality(range: RangeKey) {
  const { from, to } = rangeToWindow(range);
  const decisions = await db.select().from(tradeDecisionLogsTable)
    .where(and(
      gte(tradeDecisionLogsTable.createdAt, from),
      lte(tradeDecisionLogsTable.createdAt, to),
    ));
  const closed = await db.select().from(paperOrdersTable)
    .where(and(
      gte(paperOrdersTable.closedAt, from),
      lte(paperOrdersTable.closedAt, to),
    ));
  const tradesByDecision = new Map<number, typeof closed[number]>();
  for (const t of closed) if (t.decisionId) tradesByDecision.set(t.decisionId, t);

  const shouldTrade = decisions.filter(d => d.shouldTrade);
  const hold = decisions.filter(d => !d.shouldTrade);
  const blocked = decisions.filter(d => d.shouldTrade && !tradesByDecision.has(d.id));
  const becameWin = decisions.filter(d => {
    const t = tradesByDecision.get(d.id);
    return t && (t.profitLoss ?? 0) > 0.001;
  });
  const becameLoss = decisions.filter(d => {
    const t = tradesByDecision.get(d.id);
    return t && (t.profitLoss ?? 0) < -0.001;
  });
  const traded = decisions.filter(d => tradesByDecision.has(d.id));
  const decisionToWinRate = traded.length ? (becameWin.length / traded.length) * 100 : 0;
  const avgConfidence = decisions.length ? decisions.reduce((a, d) => a + d.confidence, 0) / decisions.length : 0;
  const avgRiskScore = decisions.length ? decisions.reduce((a, d) => a + d.riskScore, 0) / decisions.length : 0;
  return {
    range,
    decisions_total: decisions.length,
    should_trade: shouldTrade.length,
    hold: hold.length,
    blocked: blocked.length,
    became_win: becameWin.length,
    became_loss: becameLoss.length,
    decision_to_win_rate: Number(decisionToWinRate.toFixed(2)),
    avg_confidence: Number(avgConfidence.toFixed(2)),
    avg_risk_score: Number(avgRiskScore.toFixed(2)),
    sample_size_label: decisions.length >= 30 ? "GOOD" : decisions.length >= 10 ? "LIMITED" : "LOW",
  };
}

/** Build calendar grid for a month YYYY-MM. */
export async function computeCalendarMonth(month: string) {
  // month = "2026-05"
  const [yearStr, monthStr] = month.split("-");
  const year = parseInt(yearStr ?? "0", 10);
  const m = parseInt(monthStr ?? "0", 10);
  if (!year || !m || m < 1 || m > 12) {
    return { month, days: [], total_pnl: 0, total_trades: 0, winning_days: 0, losing_days: 0 };
  }
  const daysInMonth = new Date(Date.UTC(year, m, 0)).getUTCDate();
  const days = [];
  let totalPnl = 0;
  let totalTrades = 0;
  let winningDays = 0;
  let losingDays = 0;
  let breakEvenDays = 0;
  let noTradeDays = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const stats = await computeDailyStats(dateStr);
    totalPnl += stats.net_pnl;
    totalTrades += stats.total_trades;
    if (stats.day_status === "WINNING_DAY") winningDays += 1;
    else if (stats.day_status === "LOSING_DAY") losingDays += 1;
    else if (stats.day_status === "BREAK_EVEN_DAY") breakEvenDays += 1;
    else noTradeDays += 1;
    days.push({
      date: dateStr,
      net_pnl: stats.net_pnl,
      total_trades: stats.total_trades,
      wins: stats.wins,
      losses: stats.losses,
      win_rate: stats.win_rate,
      day_rating: stats.day_rating,
      day_status: stats.day_status,
      debriefs_created: stats.debriefs_created,
      learning_events_created: stats.learning_events_created,
      symbols_traded: stats.symbols_traded,
    });
  }
  return {
    month,
    days,
    total_pnl: Number(totalPnl.toFixed(2)),
    total_trades: totalTrades,
    winning_days: winningDays,
    losing_days: losingDays,
    break_even_days: breakEvenDays,
    no_trade_days: noTradeDays,
  };
}

/** Per-day detail: trades + debriefs + decisions + learning events. */
export async function computeDayDetail(date: string) {
  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd = new Date(`${date}T23:59:59.999Z`);
  const stats = await computeDailyStats(date);

  // Detail = trades that touched this day (either opened OR closed today),
  // so PnL stats from `closed today` and detail rows are consistent.
  const openedToday = await db.select().from(paperOrdersTable)
    .where(and(
      gte(paperOrdersTable.openedAt, dayStart),
      lte(paperOrdersTable.openedAt, dayEnd),
    ));
  const closedToday = await db.select().from(paperOrdersTable)
    .where(and(
      gte(paperOrdersTable.closedAt, dayStart),
      lte(paperOrdersTable.closedAt, dayEnd),
    ));
  const seen = new Set<number>();
  const trades = [...openedToday, ...closedToday]
    .filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; })
    .sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());

  const decisionIds = trades.map(t => t.decisionId).filter((x): x is number => x !== null);
  const decisions = decisionIds.length
    ? await db.select().from(tradeDecisionLogsTable)
        .where(inArray(tradeDecisionLogsTable.id, decisionIds))
    : [];

  const tradeIds = trades.map(t => t.id);
  const debriefs = tradeIds.length
    ? await db.select().from(postTradeDebriefsTable)
        .where(inArray(postTradeDebriefsTable.tradeId, tradeIds))
    : [];
  const learnings = tradeIds.length
    ? await db.select().from(learningEventsTable)
        .where(inArray(learningEventsTable.tradeId, tradeIds))
    : [];

  const decisionsById = new Map(decisions.map(d => [d.id, d]));
  const debriefByTrade = new Map(debriefs.map(d => [d.tradeId, d]));
  const learningByTrade = new Map(learnings.map(l => [l.tradeId, l]));

  return {
    date,
    stats,
    trades: trades.map(t => {
      const dec = t.decisionId ? decisionsById.get(t.decisionId) : null;
      const dbf = debriefByTrade.get(t.id);
      const lev = learningByTrade.get(t.id);
      return {
        trade_id: t.id,
        symbol: t.symbol,
        action: t.direction,
        status: t.status,
        pnl: Number((t.profitLoss ?? 0).toFixed(2)),
        entry_price: t.entryPrice,
        exit_price: t.exitPrice,
        stop_loss: t.stopLoss,
        take_profit: t.takeProfit,
        opened_at: t.openedAt,
        closed_at: t.closedAt,
        decision_id: t.decisionId,
        decision: dec ? {
          action: dec.action, confidence: dec.confidence, risk_score: dec.riskScore,
          should_trade: dec.shouldTrade, entry_reason: dec.entryReason,
          trade_window_status: dec.tradeWindowStatus,
        } : null,
        debrief: dbf ? {
          debrief_id: dbf.id, result: dbf.result,
          lesson: dbf.lessonLearned, ai_feedback: dbf.aiFeedback,
        } : null,
        learning: lev ? {
          learning_event_id: lev.id, mistake_tags: lev.mistakeTags,
          lesson: lev.lesson,
        } : null,
        ai_followed_own_decision: dec ? (dec.shouldTrade && dec.action === t.direction) : null,
      };
    }),
  };
}

/** Range summary (7d/30d/90d/all). */
export async function computeRangeSummary(range: RangeKey) {
  const { from, to } = rangeToWindow(range);
  const closed = await db.select().from(paperOrdersTable)
    .where(and(
      gte(paperOrdersTable.closedAt, from),
      lte(paperOrdersTable.closedAt, to),
    ));
  const wins = closed.filter(t => (t.profitLoss ?? 0) > 0.001);
  const losses = closed.filter(t => (t.profitLoss ?? 0) < -0.001);
  const netPnl = closed.reduce((a, t) => a + (t.profitLoss ?? 0), 0);
  const grossProfit = wins.reduce((a, t) => a + (t.profitLoss ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + (t.profitLoss ?? 0), 0));
  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;

  // Group by day for best/worst day.
  const byDay: Record<string, number> = {};
  for (const t of closed) {
    const d = ymd(t.closedAt);
    if (!d) continue;
    byDay[d] = (byDay[d] ?? 0) + (t.profitLoss ?? 0);
  }
  const sortedDays = Object.entries(byDay).sort((a, b) => b[1] - a[1]);
  const bestDay = sortedDays[0] ? { date: sortedDays[0][0], pnl: Number(sortedDays[0][1].toFixed(2)) } : null;
  const worstDay = sortedDays[sortedDays.length - 1]
    ? { date: sortedDays[sortedDays.length - 1]![0], pnl: Number(sortedDays[sortedDays.length - 1]![1].toFixed(2)) }
    : null;

  // Best/worst symbol.
  const bySymbol: Record<string, number> = {};
  for (const t of closed) bySymbol[t.symbol] = (bySymbol[t.symbol] ?? 0) + (t.profitLoss ?? 0);
  const sortedSym = Object.entries(bySymbol).sort((a, b) => b[1] - a[1]);
  const bestSymbol = sortedSym[0]?.[0] ?? null;
  const worstSymbol = sortedSym[sortedSym.length - 1]?.[0] ?? null;

  // Mistake / lesson aggregation.
  const learnings = await db.select().from(learningEventsTable)
    .where(and(
      gte(learningEventsTable.createdAt, from),
      lte(learningEventsTable.createdAt, to),
    ));
  const mistakeBuckets: Record<string, number> = {};
  for (const lev of learnings) {
    const tags = Array.isArray(lev.mistakeTags) ? (lev.mistakeTags as string[]) : [];
    for (const t of tags) mistakeBuckets[t] = (mistakeBuckets[t] ?? 0) + 1;
  }
  const mostRepeatedMistake = Object.entries(mistakeBuckets).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    range,
    from, to,
    total_trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    break_even: closed.length - wins.length - losses.length,
    win_rate: Number(winRate.toFixed(2)),
    net_pnl: Number(netPnl.toFixed(2)),
    gross_profit: Number(grossProfit.toFixed(2)),
    gross_loss: Number(grossLoss.toFixed(2)),
    profit_factor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : (grossProfit > 0 ? 9.99 : 0),
    avg_daily_pnl: Object.keys(byDay).length ? Number((netPnl / Object.keys(byDay).length).toFixed(2)) : 0,
    best_day: bestDay,
    worst_day: worstDay,
    best_symbol: bestSymbol,
    worst_symbol: worstSymbol,
    most_repeated_mistake: mostRepeatedMistake,
    learning_events: learnings.length,
  };
}

/** Read-only Build FF autopilot summary (last cycle, today's cycles). */
export async function computeAutopilotSummary() {
  const recent = await db.select().from(autopilotCyclesTable)
    .orderBy(desc(autopilotCyclesTable.id)).limit(50);
  const today = new Date().toISOString().slice(0, 10);
  const todayCycles = recent.filter(c => ymd(c.startedAt) === today);
  const last = recent[0] ?? null;
  return {
    last_cycle: last ? {
      autopilot_cycle_id: last.autopilotCycleId,
      status: last.status,
      started_at: last.startedAt,
      finished_at: last.finishedAt,
      paper_trades_opened: last.paperTradesOpened,
      paper_trades_rejected: last.paperTradesRejected,
      paper_trades_closed: last.paperTradesClosed,
      debriefs_triggered: last.debriefsTriggered,
      learning_events_triggered: last.learningEventsTriggered,
    } : null,
    cycles_today: todayCycles.length,
    paper_trades_opened_today: todayCycles.reduce((a, c) => a + c.paperTradesOpened, 0),
    paper_trades_closed_today: todayCycles.reduce((a, c) => a + c.paperTradesClosed, 0),
    safety_blocks_today: todayCycles.reduce((a, c) => a + c.paperTradesRejected, 0),
    mode: "PAPER_ONLY" as const,
    live_trading_allowed: false as const,
  };
}
