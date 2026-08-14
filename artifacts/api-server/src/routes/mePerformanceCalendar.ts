// Phase 5D — Per-user performance calendar.
// Computed on-demand from paper_trades (no separate cache table; avoids stale
// rows). Returns daily aggregates only for the requesting user.
import { Router, type Request } from "express";
import { db, paperTradesTable } from "@workspace/db";
import { sharedTradeAttributionTable } from "@workspace/db/schema";
import { and, eq, isNotNull, gte, lte } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { getEnvelope } from "../lib/adminTrading/safetyEnvelope.js";
import { getUserModeScope } from "../lib/modeScope/getUserModeScope.js";

function isAdminReq(req: Request): boolean {
  const role = (req as Request & { authUser?: { role?: string } }).authUser?.role;
  return role === "ADMIN" || role === "OWNER";
}

const router = Router();

type DayAgg = {
  date: string;             // YYYY-MM-DD
  tradesCount: number;
  wins: number;
  losses: number;
  breakeven: number;
  totalPnl: number;
  totalRisk: number;
  bestTrade: number | null;
  worstTrade: number | null;
  winRate: number;          // 0..100
};

function dayKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Normalized closed-trade row the calendar aggregates over. Both the live
// (shared_trade_attribution) and paper (paper_trades) sources map into this.
type ClosedRow = {
  id: number;
  symbol: string;
  side: string;
  pnl: number | null;
  lotSize: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  strategyTag: string | null;
  riskAmount: number | null;
  closedAt: Date | null;
};

// Mode-aware loader. In LIVE mode the calendar reflects ONLY closed live trades
// (shared_trade_attribution). In demo/paper/simulated it reflects paper_trades.
// No mixing — a live calendar never shows paper P&L and vice-versa.
async function loadClosedRows(
  userId: number, fromIso?: string, toIso?: string,
): Promise<ClosedRow[]> {
  const env = await getEnvelope(userId);
  const isLive = env.tradingMode === "LIVE";

  if (isLive) {
    const conds = [
      eq(sharedTradeAttributionTable.userId, userId),
      eq(sharedTradeAttributionTable.status, "closed"),
      isNotNull(sharedTradeAttributionTable.closedAt),
    ];
    if (fromIso) conds.push(gte(sharedTradeAttributionTable.closedAt, new Date(fromIso)));
    if (toIso) conds.push(lte(sharedTradeAttributionTable.closedAt, new Date(toIso)));
    const rows = await db.select().from(sharedTradeAttributionTable).where(and(...conds));
    return rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      side: r.side,
      pnl: r.pnl ?? null,
      lotSize: r.lotSize ?? null,
      entryPrice: r.entryPrice ?? null,
      exitPrice: r.closePrice ?? null,
      strategyTag: null,
      riskAmount: null,
      closedAt: r.closedAt ?? null,
    }));
  }

  const conds = [
    eq(paperTradesTable.userId, userId),
    eq(paperTradesTable.status, "closed"),
    isNotNull(paperTradesTable.closedAt),
  ];
  if (fromIso) conds.push(gte(paperTradesTable.closedAt, new Date(fromIso)));
  if (toIso) conds.push(lte(paperTradesTable.closedAt, new Date(toIso)));
  const rows = await db.select().from(paperTradesTable).where(and(...conds));
  return rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    side: r.side,
    pnl: r.pnl ?? null,
    lotSize: r.lotSize ?? null,
    entryPrice: r.entryPrice ?? null,
    exitPrice: r.exitPrice ?? null,
    strategyTag: r.strategyTag ?? null,
    riskAmount: r.riskAmount ?? null,
    closedAt: r.closedAt ?? null,
  }));
}

function aggregate(rows: ClosedRow[]): Record<string, DayAgg> {
  const out: Record<string, DayAgg> = {};
  for (const r of rows) {
    if (!r.closedAt) continue;
    const key = dayKey(r.closedAt);
    const day: DayAgg = out[key] ?? { date: key, tradesCount: 0, wins: 0, losses: 0, breakeven: 0, totalPnl: 0, totalRisk: 0, bestTrade: null, worstTrade: null, winRate: 0 };
    const pnl = r.pnl ?? 0;
    day.tradesCount += 1;
    if (pnl > 0) day.wins += 1; else if (pnl < 0) day.losses += 1; else day.breakeven += 1;
    day.totalPnl = Number((day.totalPnl + pnl).toFixed(4));
    day.totalRisk = Number((day.totalRisk + (r.riskAmount ?? 0)).toFixed(4));
    day.bestTrade = day.bestTrade == null ? pnl : Math.max(day.bestTrade, pnl);
    day.worstTrade = day.worstTrade == null ? pnl : Math.min(day.worstTrade, pnl);
    day.winRate = day.tradesCount ? Number(((day.wins / day.tradesCount) * 100).toFixed(1)) : 0;
    out[key] = day;
  }
  return out;
}

// GET /api/me/performance-calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// MODE SCOPE: LIVE_SHARED users return an empty calendar. The user's
// shared-master live P&L is shown elsewhere (broker statement / live
// positions); this per-user calendar would only carry stale paper rows
// for a user who has since been armed for live. Mixing them would be a
// data leak across modes.
router.get("/me/performance-calendar", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const scope = await getUserModeScope(userId, { isAdmin: isAdminReq(req) });
  if (scope.currentAccountMode === "LIVE_SHARED") {
    res.json({
      days: [],
      isEmpty: true,
      currentAccountMode: scope.currentAccountMode,
      modeScopeApplied: true,
    });
    return;
  }
  const from = typeof req.query.from === "string" ? `${req.query.from}T00:00:00Z` : undefined;
  const to = typeof req.query.to === "string" ? `${req.query.to}T23:59:59Z` : undefined;
  const rows = await loadClosedRows(userId, from, to);
  const days = Object.values(aggregate(rows)).sort((a, b) => a.date.localeCompare(b.date));
  res.json({
    days,
    isEmpty: days.length === 0,
    currentAccountMode: scope.currentAccountMode,
    modeScopeApplied: true,
  });
});

// GET /api/me/performance-calendar/:date  (YYYY-MM-DD)
router.get("/me/performance-calendar/:date", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const date = String(req.params.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: "Invalid date" }); return; }
  const scope = await getUserModeScope(userId, { isAdmin: isAdminReq(req) });
  if (scope.currentAccountMode === "LIVE_SHARED") {
    res.json({
      date, tradesCount: 0, wins: 0, losses: 0, breakeven: 0,
      totalPnl: 0, totalRisk: 0, bestTrade: null, worstTrade: null, winRate: 0,
      trades: [],
      currentAccountMode: scope.currentAccountMode,
      modeScopeApplied: true,
    });
    return;
  }
  const rows = await loadClosedRows(userId, `${date}T00:00:00Z`, `${date}T23:59:59Z`);
  const agg = aggregate(rows)[date] ?? { date, tradesCount: 0, wins: 0, losses: 0, breakeven: 0, totalPnl: 0, totalRisk: 0, bestTrade: null, worstTrade: null, winRate: 0 };
  res.json({
    ...agg,
    trades: rows.map((r) => ({
      id: r.id, symbol: r.symbol, side: r.side, pnl: r.pnl, lotSize: r.lotSize,
      entryPrice: r.entryPrice, exitPrice: r.exitPrice, strategyTag: r.strategyTag,
      closedAt: r.closedAt?.toISOString() ?? null,
    })),
    currentAccountMode: scope.currentAccountMode,
    modeScopeApplied: true,
  });
});

// GET /api/me/performance-summary
router.get("/me/performance-summary", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const scope = await getUserModeScope(userId, { isAdmin: isAdminReq(req) });
  if (scope.currentAccountMode === "LIVE_SHARED") {
    res.json({
      totalTrades: 0, totalPnl: 0, wins: 0, losses: 0, breakeven: 0, winRate: 0,
      activeDays: 0, bestDay: null, worstDay: null, isEmpty: true,
      currentAccountMode: scope.currentAccountMode,
      modeScopeApplied: true,
    });
    return;
  }
  const rows = await loadClosedRows(userId);
  const totalTrades = rows.length;
  const totalPnl = Number(rows.reduce((s, r) => s + (r.pnl ?? 0), 0).toFixed(4));
  const wins = rows.filter((r) => (r.pnl ?? 0) > 0).length;
  const losses = rows.filter((r) => (r.pnl ?? 0) < 0).length;
  const breakeven = totalTrades - wins - losses;
  const winRate = totalTrades ? Number(((wins / totalTrades) * 100).toFixed(1)) : 0;
  const days = Object.values(aggregate(rows));
  const best = days.reduce<DayAgg | null>((b, d) => (b == null || d.totalPnl > b.totalPnl ? d : b), null);
  const worst = days.reduce<DayAgg | null>((b, d) => (b == null || d.totalPnl < b.totalPnl ? d : b), null);
  res.json({
    totalTrades, totalPnl, wins, losses, breakeven, winRate,
    activeDays: days.length,
    bestDay: best ? { date: best.date, pnl: best.totalPnl } : null,
    worstDay: worst ? { date: worst.date, pnl: worst.totalPnl } : null,
    isEmpty: totalTrades === 0,
    currentAccountMode: scope.currentAccountMode,
    modeScopeApplied: true,
  });
});

export default router;
