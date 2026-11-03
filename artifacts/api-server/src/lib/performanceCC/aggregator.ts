// Build GG — Performance aggregation service.
//
// SAFETY: Read-only against existing AA-FF tables. Never writes to live
// trading surfaces. Computes daily/symbol stats from paper_orders + decision
// logs + debriefs + learning events.

import { db } from "@workspace/db";
import { listOwnEdges, listOwnMistakes } from "../learning/scopedMemory.js";
import {
  paperOrdersTable,
  tradeDecisionLogsTable,
  postTradeDebriefsTable,
  learningEventsTable,
  autopilotCyclesTable,
} from "@workspace/db";
import { and, eq, gte, lte, desc, sql, inArray } from "drizzle-orm";
import { isUnsizedPaperClose, paperMoveSign } from "../paperExecution/paperPnl.js";

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

export type DayRating = "A" | "B" | "C" | "D" | "F";

type PaperOrderRow = typeof paperOrdersTable.$inferSelect;

/**
 * The P&L the paper venue booked on a closed paper order, or null when it is
 * not known. profit_loss is NOT NULL, so a close the venue could not size for
 * the instrument (no contract size or currency conversion) holds a 0
 * placeholder (paperExecution/paperPnl.ts isUnsizedPaperClose). That 0 is not
 * a break-even result: such a close is left out of every money figure here,
 * as Analytics does (routes/analytics.ts pnlOf).
 */
export function bookedPnlOf(t: Pick<PaperOrderRow, "status" | "profitLoss" | "entryPrice" | "exitPrice">): number | null {
  if (hasRealizedPnl(t.status) && isUnsizedPaperClose(t)) return null;
  return t.profitLoss ?? 0;
}

/**
 * Win (1), loss (-1) or break-even (0). A close whose P&L could not be sized
 * is a win or a loss by the direction of its price move, which needs no
 * contract size; it is never a break-even.
 */
export function outcomeOf(t: Pick<PaperOrderRow, "status" | "profitLoss" | "entryPrice" | "exitPrice" | "direction">): 1 | -1 | 0 {
  const pnl = bookedPnlOf(t);
  if (pnl == null) return t.exitPrice == null ? 0 : paperMoveSign(t.direction, t.entryPrice, t.exitPrice);
  return pnl > 0.001 ? 1 : pnl < -0.001 ? -1 : 0;
}

/**
 * Plain-English note on closes whose P&L could not be sized, or null when
 * every close was sized.
 */
export function unsizedPnlNote(unsized: number, closed: number, symbols: string[]): string | null {
  if (unsized === 0) return null;
  const list = symbols.length ? ` (${[...new Set(symbols)].sort().join(", ")})` : "";
  if (unsized >= closed) {
    return `P&L not measured: none of the ${closed} closed trade${closed === 1 ? "" : "s"}${list} could be sized for the instrument (no contract size or currency conversion). The money figures here are not results. Wins and losses are counted by the direction of the price move.`;
  }
  return `${unsized} of ${closed} closed trades${list} could not be sized for the instrument (no contract size or currency conversion), so their P&L is not known. They are left out of every money figure here, which can be higher or lower than the trades' real result. They still count as wins or losses by the direction of the price move.`;
}

/**
 * The sign of a day's real net P&L when it can be known: the sized closes'
 * net plus closes of unknown size whose direction is known. null when the
 * unsized closes could move the day either way.
 */
function daySign(sizedNet: number, unsizedWins: number, unsizedLosses: number): 1 | -1 | 0 | null {
  const sized = sizedNet > 0.001 ? 1 : sizedNet < -0.001 ? -1 : 0;
  if (unsizedWins === 0 && unsizedLosses === 0) return sized;
  if (unsizedLosses === 0 && sized >= 0) return 1;
  if (unsizedWins === 0 && sized <= 0) return -1;
  return null;
}

/**
 * A grade for the trades that closed on a day. null when nothing closed that
 * day (including days that have not happened yet): there is nothing to grade,
 * and "F" would read as a failed day. null too when trades whose P&L could not
 * be sized leave the day's result unknown.
 */
function rateDay(netPnl: number | null, trades: number, winRate: number): DayRating | null {
  if (trades === 0 || netPnl == null) return null;
  if (netPnl > 0 && winRate >= 70) return "A";
  if (netPnl > 0 && winRate >= 50) return "B";
  if (netPnl >= 0) return "C";
  if (winRate >= 30) return "D";
  return "F";
}

export type DayStatus = "WINNING_DAY" | "LOSING_DAY" | "BREAK_EVEN_DAY" | "NO_TRADE_DAY" | "NOT_SIZED_DAY";

/**
 * NOT_SIZED_DAY: trades closed, but some could not be sized and the day's
 * result could be a win or a loss.
 */
function statusForDay(netPnl: number | null, trades: number): DayStatus {
  if (trades === 0) return "NO_TRADE_DAY";
  if (netPnl == null) return "NOT_SIZED_DAY";
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
  /** Money figures below use only closes whose P&L was sized. */
  gross_profit: number;
  gross_loss: number;
  net_pnl: number;
  /** Closes whose P&L could not be sized: left out of every money figure. */
  unsized_trades: number;
  unsized_symbols: string[];
  /** Plain-English note on unsized closes; null when every close was sized. */
  pnl_note: string | null;
  best_trade: number | null;
  worst_trade: number | null;
  best_trade_id: number | null;
  worst_trade_id: number | null;
  avg_win: number;
  avg_loss: number;
  /**
   * null when no losing trade closed that day (undefined: nothing to divide
   * by), or when a close could not be sized (the ratio is not known).
   */
  profit_factor: number | null;
  symbols_traded: string[];
  ai_decisions_count: number;
  paper_trades_opened: number;
  paper_trades_closed: number;
  debriefs_created: number;
  learning_events_created: number;
  mistake_tags: string[];
  top_lesson: string;
  /** null when no trade closed that day, or unsized closes leave its result unknown — not graded. */
  day_rating: DayRating | null;
  day_status: DayStatus;
}

/** Compute the daily stats payload for one calendar date (YYYY-MM-DD, UTC). */
export async function computeDailyStats(userId: number, date: string): Promise<DailyStats> {
  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd = new Date(`${date}T23:59:59.999Z`);

  // Paper trades closed THIS DAY (drives PnL).
  const closedToday = await db.select().from(paperOrdersTable)
    .where(and(
      eq(paperOrdersTable.userId, userId),
      gte(paperOrdersTable.closedAt, dayStart),
      lte(paperOrdersTable.closedAt, dayEnd),
    ));

  // Paper trades opened THIS DAY.
  const openedToday = await db.select().from(paperOrdersTable)
    .where(and(
      eq(paperOrdersTable.userId, userId),
      gte(paperOrdersTable.openedAt, dayStart),
      lte(paperOrdersTable.openedAt, dayEnd),
    ));

  // Wins and losses count every close (an unsized one by its price move);
  // money figures use only closes whose P&L was sized.
  const wins = closedToday.filter(t => outcomeOf(t) > 0);
  const losses = closedToday.filter(t => outcomeOf(t) < 0);
  const breakEven = closedToday.filter(t => outcomeOf(t) === 0);
  const unsized = closedToday.filter(t => bookedPnlOf(t) == null);
  const sized = closedToday.filter(t => bookedPnlOf(t) != null);
  const sizedWins = sized.filter(t => outcomeOf(t) > 0);
  const sizedLosses = sized.filter(t => outcomeOf(t) < 0);
  const manualCloses = closedToday.filter(t => t.status === "CLOSED_MANUAL" || t.status === "PAPER_CLOSED_MANUAL");
  const cancelledRows = closedToday.filter(t => t.status === "CANCELLED");
  const grossProfit = sizedWins.reduce((a, t) => a + (t.profitLoss ?? 0), 0);
  const grossLoss = Math.abs(sizedLosses.reduce((a, t) => a + (t.profitLoss ?? 0), 0));
  const netPnl = sized.reduce((a, t) => a + (t.profitLoss ?? 0), 0);
  const winRate = closedToday.length > 0 ? (wins.length / closedToday.length) * 100 : 0;
  const avgWin = sizedWins.length ? grossProfit / sizedWins.length : 0;
  const avgLoss = sizedLosses.length ? grossLoss / sizedLosses.length : 0;
  // Gross profit ÷ gross loss. With no losing trade there is nothing to
  // divide by: undefined (null), never an invented cap such as 9.99. With an
  // unsized close the ratio is not known: null.
  const profitFactor = unsized.length === 0 && grossLoss > 0 ? grossProfit / grossLoss : null;
  const sortedByPnl = [...sized].sort((a, b) => (b.profitLoss ?? 0) - (a.profitLoss ?? 0));
  const bestTrade = sortedByPnl[0]?.profitLoss ?? null;
  const worstTrade = sortedByPnl[sortedByPnl.length - 1]?.profitLoss ?? null;
  const bestTradeId = sortedByPnl[0]?.id ?? null;
  const worstTradeId = sortedByPnl[sortedByPnl.length - 1]?.id ?? null;
  // The day's result: its sized net, or (with unsized closes) the sign the
  // day's real net must have, or null when it could go either way.
  const unsizedWins = unsized.filter(t => outcomeOf(t) > 0).length;
  const dayResult: number | null = unsized.length === 0
    ? netPnl
    : daySign(netPnl, unsizedWins, unsized.length - unsizedWins);
  const unsizedSymbols = Array.from(new Set(unsized.map(t => t.symbol))).sort();

  const symbolsTraded = Array.from(new Set([
    ...closedToday.map(t => t.symbol),
    ...openedToday.map(t => t.symbol),
  ]));

  // AI decisions THIS DAY.
  const decisions = await db.select().from(tradeDecisionLogsTable)
    .where(and(
      eq(tradeDecisionLogsTable.userId, userId),
      gte(tradeDecisionLogsTable.createdAt, dayStart),
      lte(tradeDecisionLogsTable.createdAt, dayEnd),
    ));

  // Debriefs THIS DAY.
  const debriefs = await db.select().from(postTradeDebriefsTable)
    .where(and(
      eq(postTradeDebriefsTable.userId, userId),
      gte(postTradeDebriefsTable.createdAt, dayStart),
      lte(postTradeDebriefsTable.createdAt, dayEnd),
    ));

  // Learning events THIS DAY.
  const learnings = await db.select().from(learningEventsTable)
    .where(and(
      eq(learningEventsTable.userId, userId),
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
    unsized_trades: unsized.length,
    unsized_symbols: unsizedSymbols,
    pnl_note: unsizedPnlNote(unsized.length, closedToday.length, unsizedSymbols),
    best_trade: bestTrade !== null ? Number(bestTrade.toFixed(2)) : null,
    worst_trade: worstTrade !== null ? Number(worstTrade.toFixed(2)) : null,
    best_trade_id: bestTradeId,
    worst_trade_id: worstTradeId,
    avg_win: Number(avgWin.toFixed(2)),
    avg_loss: Number(avgLoss.toFixed(2)),
    profit_factor: profitFactor == null ? null : Number(profitFactor.toFixed(2)),
    symbols_traded: symbolsTraded,
    ai_decisions_count: decisions.length,
    paper_trades_opened: openedToday.length,
    paper_trades_closed: closedToday.length,
    debriefs_created: debriefs.length,
    learning_events_created: learnings.length,
    mistake_tags: mistakeTags,
    top_lesson: topLesson,
    day_rating: rateDay(dayResult, closedToday.length, winRate),
    day_status: statusForDay(dayResult, closedToday.length),
  };
}

/** Compute per-symbol stats over a range. */
export async function computeSymbolStats(userId: number, range: RangeKey) {
  const { from, to } = rangeToWindow(range);
  const closed = await db.select().from(paperOrdersTable)
    .where(and(
      eq(paperOrdersTable.userId, userId),
      gte(paperOrdersTable.closedAt, from),
      lte(paperOrdersTable.closedAt, to),
    ));
  const bySymbol: Record<string, typeof closed> = {};
  for (const t of closed) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = [];
    bySymbol[t.symbol]!.push(t);
  }
  const edges = await listOwnEdges(userId);
  const edgeBySymbol: Record<string, number> = {};
  for (const e of edges) {
    edgeBySymbol[e.symbol] = Math.max(edgeBySymbol[e.symbol] ?? -Infinity, e.edgeScore);
  }
  return Object.entries(bySymbol).map(([symbol, trades]) => {
    // Wins and losses count every close; money figures only sized closes.
    const wins = trades.filter(t => outcomeOf(t) > 0);
    const losses = trades.filter(t => outcomeOf(t) < 0);
    const sized = trades.filter(t => bookedPnlOf(t) != null);
    const unsizedCount = trades.length - sized.length;
    const netPnl = sized.reduce((a, t) => a + (t.profitLoss ?? 0), 0);
    const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
    const sorted = [...sized].sort((a, b) => (b.profitLoss ?? 0) - (a.profitLoss ?? 0));
    return {
      symbol,
      range_key: range,
      total_trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      win_rate: Number(winRate.toFixed(2)),
      net_pnl: Number(netPnl.toFixed(2)),
      avg_pnl: sized.length ? Number((netPnl / sized.length).toFixed(2)) : 0,
      unsized_trades: unsizedCount,
      pnl_note: unsizedPnlNote(unsizedCount, trades.length, [symbol]),
      best_trade_id: sorted[0]?.id ?? null,
      worst_trade_id: sorted[sorted.length - 1]?.id ?? null,
      mistake_tags: [] as string[],
      edge_score: Number((edgeBySymbol[symbol] ?? 0).toFixed(2)),
      learning_confidence: trades.length >= 30 ? 80 : trades.length >= 10 ? 50 : 20,
    };
  }).sort((a, b) => b.net_pnl - a.net_pnl);
}

/**
 * Equity curve for a range — cumulative paper PnL by closed_at order. A close
 * whose P&L could not be sized has no point (its amount is not known); it is
 * counted in unsized_trades and pnl_note.
 */
export async function computeEquityCurve(userId: number, range: RangeKey) {
  const { from, to } = rangeToWindow(range);
  const all = await db.select().from(paperOrdersTable)
    .where(and(
      eq(paperOrdersTable.userId, userId),
      gte(paperOrdersTable.closedAt, from),
      lte(paperOrdersTable.closedAt, to),
    ))
    .orderBy(paperOrdersTable.closedAt);
  const closed = all.filter(t => bookedPnlOf(t) != null);
  const unsized = all.filter(t => bookedPnlOf(t) == null);
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
  return {
    points, final: Number(cumulative.toFixed(2)), trades: points.length,
    unsized_trades: unsized.length,
    pnl_note: unsizedPnlNote(unsized.length, all.filter(t => hasRealizedPnl(t.status)).length, unsized.map(t => t.symbol)),
  };
}

/** Mistake-pattern ranking over a range (joined with learning events). */
export async function computeMistakes(userId: number, range: RangeKey) {
  const { from, to } = rangeToWindow(range);
  const learnings = await db.select().from(learningEventsTable)
    .where(and(
      eq(learningEventsTable.userId, userId),
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
  const patterns = await listOwnMistakes(userId);
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
export async function computeLessons(userId: number, range: RangeKey, limit = 25) {
  const { from, to } = rangeToWindow(range);
  const debriefs = await db.select().from(postTradeDebriefsTable)
    .where(and(
      eq(postTradeDebriefsTable.userId, userId),
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
export async function computeDecisionQuality(userId: number, range: RangeKey) {
  const { from, to } = rangeToWindow(range);
  const decisions = await db.select().from(tradeDecisionLogsTable)
    .where(and(
      eq(tradeDecisionLogsTable.userId, userId),
      gte(tradeDecisionLogsTable.createdAt, from),
      lte(tradeDecisionLogsTable.createdAt, to),
    ));
  const closed = await db.select().from(paperOrdersTable)
    .where(and(
      eq(paperOrdersTable.userId, userId),
      gte(paperOrdersTable.closedAt, from),
      lte(paperOrdersTable.closedAt, to),
    ));
  const tradesByDecision = new Map<number, typeof closed[number]>();
  for (const t of closed) if (t.decisionId) tradesByDecision.set(t.decisionId, t);

  const shouldTrade = decisions.filter(d => d.shouldTrade);
  const hold = decisions.filter(d => !d.shouldTrade);
  const blocked = decisions.filter(d => d.shouldTrade && !tradesByDecision.has(d.id));
  // An unsized close is a win or a loss by its price move, not a break-even.
  const becameWin = decisions.filter(d => {
    const t = tradesByDecision.get(d.id);
    return t && outcomeOf(t) > 0;
  });
  const becameLoss = decisions.filter(d => {
    const t = tradesByDecision.get(d.id);
    return t && outcomeOf(t) < 0;
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

/**
 * The ledger the Trading Calendar reads. It is not the demo-trade journal
 * behind My Demo Trades (/my-performance, paper_trades): the two record different trades and
 * compute P&L differently, so their figures for the same date differ.
 */
export const CALENDAR_SOURCE = "PAPER_ORDERS" as const;
export const CALENDAR_SOURCE_NOTE =
  "From your simulated orders (Paper Autopilot and simulated trade tickets). Demo trades you log by hand on My Demo Trades are a separate record and are not included; their P&L is computed differently, so the two pages will not match.";

/** Build calendar grid for a month YYYY-MM. */
export async function computeCalendarMonth(userId: number, month: string) {
  // month = "2026-05"
  const [yearStr, monthStr] = month.split("-");
  const year = parseInt(yearStr ?? "0", 10);
  const m = parseInt(monthStr ?? "0", 10);
  if (!year || !m || m < 1 || m > 12) {
    return {
      month, days: [], total_pnl: 0, total_trades: 0, winning_days: 0, losing_days: 0,
      unsized_trades: 0, pnl_note: null,
      source: CALENDAR_SOURCE, source_note: CALENDAR_SOURCE_NOTE,
    };
  }
  const daysInMonth = new Date(Date.UTC(year, m, 0)).getUTCDate();
  // Days after today (UTC) have not happened: they are flagged, and are not
  // counted as no-trade days.
  const todayUtc = new Date().toISOString().slice(0, 10);
  const days = [];
  let totalPnl = 0;
  let totalTrades = 0;
  let winningDays = 0;
  let losingDays = 0;
  let breakEvenDays = 0;
  let noTradeDays = 0;
  let notSizedDays = 0;
  let unsizedTrades = 0;
  const unsizedSymbols: string[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const stats = await computeDailyStats(userId, dateStr);
    const isFuture = dateStr > todayUtc;
    totalPnl += stats.net_pnl;
    totalTrades += stats.total_trades;
    unsizedTrades += stats.unsized_trades;
    unsizedSymbols.push(...stats.unsized_symbols);
    if (stats.day_status === "WINNING_DAY") winningDays += 1;
    else if (stats.day_status === "LOSING_DAY") losingDays += 1;
    else if (stats.day_status === "BREAK_EVEN_DAY") breakEvenDays += 1;
    else if (stats.day_status === "NOT_SIZED_DAY") notSizedDays += 1;
    else if (!isFuture) noTradeDays += 1;
    days.push({
      date: dateStr,
      is_future: isFuture,
      net_pnl: stats.net_pnl,
      total_trades: stats.total_trades,
      wins: stats.wins,
      losses: stats.losses,
      win_rate: stats.win_rate,
      day_rating: stats.day_rating,
      day_status: stats.day_status,
      unsized_trades: stats.unsized_trades,
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
    /** Days whose result could be a win or a loss (some closes could not be sized). */
    not_sized_days: notSizedDays,
    /** total_pnl uses only closes whose P&L was sized. */
    unsized_trades: unsizedTrades,
    pnl_note: unsizedPnlNote(unsizedTrades, totalTrades, unsizedSymbols),
    source: CALENDAR_SOURCE,
    source_note: CALENDAR_SOURCE_NOTE,
  };
}

/** A paper order whose P&L is a realized result (it closed with a fill). */
function hasRealizedPnl(status: string | null | undefined): boolean {
  return typeof status === "string" && (status.startsWith("CLOSED") || status.startsWith("PAPER_CLOSED"));
}

/**
 * Why a day-detail row has no P&L. profit_loss is NOT NULL default 0 and is
 * written only when an order closes, so on an open or cancelled order the 0
 * is not a measurement; on a close that could not be sized it is a
 * placeholder.
 */
function noPnlNote(t: Pick<PaperOrderRow, "status" | "profitLoss" | "entryPrice" | "exitPrice" | "direction">): string | null {
  const status = t.status;
  if (hasRealizedPnl(status)) {
    if (bookedPnlOf(t) != null) return null;
    const moved = outcomeOf(t) > 0 ? "in your favour" : "against you";
    return `P&L not known: this trade could not be sized for the instrument (no contract size or currency conversion), so it is left out of the day's P&L. The price moved ${moved}.`;
  }
  if (status === "OPEN") return "Still open — no realized P&L yet (unrealized P&L is not recorded on the order).";
  if (status === "CANCELLED") return "Cancelled — no P&L.";
  return "No realized P&L recorded for this order.";
}

/** Per-day detail: trades + debriefs + decisions + learning events. */
export async function computeDayDetail(userId: number, date: string) {
  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd = new Date(`${date}T23:59:59.999Z`);
  const stats = await computeDailyStats(userId, date);

  // Detail = trades that touched this day (either opened OR closed today),
  // so PnL stats from `closed today` and detail rows are consistent.
  const openedToday = await db.select().from(paperOrdersTable)
    .where(and(
      eq(paperOrdersTable.userId, userId),
      gte(paperOrdersTable.openedAt, dayStart),
      lte(paperOrdersTable.openedAt, dayEnd),
    ));
  const closedToday = await db.select().from(paperOrdersTable)
    .where(and(
      eq(paperOrdersTable.userId, userId),
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
        .where(and(eq(tradeDecisionLogsTable.userId, userId), inArray(tradeDecisionLogsTable.id, decisionIds)))
    : [];

  const tradeIds = trades.map(t => t.id);
  const debriefs = tradeIds.length
    ? await db.select().from(postTradeDebriefsTable)
        .where(and(eq(postTradeDebriefsTable.userId, userId), inArray(postTradeDebriefsTable.tradeId, tradeIds)))
    : [];
  const learnings = tradeIds.length
    ? await db.select().from(learningEventsTable)
        .where(and(eq(learningEventsTable.userId, userId), inArray(learningEventsTable.tradeId, tradeIds)))
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
        // null unless the order closed with a sized P&L: an open or cancelled
        // order's stored 0 is not a result, nor is an unsized close's placeholder.
        pnl: hasRealizedPnl(t.status) && bookedPnlOf(t) != null ? Number((t.profitLoss ?? 0).toFixed(2)) : null,
        pnl_note: noPnlNote(t),
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
export async function computeRangeSummary(userId: number, range: RangeKey) {
  const { from, to } = rangeToWindow(range);
  const closed = await db.select().from(paperOrdersTable)
    .where(and(
      eq(paperOrdersTable.userId, userId),
      gte(paperOrdersTable.closedAt, from),
      lte(paperOrdersTable.closedAt, to),
    ));
  // Wins and losses count every close (an unsized one by its price move);
  // money figures use only closes whose P&L was sized.
  const wins = closed.filter(t => outcomeOf(t) > 0);
  const losses = closed.filter(t => outcomeOf(t) < 0);
  const sized = closed.filter(t => bookedPnlOf(t) != null);
  const unsized = closed.filter(t => bookedPnlOf(t) == null);
  const netPnl = sized.reduce((a, t) => a + (t.profitLoss ?? 0), 0);
  const grossProfit = sized.filter(t => outcomeOf(t) > 0).reduce((a, t) => a + (t.profitLoss ?? 0), 0);
  const grossLoss = Math.abs(sized.filter(t => outcomeOf(t) < 0).reduce((a, t) => a + (t.profitLoss ?? 0), 0));
  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;

  // Group by day for best/worst day. A day or symbol with an unsized close
  // has an unknown net, so it is not ranked.
  const unsizedDays = new Set(unsized.map(t => ymd(t.closedAt)));
  const unsizedSymbolSet = new Set(unsized.map(t => t.symbol));
  const byDay: Record<string, number> = {};
  for (const t of sized) {
    const d = ymd(t.closedAt);
    if (!d || unsizedDays.has(d)) continue;
    byDay[d] = (byDay[d] ?? 0) + (t.profitLoss ?? 0);
  }
  const sortedDays = Object.entries(byDay).sort((a, b) => b[1] - a[1]);
  const bestDay = sortedDays[0] ? { date: sortedDays[0][0], pnl: Number(sortedDays[0][1].toFixed(2)) } : null;
  const worstDay = sortedDays[sortedDays.length - 1]
    ? { date: sortedDays[sortedDays.length - 1]![0], pnl: Number(sortedDays[sortedDays.length - 1]![1].toFixed(2)) }
    : null;

  // Best/worst symbol.
  const bySymbol: Record<string, number> = {};
  for (const t of sized) {
    if (unsizedSymbolSet.has(t.symbol)) continue;
    bySymbol[t.symbol] = (bySymbol[t.symbol] ?? 0) + (t.profitLoss ?? 0);
  }
  const sortedSym = Object.entries(bySymbol).sort((a, b) => b[1] - a[1]);
  const bestSymbol = sortedSym[0]?.[0] ?? null;
  const worstSymbol = sortedSym[sortedSym.length - 1]?.[0] ?? null;
  const closedDays = new Set(closed.map(t => ymd(t.closedAt)).filter((d): d is string => d != null));

  // Mistake / lesson aggregation.
  const learnings = await db.select().from(learningEventsTable)
    .where(and(
      eq(learningEventsTable.userId, userId),
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
    unsized_trades: unsized.length,
    pnl_note: unsizedPnlNote(unsized.length, closed.length, unsized.map(t => t.symbol)),
    // null with no losing trade (undefined), never an invented 9.99; null
    // too with an unsized close (the ratio is not known).
    profit_factor: unsized.length === 0 && grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : null,
    // null with an unsized close: the days' total is not known.
    avg_daily_pnl: unsized.length > 0 ? null : closedDays.size ? Number((netPnl / closedDays.size).toFixed(2)) : 0,
    best_day: bestDay,
    worst_day: worstDay,
    best_symbol: bestSymbol,
    worst_symbol: worstSymbol,
    most_repeated_mistake: mostRepeatedMistake,
    learning_events: learnings.length,
  };
}

/**
 * When the summary is handed a window of the user's latest cycles (rather than
 * every cycle started today), the window holds this many cycles.
 */
export const AUTOPILOT_SUMMARY_READ_LIMIT = 50;

/**
 * Read-only Build FF autopilot summary (last cycle, today's cycles).
 *
 * "Today" is the UTC calendar day. Every cycle started today is counted: the
 * counts used to be taken from the newest 50 cycles only, so at the default
 * 60-second interval they stopped at about the last 50 minutes.
 */
export async function computeAutopilotSummary(userId: number) {
  const now = new Date();
  const lastRows = await db.select().from(autopilotCyclesTable)
    .where(eq(autopilotCyclesTable.userId, userId))
    .orderBy(desc(autopilotCyclesTable.id)).limit(1);
  const todayStart = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const todayCycles = await db.select().from(autopilotCyclesTable)
    .where(and(
      eq(autopilotCyclesTable.userId, userId),
      gte(autopilotCyclesTable.startedAt, todayStart),
    ));
  return summarizeAutopilotCycles(todayCycles, now, { last: lastRows[0] ?? null, wholeDay: true });
}

type AutopilotCycleRow = typeof autopilotCyclesTable.$inferSelect;

/**
 * What safety_blocks_today counts. It sums autopilot_cycles.paper_trades_rejected,
 * which the paper autopilot increments for every symbol a cycle did not open
 * a trade for (autopilotService: DAILY_LOSS_LIMIT, AA_HOLD, any sniper result
 * other than PASS, any paper-execution refusal). Ordinary AI holds are the
 * bulk of it, so the field name is kept for compatibility and this says what
 * it is.
 */
export const SAFETY_BLOCKS_TODAY_BASIS =
  "Counts each symbol a paper autopilot cycle did not open a trade for today (UTC): the AI decided to hold, the daily paper loss limit was reached, the sniper filter skipped it, or paper execution refused it. Ordinary AI holds are included, so this is not a count of safety blocks.";

/**
 * Summarise autopilot cycles. `wholeDay: true` means `recent` is every cycle
 * started today (UTC), so the counts are totals. Otherwise `recent` is a window
 * of the latest AUTOPILOT_SUMMARY_READ_LIMIT cycles, and when every cycle in it
 * started today the counts are lower bounds (`today_counts_capped`).
 */
export function summarizeAutopilotCycles(
  recent: AutopilotCycleRow[],
  now: Date,
  opts: { last?: AutopilotCycleRow | null; wholeDay?: boolean } = {},
) {
  const today = now.toISOString().slice(0, 10);
  const wholeDay = opts.wholeDay === true;
  const todayCycles = wholeDay ? recent : recent.filter(c => ymd(c.startedAt) === today);
  const last = opts.last !== undefined ? opts.last : (recent[0] ?? null);
  const todayCountsCapped = !wholeDay
    && recent.length >= AUTOPILOT_SUMMARY_READ_LIMIT && todayCycles.length === recent.length;
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
    today_utc: today,
    /** "Today" is the UTC calendar day. */
    today_basis: "UTC" as const,
    /** false: no autopilot cycle started today, so every "today" count is 0 because nothing ran. */
    ran_today: todayCycles.length > 0,
    cycles_today: todayCycles.length,
    paper_trades_opened_today: todayCycles.reduce((a, c) => a + c.paperTradesOpened, 0),
    paper_trades_closed_today: todayCycles.reduce((a, c) => a + c.paperTradesClosed, 0),
    safety_blocks_today: todayCycles.reduce((a, c) => a + c.paperTradesRejected, 0),
    /** safety_blocks_today counts every not-opened symbol, AI holds included. */
    safety_blocks_today_basis: SAFETY_BLOCKS_TODAY_BASIS,
    /** True when the today counts may be undercounted by the read window (never for a whole-day read). */
    today_counts_capped: todayCountsCapped,
    /** The read window's size, or null when every cycle started today was read. */
    cycles_read_limit: wholeDay ? null : AUTOPILOT_SUMMARY_READ_LIMIT,
    mode: "PAPER_ONLY" as const,
    live_trading_allowed: false as const,
  };
}
