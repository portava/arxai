// Phase Playbook — spec-mandated contract endpoints for Strategy Playbook &
// Setup Quality Engine. Thin transport over existing services:
//   - /api/setups/score             → playbookEngine.evaluatePreTradeCheck
//   - /api/setups/performance       → reportBuilder.buildPlaybookPerformance
//   - /api/trades/:id/setup-tag     → patch tradeJournalEntriesTable
//   - /api/coach/strategy-insights  → derived from buildPlaybookPerformance
//   - /api/coach/build-playbook     → playbookEngine.generatePlaybookFromHistory
//
// Read-only against safety surfaces. No broker execution. Per-user-scoped.

import { Router } from "express";
import { z } from "zod/v4";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  userPlaybooksTable, playbookRulesV2Table, preTradeChecksTable,
  tradeJournalEntriesTable, paperTradesTable,
} from "@workspace/db";
import type { PaperTrade } from "@workspace/db";
import { requireUser } from "../lib/auth/middleware.js";
import { evaluatePreTradeCheck, generatePlaybookFromHistory } from "../lib/playbookEngine.js";

const router: Router = Router();

function labelFromScore(score: number): string {
  if (score >= 90) return "A+";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "low";
  return "avoid";
}

// ── POST /api/setups/score ────────────────────────────────────────────────
// Scores ONE candidate trade for the signed-in user against either a chosen
// playbook (playbookId) or their first active playbook. Returns
// {decision, score, label, matchedPlaybook, ruleResults}. Returns
// dataAvailable:false when the user has no active playbook.
const ScoreBody = z.object({
  symbol: z.string().min(1).max(32),
  side: z.string().optional().nullable(),
  playbookId: z.number().int().positive().optional().nullable(),
  stopLoss: z.number().finite().nullable().optional(),
  takeProfit: z.number().finite().nullable().optional(),
  entryPrice: z.number().finite().nullable().optional(),
  lotSize: z.number().finite().nullable().optional(),
  riskPercent: z.number().finite().nullable().optional(),
  rewardRiskRatio: z.number().finite().nullable().optional(),
  reasonForEntry: z.string().max(2000).nullable().optional(),
});
router.post("/setups/score", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const b = ScoreBody.parse(req.body ?? {});
    let pb;
    if (b.playbookId != null) {
      const [row] = await db.select().from(userPlaybooksTable)
        .where(and(eq(userPlaybooksTable.userId, userId), eq(userPlaybooksTable.id, b.playbookId)))
        .limit(1);
      pb = row;
    } else {
      const [row] = await db.select().from(userPlaybooksTable)
        .where(and(eq(userPlaybooksTable.userId, userId), eq(userPlaybooksTable.status, "active")))
        .orderBy(desc(userPlaybooksTable.updatedAt)).limit(1);
      pb = row;
    }
    if (!pb) {
      res.json({
        ok: true, dataAvailable: false,
        reason: "no_active_playbook",
        message: "You have no active playbook. Create one on the Playbook page before scoring setups.",
        safetyMode: "paper_only", educationalOnly: true,
      });
      return;
    }
    const rules = await db.select().from(playbookRulesV2Table)
      .where(and(eq(playbookRulesV2Table.userId, userId), eq(playbookRulesV2Table.playbookId, pb.id)));
    const result = evaluatePreTradeCheck(pb, rules, {
      symbol: b.symbol, side: b.side ?? null,
      stopLoss: b.stopLoss ?? null, takeProfit: b.takeProfit ?? null,
      entryPrice: b.entryPrice ?? null, lotSize: b.lotSize ?? null,
      riskAmount: null, riskPercent: b.riskPercent ?? null,
      rewardRiskRatio: b.rewardRiskRatio ?? null, reasonForEntry: b.reasonForEntry ?? null,
    });
    res.json({
      ok: true, dataAvailable: true,
      matchedPlaybook: { id: pb.id, title: pb.title, strategyType: pb.strategyType },
      decision: result.decision, score: result.score, label: labelFromScore(result.score),
      passedRequiredCount: result.passedRequiredCount,
      failedRequiredCount: result.failedRequiredCount,
      ruleResults: result.checklistResult,
      improvementNote: result.improvementNote,
      safetyMode: "paper_only", educationalOnly: true,
    });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "setups/score failed");
    res.status(500).json({ error: "score_failed" });
  }
});

// ── GET /api/setups/performance ───────────────────────────────────────────
// Per-playbook performance from REAL closed paper trades that have been
// auto-tagged to a playbook (tradeJournalEntriesTable.matchedPlaybookId).
router.get("/setups/performance", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const journals = await db.select({
      matchedPlaybookId: tradeJournalEntriesTable.matchedPlaybookId,
      tradeId: tradeJournalEntriesTable.tradeId,
      setupQualityScore: tradeJournalEntriesTable.setupQualityScore,
    }).from(tradeJournalEntriesTable)
      .where(and(
        eq(tradeJournalEntriesTable.userId, userId),
        sql`${tradeJournalEntriesTable.matchedPlaybookId} IS NOT NULL`,
      ))
      .limit(2000);
    if (journals.length === 0) {
      res.json({ ok: true, isEmpty: true, reason: "no_tagged_closed_trades", playbooks: [] });
      return;
    }
    const tradeIds = journals.map((j) => j.tradeId).filter((x): x is number => x != null);
    const trades = tradeIds.length > 0
      ? await db.select({ id: paperTradesTable.id, pnl: paperTradesTable.pnl, status: paperTradesTable.status })
          .from(paperTradesTable)
          .where(and(eq(paperTradesTable.userId, userId), sql`${paperTradesTable.id} = ANY(${tradeIds})`))
      : [];
    const pnlByTradeId = new Map<number, number>();
    for (const t of trades) if (t.status === "closed" && t.pnl != null) pnlByTradeId.set(t.id, Number(t.pnl));
    type Agg = { playbookId: number; trades: number; wins: number; losses: number; pnl: number; qualitySum: number; qualityN: number; };
    const agg = new Map<number, Agg>();
    for (const j of journals) {
      if (j.matchedPlaybookId == null || j.tradeId == null) continue;
      const p = pnlByTradeId.get(j.tradeId);
      if (p == null) continue;
      const a = agg.get(j.matchedPlaybookId) ?? { playbookId: j.matchedPlaybookId, trades: 0, wins: 0, losses: 0, pnl: 0, qualitySum: 0, qualityN: 0 };
      a.trades += 1; if (p > 0) a.wins += 1; else if (p < 0) a.losses += 1; a.pnl += p;
      if (j.setupQualityScore != null) { a.qualitySum += Number(j.setupQualityScore); a.qualityN += 1; }
      agg.set(j.matchedPlaybookId, a);
    }
    const pbs = await db.select({ id: userPlaybooksTable.id, title: userPlaybooksTable.title })
      .from(userPlaybooksTable)
      .where(and(eq(userPlaybooksTable.userId, userId), sql`${userPlaybooksTable.id} = ANY(${Array.from(agg.keys())})`));
    const titleById = new Map(pbs.map((p) => [p.id, p.title]));
    const playbooks = Array.from(agg.values()).map((a) => ({
      playbookId: a.playbookId, title: titleById.get(a.playbookId) ?? `Playbook ${a.playbookId}`,
      totalTrades: a.trades, wins: a.wins, losses: a.losses,
      winRate: Number(((a.wins / a.trades) * 100).toFixed(1)),
      realizedPnl: Number(a.pnl.toFixed(2)),
      averageEntryQuality: a.qualityN > 0 ? Number((a.qualitySum / a.qualityN).toFixed(1)) : null,
    }));
    res.json({ ok: true, isEmpty: false, playbooks, safetyMode: "paper_only" });
  } catch (err) {
    req.log.error({ err: String(err) }, "setups/performance failed");
    res.status(500).json({ error: "performance_failed" });
  }
});

// ── POST /api/trades/:id/setup-tag ────────────────────────────────────────
// Upsert a setup tag + quality on the user's journal entry for a paper trade.
const TagBody = z.object({
  setupTag: z.string().min(1).max(40),
  setupQualityScore: z.number().int().min(0).max(100).nullable().optional(),
  setupQualityLabel: z.string().max(20).nullable().optional(),
  matchedPlaybookId: z.number().int().positive().nullable().optional(),
});
router.post("/trades/:id/setup-tag", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const tradeId = Number(req.params.id);
    if (!Number.isFinite(tradeId)) { res.status(400).json({ error: "invalid trade id" }); return; }
    const b = TagBody.parse(req.body ?? {});
    // Verify trade ownership.
    const [trade] = await db.select({ id: paperTradesTable.id, symbol: paperTradesTable.symbol, side: paperTradesTable.side })
      .from(paperTradesTable)
      .where(and(eq(paperTradesTable.userId, userId), eq(paperTradesTable.id, tradeId)))
      .limit(1);
    if (!trade) { res.status(404).json({ error: "trade not found" }); return; }
    if (b.matchedPlaybookId != null) {
      const [pb] = await db.select({ id: userPlaybooksTable.id }).from(userPlaybooksTable)
        .where(and(eq(userPlaybooksTable.userId, userId), eq(userPlaybooksTable.id, b.matchedPlaybookId))).limit(1);
      if (!pb) { res.status(404).json({ error: "playbook not found or not yours" }); return; }
    }
    const [existing] = await db.select({ id: tradeJournalEntriesTable.id }).from(tradeJournalEntriesTable)
      .where(and(eq(tradeJournalEntriesTable.userId, userId), eq(tradeJournalEntriesTable.tradeId, tradeId))).limit(1);
    if (existing) {
      await db.update(tradeJournalEntriesTable).set({
        setupTag: b.setupTag,
        setupQualityScore: b.setupQualityScore ?? null,
        setupQualityLabel: b.setupQualityLabel ?? null,
        matchedPlaybookId: b.matchedPlaybookId ?? null,
        setupQualitySource: "user_supplied",
        updatedAt: new Date(),
      }).where(eq(tradeJournalEntriesTable.id, existing.id));
      res.json({ ok: true, journalEntryId: existing.id, updated: true });
    } else {
      const [ins] = await db.insert(tradeJournalEntriesTable).values({
        userId, tradeId,
        symbol: trade.symbol, direction: trade.side === "sell" ? "SELL" : "BUY",
        setupTag: b.setupTag,
        setupQualityScore: b.setupQualityScore ?? null,
        setupQualityLabel: b.setupQualityLabel ?? null,
        matchedPlaybookId: b.matchedPlaybookId ?? null,
        setupQualitySource: "user_supplied",
      }).returning({ id: tradeJournalEntriesTable.id });
      res.json({ ok: true, journalEntryId: ins!.id, created: true });
    }
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "trades/:id/setup-tag failed");
    res.status(500).json({ error: "tag_failed" });
  }
});

// ── GET /api/coach/strategy-insights ──────────────────────────────────────
// Lightweight derived insight list from the user's playbook performance.
router.get("/coach/strategy-insights", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    // Reuse the performance endpoint logic inline (no internal HTTP call).
    const journals = await db.select({
      matchedPlaybookId: tradeJournalEntriesTable.matchedPlaybookId,
      tradeId: tradeJournalEntriesTable.tradeId,
    }).from(tradeJournalEntriesTable)
      .where(and(
        eq(tradeJournalEntriesTable.userId, userId),
        sql`${tradeJournalEntriesTable.matchedPlaybookId} IS NOT NULL`,
      )).limit(1000);
    if (journals.length === 0) {
      res.json({ ok: true, isEmpty: true,
        message: "Not enough tagged closed trades to generate strategy insights yet.",
        insights: [] });
      return;
    }
    const tradeIds = journals.map((j) => j.tradeId).filter((x): x is number => x != null);
    const trades = tradeIds.length > 0
      ? await db.select({ id: paperTradesTable.id, pnl: paperTradesTable.pnl, status: paperTradesTable.status })
          .from(paperTradesTable)
          .where(and(eq(paperTradesTable.userId, userId), sql`${paperTradesTable.id} = ANY(${tradeIds})`))
      : [];
    const pnlByTradeId = new Map<number, number>();
    for (const t of trades) if (t.status === "closed" && t.pnl != null) pnlByTradeId.set(t.id, Number(t.pnl));
    const byPb = new Map<number, { trades: number; wins: number; pnl: number }>();
    for (const j of journals) {
      if (j.matchedPlaybookId == null || j.tradeId == null) continue;
      const p = pnlByTradeId.get(j.tradeId); if (p == null) continue;
      const a = byPb.get(j.matchedPlaybookId) ?? { trades: 0, wins: 0, pnl: 0 };
      a.trades += 1; if (p > 0) a.wins += 1; a.pnl += p;
      byPb.set(j.matchedPlaybookId, a);
    }
    const pbs = await db.select({ id: userPlaybooksTable.id, title: userPlaybooksTable.title })
      .from(userPlaybooksTable).where(eq(userPlaybooksTable.userId, userId));
    const titleById = new Map(pbs.map((p) => [p.id, p.title]));
    const insights: Array<{ severity: string; title: string; message: string }> = [];
    for (const [pbId, a] of byPb.entries()) {
      const title = titleById.get(pbId) ?? `Playbook ${pbId}`;
      const winRate = (a.wins / a.trades) * 100;
      if (a.trades >= 5 && a.pnl < 0) insights.push({ severity: "warning", title: `Losing strategy: ${title}`, message: `${a.trades} closed trades, net P&L ${a.pnl.toFixed(2)}, win rate ${winRate.toFixed(0)}%.` });
      if (a.trades >= 5 && winRate < 30) insights.push({ severity: "warning", title: `Low win rate: ${title}`, message: `Only ${winRate.toFixed(0)}% of ${a.trades} trades win.` });
      if (a.trades >= 5 && a.pnl > 0 && winRate >= 55) insights.push({ severity: "info", title: `Strong strategy: ${title}`, message: `${a.trades} trades, net P&L ${a.pnl.toFixed(2)}, win rate ${winRate.toFixed(0)}%.` });
    }
    res.json({ ok: true, isEmpty: insights.length === 0, insights, generatedAt: new Date().toISOString() });
  } catch (err) {
    req.log.error({ err: String(err) }, "coach/strategy-insights failed");
    res.status(500).json({ error: "insights_failed" });
  }
});

// ── POST /api/coach/build-playbook ────────────────────────────────────────
// Generates (in-memory only — does NOT persist) a draft playbook from the
// user's recent closed paper trades. User confirms + saves separately via
// existing /me/playbooks/generate-from-history endpoint.
router.post("/coach/build-playbook", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const trades = await db.select().from(paperTradesTable)
      .where(and(eq(paperTradesTable.userId, userId), eq(paperTradesTable.status, "closed")))
      .orderBy(desc(paperTradesTable.closedAt)).limit(50);
    if (trades.length < 5) {
      res.json({ ok: true, dataAvailable: false,
        reason: "insufficient_history", tradesAvailable: trades.length,
        message: `Need at least 5 closed paper trades to build a playbook. You have ${trades.length}.` });
      return;
    }
    const draft = generatePlaybookFromHistory(trades as PaperTrade[], []);
    res.json({
      ok: true, dataAvailable: true, draft,
      note: "Preview only. Persist via POST /api/me/playbooks/generate-from-history on the Playbook page.",
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "coach/build-playbook failed");
    res.status(500).json({ error: "build_failed" });
  }
});

export default router;
