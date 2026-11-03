// (Z) Build Z — Institutional Analytics & Command Center routes.
//
// ISOLATION: read-only across paper orders, debriefs, journal, skill, weekly
// reviews, edge reports. Writes only own 2 tables + vault audit. Never references
// trade execution / mt5_* / safetyCore / canPlaceTrades / risk mutation.
//
// OWNERSHIP: every aggregate is computed only from req.authUser's own rows,
// and snapshots / heatmaps are stamped with and read by that user.
//
// Honesty: no projections, no "expected return," no "guaranteed" anywhere.
// Every response carries a disclaimer that past data does not predict future P&L.

import { Router } from "express";
import {
  db, analyticsSnapshotsTable, analyticsHeatmapsTable,
  paperOrdersTable, postTradeDebriefsTable, tradeJournalEntriesTable,
  traderSkillProfilesTable, weeklyPerformanceReviewsTable,
  vaultEventsTable,
} from "@workspace/db";
import { asc, desc, eq } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { paperMoveSign, paperPnl } from "../lib/paperExecution/paperPnl.js";
import { loadLatestSlices } from "./edgeDiscovery.js";

const router = Router();
const ANALYTICS_DISCLAIMER =
  "Analytics summarize HISTORICAL behavior and outcomes. Past performance does NOT predict future results. Use these views to study process, not to size up expected profit.";

function ok(res: import("express").Response, body: Record<string, unknown>) {
  return res.json({ ...body, system: "analytics", disclaimer: ANALYTICS_DISCLAIMER });
}
function fail(res: import("express").Response, status: number, error: string) {
  return res.status(status).json({ error, system: "analytics", disclaimer: ANALYTICS_DISCLAIMER });
}
async function vaultAnalytics(kind: string, payload: Record<string, unknown>) {
  await db.insert(vaultEventsTable).values({
    kind, severity: "INFO", source: "SYSTEM", truthDomain: "BEHAVIOR",
    summary: kind, payload: { ...payload, analytics: true },
    reasons: [], blockers: [], generatedAtIso: new Date().toISOString(),
  }).catch(() => { /* non-fatal */ });
}

// ── Helpers ─────────────────────────────────────────────────────────────────
// Paper-order statuses are OPEN | CLOSED_TP | CLOSED_SL | CLOSED_MANUAL
// (and the legacy "CLOSED" used by some seeders). A trade is closed iff
// status starts with CLOSED OR exitPrice is set and status !== OPEN.
function isClosed(o: typeof paperOrdersTable.$inferSelect): boolean {
  return o.status !== "OPEN" && o.exitPrice != null;
}
// P&L of a closed order in USD at the instrument's contract size (the sizing
// rule in lib/mt5/contractSize.ts, via paperPnl). It used to be
// Δprice × lots × 100 for every symbol, so a 1.00-lot, 100-pip EURUSD trade
// read $1 instead of $1,000. null = the order cannot be sized honestly (no
// broker contract spec and not a fiat currency pair, or no FX conversion):
// it is left out of every money figure and counted in pnlCoverage, never
// booked as $0.
function pnlOf(o: typeof paperOrdersTable.$inferSelect): number | null {
  if (!isClosed(o) || o.exitPrice == null) return null;
  return paperPnl({
    symbol: o.symbol, direction: o.direction, lots: o.lotSize,
    entry: o.entryPrice, price: o.exitPrice,
  }).amount;
}
/** Win / loss by the direction of the price move — needs no contract size. */
function outcomeSign(o: typeof paperOrdersTable.$inferSelect): 1 | -1 | 0 {
  return o.exitPrice == null ? 0 : paperMoveSign(o.direction, o.entryPrice, o.exitPrice);
}
export interface PnlCoverage {
  closedTrades: number;
  /** Closed trades whose P&L could be sized in USD; every money figure uses only these. */
  sizedTrades: number;
  unsizedTrades: number;
  /** Symbols with at least one closed trade that could not be sized. */
  unsizedSymbols: string[];
  /** Plain-English basis of the money figures. */
  note: string;
}
function pnlCoverageOf(closed: Array<typeof paperOrdersTable.$inferSelect>): PnlCoverage {
  const unsized = closed.filter((o) => pnlOf(o) == null);
  const sizedTrades = closed.length - unsized.length;
  const unsizedSymbols = [...new Set(unsized.map((o) => o.symbol))].sort();
  const basis = "P&L is in USD at each instrument's contract size (100,000 units per lot for a currency pair).";
  const note = unsized.length === 0
    ? basis
    : sizedTrades === 0
      ? `P&L not measured: none of your ${closed.length} closed trades could be sized in USD (${unsizedSymbols.join(", ")} — no contract size or no USD conversion). Money figures here are not results.`
      : `${basis} ${unsized.length} of ${closed.length} closed trades (${unsizedSymbols.join(", ")}) could not be sized and are left out of every money figure.`;
  return { closedTrades: closed.length, sizedTrades, unsizedTrades: unsized.length, unsizedSymbols, note };
}
function maxDrawdown(equityCurve: Array<{ pnl: number }>): number {
  let peak = 0, cum = 0, mdd = 0;
  for (const p of equityCurve) {
    cum += p.pnl;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}
// Session of a trade by its open time (UTC hour). New York closes at 21:00
// UTC (the same boundary as lib/domain resolveSession); 21:00–07:00 is the
// Sydney and Tokyo (Asia-Pacific) session, not New York.
export const SESSION_BASIS =
  "Sessions are by each trade's open time in UTC: ASIA 21:00–07:00 (Sydney and Tokyo), LONDON 07:00–13:00, NEWYORK 13:00–21:00.";
export function sessionOf(d: Date): "ASIA"|"LONDON"|"NEWYORK" {
  const h = d.getUTCHours();
  if (h >= 7 && h < 13) return "LONDON";
  if (h >= 13 && h < 21) return "NEWYORK";
  return "ASIA";
}

// Every analytics board reads ALL of the caller's paper orders, oldest first
// (chronological order is needed for the peak-to-trough drawdown math). They
// used to read `.limit(1000)`: the OLDEST 1000 for the snapshot tiles and the
// drawdown, an unordered 1000 for the strategy table and the newest 1000 by id
// for the heatmaps, so past 1000 orders the newest trades fell out of some
// panels while others counted them.
async function loadPaperOrders(userId: number) {
  return db.select().from(paperOrdersTable).where(eq(paperOrdersTable.userId, userId))
    .orderBy(asc(paperOrdersTable.openedAt), asc(paperOrdersTable.id));
}

// ── Compute snapshot from current data ──────────────────────────────────────
// EXPORTED so Build BB's auto-debrief service can recompute analytics
// in-process after a closed-trade event without an internal HTTP hop.
export async function computeSnapshot(userId: number) {
  const [orders, skill, debriefs, edges] = await Promise.all([
    loadPaperOrders(userId),
    db.select().from(traderSkillProfilesTable).where(eq(traderSkillProfilesTable.userId, userId))
      .orderBy(desc(traderSkillProfilesTable.updatedAt)).limit(1),
    db.select().from(postTradeDebriefsTable).where(eq(postTradeDebriefsTable.userId, userId))
      .orderBy(desc(postTradeDebriefsTable.id)).limit(200),
    // The edge board's current picture (newest generation of each slice,
    // legacy no-losses-marker rows re-derived), not the raw report rows.
    loadLatestSlices(userId),
  ]);
  const closed = orders.filter((o) => isClosed(o));
  // Money figures use only trades whose P&L could be sized (see pnlOf).
  const pnls = closed.map((o) => pnlOf(o)).filter((p): p is number => p != null);
  const totalTrades = closed.length;
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossWin = wins.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));
  // Nothing measured is null, never 0: with no closed trade there is no win
  // rate, and with no sized trade there is no P&L, expectancy or drawdown (a
  // 0 read as a measured break-even, a 0% win rate or a $0 drawdown).
  const sized = pnls.length > 0;
  const netProfitLoss: number | null = sized ? pnls.reduce((s, p) => s + p, 0) : null;
  // A win is a favourable price move, so unsized trades still count here.
  const winCount = closed.filter((o) => outcomeSign(o) > 0).length;
  const winRate: number | null = totalTrades ? winCount / totalTrades : null;
  const expectancy: number | null = sized ? netProfitLoss! / pnls.length : null;
  // Profit factor is gross win / gross loss: undefined with no losing trade
  // (it was stored as the 999 marker and shown as "∞") or no sized trade.
  const profitFactorBasis: "MEASURED" | "NO_LOSING_TRADE" | "NO_WIN_OR_LOSS" | "NO_SIZED_TRADES" =
    !sized ? "NO_SIZED_TRADES" : grossLoss > 0 ? "MEASURED" : grossWin > 0 ? "NO_LOSING_TRADE" : "NO_WIN_OR_LOSS";
  const profitFactor: number | null = profitFactorBasis === "MEASURED" ? grossWin / grossLoss : null;
  // Average reward/risk per trade (R-multiple). A trade with no stop distance
  // has no R; it is left out (it used to count as 0R).
  const rrs = closed.flatMap((o) => {
    const risk = Math.abs(o.entryPrice - o.stopLoss);
    if (risk <= 0 || o.exitPrice == null) return [];
    const dir = o.direction === "BUY" ? 1 : -1;
    return [((o.exitPrice - o.entryPrice) * dir) / risk];
  }).filter((r) => Number.isFinite(r));
  const averageRr: number | null = rrs.length ? rrs.reduce((s, r) => s + r, 0) / rrs.length : null;
  const mdd: number | null = sized ? maxDrawdown(pnls.map((p) => ({ pnl: p }))) : null;

  // Best / worst SYMBOL by the net P&L of its sized trades. These were called
  // "strategy", but they group by symbol: paper_orders.strategy_id holds the
  // execution path (e.g. build_ee_paper_execution) or nothing, not a strategy.
  // The best must be net profitable and the worst net losing, so one symbol
  // is never both and a losing symbol is never "strongest".
  const bySymbol = new Map<string, number>();
  for (const o of closed) {
    const p = pnlOf(o);
    if (p == null) continue; // ranked by P&L, so only sized trades rank
    bySymbol.set(o.symbol, (bySymbol.get(o.symbol) ?? 0) + p);
  }
  const symbolsByPnl = [...bySymbol.entries()].sort((a, b) => b[1] - a[1]);
  const top = symbolsByPnl[0];
  const bottom = symbolsByPnl.at(-1);
  const strongestSymbol = top && top[1] > 0 ? top[0] : null;
  const weakestSymbol = bottom && bottom[1] < 0 ? bottom[0] : null;

  // Strongest / weakest EDGE SLICE from Edge Discovery's current reports.
  // These were called "market condition", but no report records one (the
  // column is always null), so the card showed a slice name such as
  // "symbol=EURUSD", ranked by report confidence alone. Now: the strongest is
  // a STRONG/DEVELOPING slice (strong first, then confidence), the weakest a
  // NO/WEAK slice (no edge first, then confidence); a slice with too little
  // data is neither.
  const statusRank: Record<string, number> = { STRONG_EDGE: 2, DEVELOPING_EDGE: 1, NO_EDGE: 2, WEAK_EDGE: 1 };
  const byStatusThenConfidence = (a: typeof edges[number], b: typeof edges[number]) =>
    ((statusRank[b.status] ?? 0) - (statusRank[a.status] ?? 0)) || (b.confidenceScore - a.confidenceScore);
  const positive = edges.filter((e) => e.status === "STRONG_EDGE" || e.status === "DEVELOPING_EDGE").sort(byStatusThenConfidence);
  const negative = edges.filter((e) => e.status === "NO_EDGE" || e.status === "WEAK_EDGE").sort(byStatusThenConfidence);
  const strongestEdgeSlice = positive[0] ? describeEdgeSlice(positive[0]) : null;
  const weakestEdgeSlice = negative[0] ? describeEdgeSlice(negative[0]) : null;
  // Stored columns keep their names (no schema change): the "strategy"
  // columns have always held a symbol, the "market condition" columns a slice.
  const strongestStrategy = strongestSymbol;
  const weakestStrategy = weakestSymbol;
  const strongestMarketCondition = strongestEdgeSlice?.edgeName ?? null;
  const weakestMarketCondition = weakestEdgeSlice?.edgeName ?? null;

  // Behavioral averages. Discipline, execution and consistency come from the
  // Trader Skill profile, which is null when none has been computed (they
  // read 0/100, a failing score, for a user nothing was measured on). The
  // profile's discipline and execution pillars are measured only from
  // post-trade debriefs (traderSkill computeSubScores), and consistency only
  // from edge reports, so with none of those the stored 0 is a placeholder.
  const sk = skill[0] ?? null;
  const hasDebriefs = debriefs.length > 0;
  const hasEdgeReports = edges.length > 0;
  const calmCount = debriefs.filter((d) => d.traderEmotionAfter === "CALM").length;
  const emotionalScoreAvg: number | null = hasDebriefs ? (calmCount / debriefs.length) * 100 : null;
  const disciplineScoreAvg: number | null = sk && hasDebriefs ? sk.disciplineScore : null;
  const executionScoreAvg: number | null = sk && hasDebriefs ? sk.executionScore : null;
  const consistencyScoreAvg: number | null = sk && hasEdgeReports ? sk.consistencyScore : null;
  const noProfile = "No Trader Skill profile has been computed yet.";
  const noDebriefs = "No post-trade debriefs yet.";
  const unmeasured: Record<string, string> = {};
  if (winRate == null) unmeasured["winRate"] = "No closed paper trades yet.";
  if (!sized) {
    const why = totalTrades ? "None of your closed trades could be sized in USD." : "No closed paper trades yet.";
    for (const k of ["netProfitLoss", "expectancy", "profitFactor", "maxDrawdown"]) unmeasured[k] = why;
  } else if (profitFactor == null) {
    unmeasured["profitFactor"] = profitFactorBasis === "NO_LOSING_TRADE"
      ? "No losing trade yet, so gross win ÷ gross loss is undefined."
      : "No winning or losing trade yet (every sized trade broke even).";
  }
  if (averageRr == null) unmeasured["averageRr"] = totalTrades ? "No closed trade has a stop distance to measure R from." : "No closed paper trades yet.";
  if (disciplineScoreAvg == null) unmeasured["disciplineScoreAvg"] = !sk ? noProfile : noDebriefs;
  if (executionScoreAvg == null) unmeasured["executionScoreAvg"] = !sk ? noProfile : noDebriefs;
  if (emotionalScoreAvg == null) unmeasured["emotionalScoreAvg"] = noDebriefs;
  if (consistencyScoreAvg == null) unmeasured["consistencyScoreAvg"] = !sk ? noProfile : "No edge reports yet.";

  return {
    totalTrades, netProfitLoss, winRate, averageRr, expectancy, profitFactor,
    maxDrawdown: mdd,
    disciplineScoreAvg, executionScoreAvg, emotionalScoreAvg, consistencyScoreAvg,
    strongestStrategy, weakestStrategy,
    strongestMarketCondition, weakestMarketCondition,
    // Not snapshot columns: what the highlights really are, and their basis.
    strongestSymbol, weakestSymbol, strongestEdgeSlice, weakestEdgeSlice,
    highlightBasis: HIGHLIGHT_BASIS,
    // Not snapshot columns: why each null figure was not measured, the
    // profit-factor basis, and when the Trader Skill profile was computed.
    unmeasured, profitFactorBasis,
    behaviorAsOf: sk?.updatedAt instanceof Date ? sk.updatedAt.toISOString() : (sk?.updatedAt ? String(sk.updatedAt) : null),
    // Not a snapshot column: what the money figures above cover.
    pnlCoverage: pnlCoverageOf(closed),
  };
}

/**
 * The analytics_snapshots columns of a computed snapshot. The extra fields
 * (coverage, highlight details, basis) are not columns and are not stored.
 * The columns are NOT NULL, so an unmeasured figure is stored as the column
 * default 0 (and a profit factor with no losing trade as the 999 marker) —
 * exactly what was stored before; only the live figures carry the null.
 */
export function toSnapshotRow(c: Awaited<ReturnType<typeof computeSnapshot>>) {
  return {
    totalTrades: c.totalTrades, netProfitLoss: c.netProfitLoss ?? 0, winRate: c.winRate ?? 0,
    averageRr: c.averageRr ?? 0, expectancy: c.expectancy ?? 0,
    profitFactor: c.profitFactor ?? (c.profitFactorBasis === "NO_LOSING_TRADE" ? 999 : 0),
    maxDrawdown: c.maxDrawdown ?? 0,
    disciplineScoreAvg: c.disciplineScoreAvg ?? 0, executionScoreAvg: c.executionScoreAvg ?? 0,
    emotionalScoreAvg: c.emotionalScoreAvg ?? 0, consistencyScoreAvg: c.consistencyScoreAvg ?? 0,
    strongestStrategy: c.strongestStrategy, weakestStrategy: c.weakestStrategy,
    strongestMarketCondition: c.strongestMarketCondition, weakestMarketCondition: c.weakestMarketCondition,
  };
}

export const HIGHLIGHT_BASIS = {
  symbols: "Best and worst symbol by the net P&L of their closed paper trades sized in USD. The best must be net profitable and the worst net losing.",
  edgeSlices: "From Edge Discovery's current reports, ranked by edge status and then by the report's confidence score — not by your results in a market condition. A slice with too little data is not ranked.",
};

const EDGE_STATUS_WORDS: Record<string, string> = {
  STRONG_EDGE: "strong edge", DEVELOPING_EDGE: "developing edge",
  WEAK_EDGE: "weak edge", NO_EDGE: "no edge", INSUFFICIENT_DATA: "not enough data",
};
type EdgeSliceRow = Awaited<ReturnType<typeof loadLatestSlices>>[number];
/** "symbol=EURUSD" → "EURUSD (by symbol)", with the board's status and confidence. */
function describeEdgeSlice(e: EdgeSliceRow) {
  const sep = e.edgeName.indexOf("=");
  const label = sep >= 0 ? `${e.edgeName.slice(sep + 1)} (by ${e.edgeName.slice(0, sep)})` : e.edgeName;
  const at = e.createdAt instanceof Date ? e.createdAt.toISOString() : (e.createdAt ? String(e.createdAt) : null);
  return {
    edgeName: e.edgeName, label, status: e.status,
    statusWords: EDGE_STATUS_WORDS[e.status] ?? e.status,
    confidenceScore: Math.round(e.confidenceScore), sampleSize: e.sampleSize, reportedAt: at,
  };
}

// ── POST /analytics/snapshot — generate ─────────────────────────────────────
router.post("/analytics/snapshot", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const figures = await computeSnapshot(userId);
    const computed = toSnapshotRow(figures);
    const { pnlCoverage } = figures;
    const ins = await db.insert(analyticsSnapshotsTable).values({ ...computed, userId }).returning();
    await vaultAnalytics("ANALYTICS_SNAPSHOT_GENERATED",
      { snapshotId: ins[0]!.id, totalTrades: computed.totalTrades });
    ok(res, { snapshot: ins[0], pnlCoverage });
  } catch (err) {
    res.req.log?.error?.({ err: String(err) }, "POST /analytics/snapshot failed");
    fail(res, 500, "Failed to generate analytics snapshot");
  }
});

// ── GET /analytics/snapshot — latest ────────────────────────────────────────
// `snapshot` is the last SAVED snapshot (Recompute, or the auto-debrief after a
// close); a trade closed without a debrief is not in it, and its createdAt is
// when it was computed. `current` is the same figures computed now from every
// paper order, stamped with `asOf`, so the page's tiles agree with the tables
// below them (which are always computed live). `current` is null, with
// `currentError`, when that computation failed — never a stand-in of zeros.
router.get("/analytics/snapshot", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const row = (await db.select().from(analyticsSnapshotsTable)
      .where(eq(analyticsSnapshotsTable.userId, userId))
      .orderBy(desc(analyticsSnapshotsTable.createdAt)).limit(1))[0] ?? null;
    let current: (Awaited<ReturnType<typeof computeSnapshot>> & { asOf: string }) | null = null;
    let currentError: string | null = null;
    try {
      current = { ...(await computeSnapshot(userId)), asOf: new Date().toISOString() };
    } catch (err) {
      req.log?.error?.({ err: String(err) }, "GET /analytics/snapshot: live figures failed");
      currentError = "The figures could not be computed from your paper orders just now.";
    }
    ok(res, { snapshot: row, current, currentError });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /analytics/snapshot failed");
    fail(res, 500, "Failed to load snapshot");
  }
});

// ── GET /analytics/heatmaps?type= ───────────────────────────────────────────
router.get("/analytics/heatmaps", requireUser, async (req, res): Promise<void> => {
  try {
    const type = typeof req.query["type"] === "string" ? req.query["type"] : null;
    const heatmaps = await buildAllHeatmaps(req.authUser!.id);
    if (type) ok(res, { heatmap: heatmaps.find((h) => h.heatmapType === type) ?? null });
    else      ok(res, { heatmaps });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /analytics/heatmaps failed");
    fail(res, 500, "Failed to build heatmaps");
  }
});

async function buildAllHeatmaps(userId: number): Promise<Array<{ heatmapType: string; dataset: unknown }>> {
  const [orders, debriefs] = await Promise.all([
    loadPaperOrders(userId),
    db.select().from(postTradeDebriefsTable).where(eq(postTradeDebriefsTable.userId, userId))
      .orderBy(desc(postTradeDebriefsTable.id)).limit(500),
  ]);
  const closed = orders.filter((o) => isClosed(o));

  // Every bucket counts all closed trades and wins by price move; `pnl` sums
  // only the trades that could be sized, and `sizedTrades` says how many.
  type Bucket = { trades: number; pnl: number; wins: number; sizedTrades: number };
  const bucket = (): Bucket => ({ trades: 0, pnl: 0, wins: 0, sizedTrades: 0 });
  const add = (b: Bucket, o: typeof closed[number]) => {
    const p = pnlOf(o);
    b.trades++; b.wins += outcomeSign(o) > 0 ? 1 : 0;
    if (p != null) { b.pnl += p; b.sizedTrades++; }
  };

  // SESSION_PNL: bucket P&L by ASIA/LONDON/NEWYORK.
  const sess: Record<string, Bucket> = { ASIA: bucket(), LONDON: bucket(), NEWYORK: bucket() };
  for (const o of closed) add(sess[sessionOf(o.openedAt)]!, o);

  // DAY_OF_WEEK: 0..6
  const dow = Array.from({ length: 7 }, bucket);
  for (const o of closed) add(dow[o.openedAt.getUTCDay()]!, o);

  // ENTRY_TIMING: bucket by hour 0..23
  const hours = Array.from({ length: 24 }, bucket);
  for (const o of closed) add(hours[o.openedAt.getUTCHours()]!, o);

  // EMOTIONAL: count by emotion-after
  const emo: Record<string, number> = {};
  for (const d of debriefs) {
    const k = d.traderEmotionAfter ?? "UNREPORTED";
    emo[k] = (emo[k] ?? 0) + 1;
  }

  return [
    { heatmapType: "SESSION_PNL",     dataset: sess },
    { heatmapType: "DAY_OF_WEEK",     dataset: dow },
    { heatmapType: "ENTRY_TIMING",    dataset: hours },
    { heatmapType: "EMOTIONAL",       dataset: emo },
  ];
}

// ── GET /analytics/strategy ─────────────────────────────────────────────────
router.get("/analytics/strategy", requireUser, async (req, res): Promise<void> => {
  try {
  const orders = await loadPaperOrders(req.authUser!.id);
  const closed = orders.filter((o) => isClosed(o));
  const groups = new Map<string, { trades: number; wins: number; pnl: number; sized: number; rrSum: number; rrN: number }>();
  for (const o of closed) {
    const k = o.symbol;
    const cur = groups.get(k) ?? { trades: 0, wins: 0, pnl: 0, sized: 0, rrSum: 0, rrN: 0 };
    const p = pnlOf(o);
    cur.trades++; cur.wins += outcomeSign(o) > 0 ? 1 : 0;
    if (p != null) { cur.pnl += p; cur.sized++; }
    const risk = Math.abs(o.entryPrice - o.stopLoss);
    if (risk > 0 && o.exitPrice != null) {
      const dir = o.direction === "BUY" ? 1 : -1;
      cur.rrSum += ((o.exitPrice - o.entryPrice) * dir) / risk;
      cur.rrN++;
    }
    groups.set(k, cur);
  }
  // A symbol whose trades could not be sized has no P&L to show: it is
  // listed in pnlCoverage.unsizedSymbols instead of a $0.00 row.
  const rows = [...groups.entries()].filter(([, g]) => g.sized > 0).map(([symbol, g]) => ({
    symbol, trades: g.trades, winRate: g.trades ? g.wins / g.trades : 0,
    totalPnl: g.pnl, expectancy: g.pnl / g.sized, sizedTrades: g.sized,
    averageRr: g.rrN ? g.rrSum / g.rrN : 0,
  })).sort((a, b) => b.totalPnl - a.totalPnl);
  ok(res, { strategies: rows, pnlCoverage: pnlCoverageOf(closed) });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /analytics/strategy failed");
    fail(res, 500, "Failed to load strategy analytics");
  }
});

// ── GET /analytics/session ──────────────────────────────────────────────────
router.get("/analytics/session", requireUser, async (req, res): Promise<void> => {
  try {
    const all = await buildAllHeatmaps(req.authUser!.id);
    ok(res, { session: all.find((h) => h.heatmapType === "SESSION_PNL")?.dataset ?? {}, sessionBasis: SESSION_BASIS });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /analytics/session failed");
    fail(res, 500, "Failed to load session analytics");
  }
});

// ── GET /analytics/emotional ────────────────────────────────────────────────
router.get("/analytics/emotional", requireUser, async (req, res): Promise<void> => {
  try {
    const debriefs = await db.select().from(postTradeDebriefsTable)
      .where(eq(postTradeDebriefsTable.userId, req.authUser!.id))
      .orderBy(desc(postTradeDebriefsTable.id)).limit(200);
    const trend = debriefs.slice().reverse().map((d, idx) => ({
      idx, emotion: d.traderEmotionAfter ?? "UNREPORTED",
      isCalm: d.traderEmotionAfter === "CALM" ? 1 : 0,
      followedPlan: d.followedPlan,
    }));
    ok(res, { trend, totalDebriefs: debriefs.length });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /analytics/emotional failed");
    fail(res, 500, "Failed to load emotional analytics");
  }
});

// ── GET /analytics/drawdown ─────────────────────────────────────────────────
router.get("/analytics/drawdown", requireUser, async (req, res): Promise<void> => {
  try {
    const orders = await loadPaperOrders(req.authUser!.id);
    const closed = orders.filter((o) => isClosed(o));
    let peak = 0, cum = 0;
    // The curve steps only on trades whose P&L could be sized.
    const curve = closed.flatMap((o) => {
      const p = pnlOf(o);
      if (p == null) return [];
      cum += p;
      if (cum > peak) peak = cum;
      return [{ tradeId: o.id, openedAt: o.openedAt, equity: cum, peak, drawdown: peak - cum }];
    });
    const maxDd = curve.reduce((m, p) => Math.max(m, p.drawdown), 0);
    ok(res, { equityCurve: curve, maxDrawdown: maxDd, pnlCoverage: pnlCoverageOf(closed) });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /analytics/drawdown failed");
    fail(res, 500, "Failed to load drawdown");
  }
});

// ── Heatmap snapshot persistence (called on first GET if none today) ────────
router.post("/analytics/heatmaps", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const built = await buildAllHeatmaps(userId);
    const inserted: typeof analyticsHeatmapsTable.$inferSelect[] = [];
    for (const h of built) {
      const r = await db.insert(analyticsHeatmapsTable).values({
        userId,
        heatmapType: h.heatmapType, dataset: h.dataset as object,
      }).returning();
      inserted.push(r[0]!);
    }
    await vaultAnalytics("ANALYTICS_HEATMAPS_GENERATED", { count: inserted.length });
    ok(res, { heatmaps: inserted });
  } catch (err) {
    res.req.log?.error?.({ err: String(err) }, "POST /analytics/heatmaps failed");
    fail(res, 500, "Failed to generate heatmaps");
  }
});

// (avoid unused-import warnings) — these tables are referenced by snapshot/heatmap composers above.
void [tradeJournalEntriesTable, weeklyPerformanceReviewsTable];

export default router;
