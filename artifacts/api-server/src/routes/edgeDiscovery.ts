// (W) Build W — AI Edge Discovery Engine routes.
//
// ISOLATION: reads trade_journal + paper_orders + post_trade_debriefs.
// Never references live trades / mt5_* / safetyCore / canPlaceTrades / risk
// mutation surfaces. Reports are advisory historical analytics, not signals.

import { Router } from "express";
import {
  db, edgeDiscoveryReportsTable, edgeWarningsTable,
  tradeJournalTable, paperOrdersTable, postTradeDebriefsTable,
  vaultEventsTable,
} from "@workspace/db";
import { and, desc, eq, not, like, or, isNull } from "drizzle-orm";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import { TESTER_SEED_STRATEGY_PREFIX } from "../lib/testerData/tags.js";

const router = Router();

/** Authenticated caller id — `requireUser` gates every /edge/* route. */
function uid(req: import("express").Request): number {
  return req.authUser!.id;
}
const EDGE_DISCLAIMER =
  "Edge reports are historical probability summaries. Past performance is NOT predictive — no setup is a proven strategy or a guarantee of future profit. Always weigh sample size and confidence.";

function ok(res: import("express").Response, body: Record<string, unknown>) {
  return res.json({ ...body, system: "edge", disclaimer: EDGE_DISCLAIMER });
}
function fail(res: import("express").Response, status: number, error: string, extra?: Record<string, unknown>) {
  return res.status(status).json({ error, ...(extra ?? {}), system: "edge", disclaimer: EDGE_DISCLAIMER });
}
async function vaultEdge(kind: string, severity: "INFO"|"WARN", payload: Record<string, unknown>) {
  await db.insert(vaultEventsTable).values({
    kind, severity, source: "SYSTEM", truthDomain: "BEHAVIOR",
    summary: kind, payload: { ...payload, edge: true },
    reasons: [], blockers: [], generatedAtIso: new Date().toISOString(),
  }).catch(() => { /* non-fatal */ });
}

// ── Status thresholds (intentionally conservative) ─────────────────────────
// Per spec: STRONG_EDGE only with adequate sample, INSUFFICIENT_DATA when low,
// negative expectancy → WEAK or NO edge.
const MIN_SAMPLE_FOR_LABEL    = 10;   // below this → INSUFFICIENT_DATA always
const MIN_SAMPLE_FOR_STRONG   = 30;
const STRONG_PF               = 1.6;
const DEVELOPING_PF           = 1.2;

const GroupBy = z.enum(["symbol","strategy","emotion","direction"]);
const GenerateBody = z.object({
  groupBy: GroupBy.default("symbol"),
  symbol: z.string().optional(),         // optional pre-filter
  strategy: z.string().optional(),
});

interface TradeLike {
  id: number; symbol: string; strategy: string | null;
  direction: string | null; emotion: string | null;
  pnl: number; entryPrice?: number | null; exitPrice?: number | null;
  stopLoss?: number | null; takeProfit?: number | null;
  source: "JOURNAL" | "PAPER";
}

// Aggregator stats per bucket
interface Bucket {
  trades: TradeLike[];
  wins: number; losses: number;
  grossWin: number; grossLoss: number;
  rrSum: number; rrCount: number;
}
const newBucket = (): Bucket => ({ trades: [], wins: 0, losses: 0, grossWin: 0, grossLoss: 0, rrSum: 0, rrCount: 0 });

function classify(pnl: number): "WIN"|"LOSS"|"BE" {
  if (pnl > 0.0001) return "WIN";
  if (pnl < -0.0001) return "LOSS";
  return "BE";
}
function bucketKey(t: TradeLike, by: z.infer<typeof GroupBy>): string {
  switch (by) {
    case "symbol":    return t.symbol || "UNKNOWN";
    case "strategy":  return t.strategy || "UNKNOWN";
    case "emotion":   return t.emotion || "UNTAGGED";
    case "direction": return t.direction || "UNKNOWN";
  }
}

function computeStats(b: Bucket): {
  sampleSize: number; winRate: number; averageRr: number;
  expectancy: number; profitFactor: number;
} {
  const sample = b.wins + b.losses;       // ignore breakevens for win-rate base
  if (sample === 0) return { sampleSize: 0, winRate: 0, averageRr: 0, expectancy: 0, profitFactor: 0 };
  const winRate = b.wins / sample;
  const avgWin  = b.wins   ? b.grossWin / b.wins   : 0;
  const avgLoss = b.losses ? b.grossLoss / b.losses : 0;
  const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);
  const profitFactor = b.grossLoss > 0 ? b.grossWin / b.grossLoss
                     : b.grossWin > 0  ? 999 : 0;
  const averageRr = b.rrCount ? b.rrSum / b.rrCount : 0;
  return { sampleSize: sample, winRate, averageRr, expectancy, profitFactor };
}

function classifyStatus(s: ReturnType<typeof computeStats>):
  "STRONG_EDGE"|"DEVELOPING_EDGE"|"WEAK_EDGE"|"NO_EDGE"|"INSUFFICIENT_DATA" {
  if (s.sampleSize < MIN_SAMPLE_FOR_LABEL) return "INSUFFICIENT_DATA";
  if (s.expectancy < 0)  return s.expectancy < -0.5 * Math.max(1, Math.abs(s.expectancy)) ? "NO_EDGE" : "WEAK_EDGE";
  if (s.expectancy === 0) return "WEAK_EDGE";
  if (s.sampleSize >= MIN_SAMPLE_FOR_STRONG && s.profitFactor >= STRONG_PF) return "STRONG_EDGE";
  if (s.profitFactor >= DEVELOPING_PF) return "DEVELOPING_EDGE";
  return "WEAK_EDGE";
}

function confidence(s: ReturnType<typeof computeStats>, status: string): number {
  if (status === "INSUFFICIENT_DATA") return Math.min(40, s.sampleSize * 3);
  // Logistic-ish growth on sample size, modulated by profit factor proximity.
  const sampleFactor = Math.min(1, s.sampleSize / 100);          // 0..1
  const pfFactor     = Math.min(1, Math.max(0, (s.profitFactor - 1) / 1.5));
  return Math.round(30 + sampleFactor * 50 + pfFactor * 20);
}

interface Warning { warningType: string; message: string; severity: "INFO"|"WARN"|"DANGER" }
function warnings(b: Bucket, s: ReturnType<typeof computeStats>): Warning[] {
  const w: Warning[] = [];
  if (s.sampleSize < MIN_SAMPLE_FOR_LABEL && s.sampleSize > 0)
    w.push({ warningType: "LOW_SAMPLE", severity: "WARN",
      message: `Sample size ${s.sampleSize} is below the threshold (${MIN_SAMPLE_FOR_LABEL}) — treat all numbers as preliminary.` });
  if (s.winRate >= 0.7 && s.averageRr > 0 && s.averageRr < 0.8)
    w.push({ warningType: "HIGH_WR_LOW_RR", severity: "WARN",
      message: `High win rate (${(s.winRate*100).toFixed(0)}%) but R:R is low (${s.averageRr.toFixed(2)}) — one bad streak can erase the edge.` });
  // Lucky-trade dependency: single largest win contributes >50% of gross win.
  if (b.trades.length >= 5) {
    const wins = b.trades.filter((t) => t.pnl > 0).map((t) => t.pnl).sort((a,b)=>b-a);
    if (wins.length > 0) {
      const top = wins[0]!;
      const gross = wins.reduce((a,c)=>a+c,0);
      if (gross > 0 && top / gross >= 0.5)
        w.push({ warningType: "LUCKY_TRADE_DEPENDENCY", severity: "DANGER",
          message: `One trade contributes ${((top/gross)*100).toFixed(0)}% of gross profit — the edge may not be real.` });
    }
  }
  if (s.profitFactor > 0 && s.profitFactor < 1)
    w.push({ warningType: "NEGATIVE_PF", severity: "DANGER",
      message: `Profit factor ${s.profitFactor.toFixed(2)} is below 1.00 — losses outweigh wins on this slice.` });
  if (s.sampleSize >= MIN_SAMPLE_FOR_LABEL && s.sampleSize < MIN_SAMPLE_FOR_STRONG && s.profitFactor >= STRONG_PF)
    w.push({ warningType: "PROMISING_BUT_THIN", severity: "INFO",
      message: `Profit factor looks strong but sample size (${s.sampleSize}) is too small for STRONG_EDGE.` });
  return w;
}

function summarize(name: string, status: string, s: ReturnType<typeof computeStats>): string {
  const lines: string[] = [];
  if (status === "INSUFFICIENT_DATA") {
    lines.push(`${name}: not enough data yet (${s.sampleSize} trade(s)). Keep paper trading and journaling — confidence grows with sample size, not certainty.`);
  } else if (status === "NO_EDGE" || status === "WEAK_EDGE") {
    lines.push(`${name}: ${status === "NO_EDGE" ? "no measurable" : "a weak"} edge in your data (PF ${s.profitFactor.toFixed(2)}, expectancy ${s.expectancy.toFixed(2)}). Consider a paper-only reset for this slice.`);
  } else if (status === "DEVELOPING_EDGE") {
    lines.push(`${name}: developing edge (PF ${s.profitFactor.toFixed(2)}, ${s.sampleSize} trades). Promising — keep the conditions consistent and re-evaluate in 20 more trades.`);
  } else {
    lines.push(`${name}: a measurable historical edge (PF ${s.profitFactor.toFixed(2)}, win rate ${(s.winRate*100).toFixed(0)}%, ${s.sampleSize} trades). Past results do not guarantee future results.`);
  }
  return lines.join(" ");
}

// ── Source loader (READ-ONLY) ──────────────────────────────────────────────
// ISOLATION + PROVENANCE: the page says these edges come from "your own data",
// so this loader reads ONLY rows owned by `userId`, and excludes the tester
// demo-seed journal rows (fabricated P&L) that the diagnostics seeder writes.
async function loadTrades(userId: number): Promise<TradeLike[]> {
  const notSeeded = or(
    isNull(tradeJournalTable.strategy),
    not(like(tradeJournalTable.strategy, `${TESTER_SEED_STRATEGY_PREFIX}%`)),
  );
  const [journals, papers, debriefs] = await Promise.all([
    db.select().from(tradeJournalTable)
      .where(and(eq(tradeJournalTable.userId, userId), notSeeded)).limit(2000),
    db.select().from(paperOrdersTable)
      .where(eq(paperOrdersTable.userId, userId)).limit(2000),
    db.select().from(postTradeDebriefsTable)
      .where(eq(postTradeDebriefsTable.userId, userId)).limit(2000),
  ]);
  // Map debriefs by trade id for emotion lookup on paper orders.
  const debriefByTrade = new Map<number, { emotion: string | null }>();
  for (const d of debriefs) debriefByTrade.set(d.tradeId, { emotion: d.traderEmotionAfter });

  const out: TradeLike[] = [];
  for (const j of journals) {
    out.push({
      id: j.id, symbol: j.symbol, strategy: j.strategy ?? null,
      direction: j.direction ?? null, emotion: j.emotionTag ?? null,
      pnl: j.pnl ?? 0, source: "JOURNAL",
    });
  }
  for (const p of papers) {
    if (p.status === "OPEN") continue;       // only closed trades count
    out.push({
      id: p.id, symbol: p.symbol, strategy: null,
      direction: p.direction, emotion: debriefByTrade.get(p.id)?.emotion ?? null,
      pnl: p.profitLoss, entryPrice: p.entryPrice, exitPrice: p.exitPrice,
      stopLoss: p.stopLoss, takeProfit: p.takeProfit, source: "PAPER",
    });
  }
  return out;
}

// ── POST /edge/reports — generate ──────────────────────────────────────────
router.post("/edge/reports", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = uid(req);
    const b = GenerateBody.parse(req.body ?? {});
    const all = await loadTrades(userId);
    const filtered = all.filter((t) =>
      (!b.symbol   || t.symbol   === b.symbol) &&
      (!b.strategy || t.strategy === b.strategy));

    // Group
    const groups = new Map<string, Bucket>();
    for (const t of filtered) {
      const k = bucketKey(t, b.groupBy);
      const g = groups.get(k) ?? newBucket();
      g.trades.push(t);
      const c = classify(t.pnl);
      if (c === "WIN")  { g.wins++;   g.grossWin  += t.pnl; }
      if (c === "LOSS") { g.losses++; g.grossLoss += -t.pnl; }
      // R:R only computable for paper trades with stops
      if (t.source === "PAPER" && t.stopLoss != null && t.takeProfit != null && t.entryPrice != null) {
        const risk = Math.abs(t.entryPrice - t.stopLoss);
        const rew  = Math.abs(t.takeProfit - t.entryPrice);
        if (risk > 0) { g.rrSum += rew / risk; g.rrCount += 1; }
      }
      groups.set(k, g);
    }

    // Behavior overlays from debriefs (averages over the union of trade ids in
    // the buckets that came from PAPER trades; we approximate by all debriefs).
    const debriefs = await db.select().from(postTradeDebriefsTable)
      .where(eq(postTradeDebriefsTable.userId, userId)).limit(2000);
    const followed = debriefs.filter((d) => d.followedPlan === 1).length;
    const calmish  = debriefs.filter((d) => ["CALM","RELIEVED","NEUTRAL"].includes(d.traderEmotionAfter ?? "")).length;
    const disciplineAvg = debriefs.length ? Math.round((followed / debriefs.length) * 100) : 0;
    const emotionalAvg  = debriefs.length ? Math.round((calmish  / debriefs.length) * 100) : 0;
    const executionAvg  = Math.round((disciplineAvg + emotionalAvg) / 2);

    // Build reports, persist, and persist per-report warnings.
    const created: typeof edgeDiscoveryReportsTable.$inferSelect[] = [];
    for (const [name, bucket] of groups) {
      const stats  = computeStats(bucket);
      if (stats.sampleSize === 0) continue;
      const status = classifyStatus(stats);
      const conf   = confidence(stats, status);
      const summary = summarize(name, status, stats);
      const ins = await db.insert(edgeDiscoveryReportsTable).values({
        userId,
        edgeName:  `${b.groupBy}=${name}`,
        symbol:    b.groupBy === "symbol"   ? name : (b.symbol ?? null),
        sessionName: null,
        marketCondition: null,
        timeframe: null,
        sampleSize: stats.sampleSize,
        winRate: stats.winRate, averageRr: stats.averageRr,
        expectancy: stats.expectancy, profitFactor: stats.profitFactor,
        disciplineScoreAvg: disciplineAvg, executionScoreAvg: executionAvg,
        emotionalScoreAvg: emotionalAvg,
        confidenceScore: conf, status, aiSummary: summary,
      }).returning();
      const rep = ins[0]!;
      created.push(rep);
      const ws = warnings(bucket, stats);
      for (const w of ws) {
        await db.insert(edgeWarningsTable).values({
          userId,
          edgeReportId: rep.id, warningType: w.warningType,
          message: w.message, severity: w.severity,
        });
      }
      await vaultEdge(`EDGE_REPORT_${status}`, status === "STRONG_EDGE" ? "INFO" : "WARN",
        { reportId: rep.id, name: rep.edgeName, sampleSize: stats.sampleSize,
          profitFactor: stats.profitFactor, expectancy: stats.expectancy });
    }

    ok(res, { reports: created, generated: created.length, groupBy: b.groupBy });
  } catch (err) {
    if (err instanceof z.ZodError) { fail(res, 400, "Invalid", { issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /edge/reports failed");
    fail(res, 500, "Failed to generate edge reports");
  }
});

// ── GET /edge/reports ──────────────────────────────────────────────────────
router.get("/edge/reports", requireUser, async (req, res): Promise<void> => {
  const raw = Number(req.query["limit"]);
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(raw, 200)) : 100;
  const rows = await db.select().from(edgeDiscoveryReportsTable)
    .where(eq(edgeDiscoveryReportsTable.userId, uid(req)))
    .orderBy(desc(edgeDiscoveryReportsTable.createdAt)).limit(limit);
  ok(res, { reports: rows });
});

// ── GET /edge/reports/:id ──────────────────────────────────────────────────
router.get("/edge/reports/:id", requireUser, async (req, res): Promise<void> => {
  const userId = uid(req);
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) { fail(res, 400, "Invalid id"); return; }
  // A report belonging to another user is indistinguishable from one that
  // does not exist — 404, never a peek at a stranger's edge.
  const r = (await db.select().from(edgeDiscoveryReportsTable)
    .where(and(
      eq(edgeDiscoveryReportsTable.id, id),
      eq(edgeDiscoveryReportsTable.userId, userId),
    )).limit(1))[0];
  if (!r) { fail(res, 404, "Not found"); return; }
  const ws = await db.select().from(edgeWarningsTable)
    .where(and(
      eq(edgeWarningsTable.edgeReportId, id),
      eq(edgeWarningsTable.userId, userId),
    ));
  ok(res, { report: r, warnings: ws });
});

// ── GET /edge/strongest ────────────────────────────────────────────────────
router.get("/edge/strongest", requireUser, async (req, res): Promise<void> => {
  const rows = await db.select().from(edgeDiscoveryReportsTable)
    .where(eq(edgeDiscoveryReportsTable.userId, uid(req)))
    .orderBy(desc(edgeDiscoveryReportsTable.confidenceScore)).limit(50);
  const strong = rows
    .filter((r) => r.status === "STRONG_EDGE" || r.status === "DEVELOPING_EDGE")
    .slice(0, 10);
  ok(res, { reports: strong });
});

// ── GET /edge/weakest ──────────────────────────────────────────────────────
router.get("/edge/weakest", requireUser, async (req, res): Promise<void> => {
  const rows = await db.select().from(edgeDiscoveryReportsTable)
    .where(eq(edgeDiscoveryReportsTable.userId, uid(req)))
    .orderBy(edgeDiscoveryReportsTable.expectancy).limit(50);
  const weak = rows
    .filter((r) => r.status === "WEAK_EDGE" || r.status === "NO_EDGE")
    .slice(0, 10);
  ok(res, { reports: weak });
});

// ── GET /edge/warnings ─────────────────────────────────────────────────────
router.get("/edge/warnings", requireUser, async (req, res): Promise<void> => {
  const userId = uid(req);
  const reportId = Number(req.query["reportId"]);
  if (Number.isFinite(reportId)) {
    const rows = await db.select().from(edgeWarningsTable)
      .where(and(
        eq(edgeWarningsTable.edgeReportId, reportId),
        eq(edgeWarningsTable.userId, userId),
      ));
    ok(res, { warnings: rows }); return;
  }
  const rows = await db.select().from(edgeWarningsTable)
    .where(eq(edgeWarningsTable.userId, userId))
    .orderBy(desc(edgeWarningsTable.createdAt)).limit(100);
  ok(res, { warnings: rows });
});

export default router;
