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
  edgeDiscoveryReportsTable, vaultEventsTable,
} from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { paperMoveSign, paperPnl } from "../lib/paperExecution/paperPnl.js";

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

// ── Compute snapshot from current data ──────────────────────────────────────
// EXPORTED so Build BB's auto-debrief service can recompute analytics
// in-process after a closed-trade event without an internal HTTP hop.
export async function computeSnapshot(userId: number) {
  const [orders, skill, debriefs, edges] = await Promise.all([
    // Chronological order — required for correct peak-to-trough drawdown math.
    db.select().from(paperOrdersTable).where(eq(paperOrdersTable.userId, userId))
      .orderBy(paperOrdersTable.openedAt).limit(1000),
    db.select().from(traderSkillProfilesTable).where(eq(traderSkillProfilesTable.userId, userId))
      .orderBy(desc(traderSkillProfilesTable.updatedAt)).limit(1),
    db.select().from(postTradeDebriefsTable).where(eq(postTradeDebriefsTable.userId, userId))
      .orderBy(desc(postTradeDebriefsTable.id)).limit(200),
    db.select().from(edgeDiscoveryReportsTable).where(eq(edgeDiscoveryReportsTable.userId, userId)).limit(200),
  ]);
  const closed = orders.filter((o) => isClosed(o));
  // Money figures use only trades whose P&L could be sized (see pnlOf).
  const pnls = closed.map((o) => pnlOf(o)).filter((p): p is number => p != null);
  const totalTrades = closed.length;
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossWin = wins.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));
  const netProfitLoss = pnls.reduce((s, p) => s + p, 0);
  // A win is a favourable price move, so unsized trades still count here.
  const winCount = closed.filter((o) => outcomeSign(o) > 0).length;
  const winRate = totalTrades ? winCount / totalTrades : 0;
  const expectancy = pnls.length ? netProfitLoss / pnls.length : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);
  // Average reward/risk per trade (R-multiple).
  const rrs = closed.map((o) => {
    const risk = Math.abs(o.entryPrice - o.stopLoss);
    if (risk <= 0 || o.exitPrice == null) return 0;
    const dir = o.direction === "BUY" ? 1 : -1;
    return ((o.exitPrice - o.entryPrice) * dir) / risk;
  }).filter((r) => Number.isFinite(r));
  const averageRr = rrs.length ? rrs.reduce((s, r) => s + r, 0) / rrs.length : 0;
  const mdd = maxDrawdown(pnls.map((p) => ({ pnl: p })));

  // Strongest/weakest strategy by edge confidence.
  const byStrategy = new Map<string, { wins: number; total: number; pnl: number }>();
  for (const o of closed) {
    const key = o.symbol;  // proxy for strategy when no strategy field on paper orders
    const p = pnlOf(o);
    if (p == null) continue; // ranked by P&L, so only sized trades rank
    const cur = byStrategy.get(key) ?? { wins: 0, total: 0, pnl: 0 };
    cur.wins += p > 0 ? 1 : 0; cur.total += 1; cur.pnl += p;
    byStrategy.set(key, cur);
  }
  const stratEntries = [...byStrategy.entries()];
  stratEntries.sort((a, b) => b[1].pnl - a[1].pnl);
  const strongestStrategy = stratEntries[0]?.[0] ?? null;
  const weakestStrategy   = stratEntries.at(-1)?.[0] ?? null;

  // Strongest/weakest market condition from edge reports.
  const sortedEdges = [...edges].sort((a, b) => b.confidenceScore - a.confidenceScore);
  const strongestMarketCondition = sortedEdges[0]?.marketCondition ?? sortedEdges[0]?.edgeName ?? null;
  const weakestMarketCondition   = sortedEdges.at(-1)?.marketCondition ?? sortedEdges.at(-1)?.edgeName ?? null;

  // Behavioral averages.
  const sk = skill[0] ?? null;
  const calmCount = debriefs.filter((d) => d.traderEmotionAfter === "CALM").length;
  const emotionalScoreAvg = debriefs.length ? (calmCount / debriefs.length) * 100 : 0;

  return {
    totalTrades, netProfitLoss, winRate, averageRr, expectancy, profitFactor,
    maxDrawdown: mdd,
    disciplineScoreAvg: sk?.disciplineScore ?? 0,
    executionScoreAvg:  sk?.executionScore  ?? 0,
    emotionalScoreAvg,
    consistencyScoreAvg:sk?.consistencyScore ?? 0,
    strongestStrategy, weakestStrategy,
    strongestMarketCondition, weakestMarketCondition,
    // Not a snapshot column: what the money figures above cover.
    pnlCoverage: pnlCoverageOf(closed),
  };
}

// ── POST /analytics/snapshot — generate ─────────────────────────────────────
router.post("/analytics/snapshot", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const { pnlCoverage, ...computed } = await computeSnapshot(userId);
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
router.get("/analytics/snapshot", requireUser, async (req, res): Promise<void> => {
  try {
    const row = (await db.select().from(analyticsSnapshotsTable)
      .where(eq(analyticsSnapshotsTable.userId, req.authUser!.id))
      .orderBy(desc(analyticsSnapshotsTable.createdAt)).limit(1))[0] ?? null;
    ok(res, { snapshot: row });
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
    db.select().from(paperOrdersTable).where(eq(paperOrdersTable.userId, userId))
      .orderBy(desc(paperOrdersTable.id)).limit(1000),
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
  const orders = await db.select().from(paperOrdersTable)
    .where(eq(paperOrdersTable.userId, req.authUser!.id)).limit(1000);
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
    const orders = await db.select().from(paperOrdersTable)
      .where(eq(paperOrdersTable.userId, req.authUser!.id))
      .orderBy(paperOrdersTable.openedAt).limit(1000);
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
