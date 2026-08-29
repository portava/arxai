// (Z) Build Z — Institutional Analytics & Command Center routes.
//
// ISOLATION: read-only across paper orders, debriefs, journal, skill, weekly
// reviews, edge reports. Writes only own 2 tables + vault audit. Never references
// trade execution / mt5_* / safetyCore / canPlaceTrades / risk mutation.
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

const router = Router();

/** Authenticated caller id — `requireUser` gates every route in this file. */
function uid(req: import("express").Request): number {
  return req.authUser!.id;
}
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
function pnlOf(o: typeof paperOrdersTable.$inferSelect): number {
  if (!isClosed(o) || o.exitPrice == null) return 0;
  const dir = o.direction === "BUY" ? 1 : -1;
  return (o.exitPrice - o.entryPrice) * dir * o.lotSize * 100; // synthetic $/lot
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
function sessionOf(d: Date): "ASIA"|"LONDON"|"NEWYORK" {
  const h = d.getUTCHours();
  if (h >= 0 && h < 7) return "ASIA";
  if (h >= 7 && h < 13) return "LONDON";
  return "NEWYORK";
}

// ── Compute snapshot from current data ──────────────────────────────────────
// EXPORTED so Build BB's auto-debrief service can recompute analytics
// in-process after a closed-trade event without an internal HTTP hop.
//
// ISOLATION: `userId` is REQUIRED. Every read below is scoped to that user —
// these numbers are presented to a trader as "your P&L / your win rate", so
// there is no honest meaning for an unscoped, instance-wide aggregate here.
export async function computeSnapshot(userId: number) {
  const [orders, skill, debriefs, edges] = await Promise.all([
    // Chronological order — required for correct peak-to-trough drawdown math.
    db.select().from(paperOrdersTable)
      .where(eq(paperOrdersTable.userId, userId))
      .orderBy(paperOrdersTable.openedAt).limit(1000),
    db.select().from(traderSkillProfilesTable)
      .where(eq(traderSkillProfilesTable.userId, userId))
      .orderBy(desc(traderSkillProfilesTable.updatedAt)).limit(1),
    db.select().from(postTradeDebriefsTable)
      .where(eq(postTradeDebriefsTable.userId, userId))
      .orderBy(desc(postTradeDebriefsTable.id)).limit(200),
    db.select().from(edgeDiscoveryReportsTable)
      .where(eq(edgeDiscoveryReportsTable.userId, userId)).limit(200),
  ]);
  const closed = orders.filter((o) => isClosed(o));
  const pnls = closed.map((o) => pnlOf(o));
  const totalTrades = closed.length;
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossWin = wins.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));
  const netProfitLoss = pnls.reduce((s, p) => s + p, 0);
  const winRate = totalTrades ? wins.length / totalTrades : 0;
  const expectancy = totalTrades ? netProfitLoss / totalTrades : 0;
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
    const cur = byStrategy.get(key) ?? { wins: 0, total: 0, pnl: 0 };
    const p = pnlOf(o);
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
  };
}

// ── POST /analytics/snapshot — generate ─────────────────────────────────────
router.post("/analytics/snapshot", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = uid(req);
    const computed = await computeSnapshot(userId);
    const ins = await db.insert(analyticsSnapshotsTable).values({ ...computed, userId }).returning();
    await vaultAnalytics("ANALYTICS_SNAPSHOT_GENERATED",
      { snapshotId: ins[0]!.id, totalTrades: computed.totalTrades, userId });
    ok(res, { snapshot: ins[0] });
  } catch (err) {
    res.req.log?.error?.({ err: String(err) }, "POST /analytics/snapshot failed");
    fail(res, 500, "Failed to generate analytics snapshot");
  }
});

// ── GET /analytics/snapshot — latest ────────────────────────────────────────
router.get("/analytics/snapshot", requireUser, async (req, res): Promise<void> => {
  try {
    const row = (await db.select().from(analyticsSnapshotsTable)
      .where(eq(analyticsSnapshotsTable.userId, uid(req)))
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
    const heatmaps = await buildAllHeatmaps(uid(req));
    if (type) ok(res, { heatmap: heatmaps.find((h) => h.heatmapType === type) ?? null });
    else      ok(res, { heatmaps });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /analytics/heatmaps failed");
    fail(res, 500, "Failed to build heatmaps");
  }
});

async function buildAllHeatmaps(userId: number): Promise<Array<{ heatmapType: string; dataset: unknown }>> {
  const [orders, debriefs] = await Promise.all([
    db.select().from(paperOrdersTable)
      .where(eq(paperOrdersTable.userId, userId))
      .orderBy(desc(paperOrdersTable.id)).limit(1000),
    db.select().from(postTradeDebriefsTable)
      .where(eq(postTradeDebriefsTable.userId, userId))
      .orderBy(desc(postTradeDebriefsTable.id)).limit(500),
  ]);
  const closed = orders.filter((o) => isClosed(o));

  // SESSION_PNL: bucket P&L by ASIA/LONDON/NEWYORK.
  const sess: Record<string, { trades: number; pnl: number; wins: number }> = {
    ASIA: { trades: 0, pnl: 0, wins: 0 },
    LONDON: { trades: 0, pnl: 0, wins: 0 },
    NEWYORK: { trades: 0, pnl: 0, wins: 0 },
  };
  for (const o of closed) {
    const s = sessionOf(o.openedAt);
    const p = pnlOf(o);
    sess[s]!.trades++; sess[s]!.pnl += p; sess[s]!.wins += p > 0 ? 1 : 0;
  }

  // DAY_OF_WEEK: 0..6
  const dow = Array.from({ length: 7 }, () => ({ trades: 0, pnl: 0, wins: 0 }));
  for (const o of closed) {
    const d = o.openedAt.getUTCDay();
    const p = pnlOf(o);
    dow[d]!.trades++; dow[d]!.pnl += p; dow[d]!.wins += p > 0 ? 1 : 0;
  }

  // ENTRY_TIMING: bucket by hour 0..23
  const hours = Array.from({ length: 24 }, () => ({ trades: 0, pnl: 0 }));
  for (const o of closed) {
    const h = o.openedAt.getUTCHours();
    hours[h]!.trades++; hours[h]!.pnl += pnlOf(o);
  }

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
    .where(eq(paperOrdersTable.userId, uid(req))).limit(1000);
  const closed = orders.filter((o) => isClosed(o));
  const groups = new Map<string, { trades: number; wins: number; pnl: number; rrSum: number; rrN: number }>();
  for (const o of closed) {
    const k = o.symbol;
    const cur = groups.get(k) ?? { trades: 0, wins: 0, pnl: 0, rrSum: 0, rrN: 0 };
    const p = pnlOf(o);
    cur.trades++; cur.pnl += p; cur.wins += p > 0 ? 1 : 0;
    const risk = Math.abs(o.entryPrice - o.stopLoss);
    if (risk > 0 && o.exitPrice != null) {
      const dir = o.direction === "BUY" ? 1 : -1;
      cur.rrSum += ((o.exitPrice - o.entryPrice) * dir) / risk;
      cur.rrN++;
    }
    groups.set(k, cur);
  }
  const rows = [...groups.entries()].map(([symbol, g]) => ({
    symbol, trades: g.trades, winRate: g.trades ? g.wins / g.trades : 0,
    totalPnl: g.pnl, expectancy: g.trades ? g.pnl / g.trades : 0,
    averageRr: g.rrN ? g.rrSum / g.rrN : 0,
  })).sort((a, b) => b.totalPnl - a.totalPnl);
  ok(res, { strategies: rows });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /analytics/strategy failed");
    fail(res, 500, "Failed to load strategy analytics");
  }
});

// ── GET /analytics/session ──────────────────────────────────────────────────
router.get("/analytics/session", requireUser, async (req, res): Promise<void> => {
  try {
    const all = await buildAllHeatmaps(uid(req));
    ok(res, { session: all.find((h) => h.heatmapType === "SESSION_PNL")?.dataset ?? {} });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /analytics/session failed");
    fail(res, 500, "Failed to load session analytics");
  }
});

// ── GET /analytics/emotional ────────────────────────────────────────────────
router.get("/analytics/emotional", requireUser, async (req, res): Promise<void> => {
  try {
    const debriefs = await db.select().from(postTradeDebriefsTable)
      .where(eq(postTradeDebriefsTable.userId, uid(req)))
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
      .where(eq(paperOrdersTable.userId, uid(req)))
      .orderBy(paperOrdersTable.openedAt).limit(1000);
    const closed = orders.filter((o) => isClosed(o));
    let peak = 0, cum = 0;
    const curve = closed.map((o) => {
      cum += pnlOf(o);
      if (cum > peak) peak = cum;
      return { tradeId: o.id, openedAt: o.openedAt, equity: cum, peak, drawdown: peak - cum };
    });
    const maxDd = curve.reduce((m, p) => Math.max(m, p.drawdown), 0);
    ok(res, { equityCurve: curve, maxDrawdown: maxDd });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /analytics/drawdown failed");
    fail(res, 500, "Failed to load drawdown");
  }
});

// ── Heatmap snapshot persistence (called on first GET if none today) ────────
router.post("/analytics/heatmaps", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = uid(req);
    const built = await buildAllHeatmaps(userId);
    const inserted: typeof analyticsHeatmapsTable.$inferSelect[] = [];
    for (const h of built) {
      const r = await db.insert(analyticsHeatmapsTable).values({
        userId, heatmapType: h.heatmapType, dataset: h.dataset as object,
      }).returning();
      inserted.push(r[0]!);
    }
    await vaultAnalytics("ANALYTICS_HEATMAPS_GENERATED", { count: inserted.length, userId });
    ok(res, { heatmaps: inserted });
  } catch (err) {
    res.req.log?.error?.({ err: String(err) }, "POST /analytics/heatmaps failed");
    fail(res, 500, "Failed to generate heatmaps");
  }
});

// (avoid unused-import warnings) — these tables are referenced by snapshot/heatmap composers above.
void [tradeJournalEntriesTable, weeklyPerformanceReviewsTable, eq];

export default router;
