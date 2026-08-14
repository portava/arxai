// Phase 7B/7C — Per-user playbooks, rules, AI generation, pre-trade checks.
// SAFETY: every route requireUser, scoped by req.authUser.id.
// No broker calls anywhere. Pre-trade "block" decisions are advisory in paper mode.
import { Router } from "express";
import {
  db, paperTradesTable, aiTradeReviewsTable,
  userPlaybooksTable, playbookRulesV2Table, preTradeChecksTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { generatePlaybookFromHistory, generatePlaybookFromSingleTrade, evaluatePreTradeCheck } from "../lib/playbookEngine.js";

const router = Router();

async function ownPlaybook(userId: number, id: number) {
  const r = await db.select().from(userPlaybooksTable)
    .where(and(eq(userPlaybooksTable.id, id), eq(userPlaybooksTable.userId, userId))).limit(1);
  return r[0] ?? null;
}
async function ownTrade(userId: number, id: number) {
  const r = await db.select().from(paperTradesTable)
    .where(and(eq(paperTradesTable.id, id), eq(paperTradesTable.userId, userId))).limit(1);
  return r[0] ?? null;
}

function serialize(p: typeof userPlaybooksTable.$inferSelect) {
  return {
    ...p, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
    safetyMode: "paper_only" as const, educationalOnly: true as const,
  };
}

const VALID_RULE_TYPES = ["entry", "exit", "risk", "avoid", "confirmation", "session", "psychology"] as const;
const VALID_SEVERITIES = ["required", "recommended", "optional"] as const;
const VALID_STATUS = ["draft", "active", "archived"] as const;

// ── Playbook CRUD ────────────────────────────────────────────────────────
router.get("/me/playbooks", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const rows = await db.select().from(userPlaybooksTable)
    .where(eq(userPlaybooksTable.userId, userId))
    .orderBy(desc(userPlaybooksTable.updatedAt)).limit(500);
  res.json({ playbooks: rows.map(serialize), isEmpty: rows.length === 0 });
});

router.post("/me/playbooks", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const b = req.body ?? {};
  if (!b.title || typeof b.title !== "string" || b.title.trim().length < 2) { res.status(400).json({ error: "title required" }); return; }
  if (!b.strategyType || typeof b.strategyType !== "string") { res.status(400).json({ error: "strategyType required" }); return; }
  const ins = await db.insert(userPlaybooksTable).values({
    userId, title: b.title.trim(), description: b.description ?? "", strategyType: b.strategyType,
    marketType: b.marketType ?? null,
    preferredSymbols: Array.isArray(b.preferredSymbols) ? b.preferredSymbols : [],
    preferredSessions: Array.isArray(b.preferredSessions) ? b.preferredSessions : [],
    timeframe: b.timeframe ?? null,
    entryModel: b.entryModel ?? "", exitModel: b.exitModel ?? "", riskModel: b.riskModel ?? "",
    invalidationRules: Array.isArray(b.invalidationRules) ? b.invalidationRules : [],
    confirmationRules: Array.isArray(b.confirmationRules) ? b.confirmationRules : [],
    avoidRules: Array.isArray(b.avoidRules) ? b.avoidRules : [],
    checklist: Array.isArray(b.checklist) ? b.checklist : [],
    status: VALID_STATUS.includes(b.status) ? b.status : "draft",
    source: "manual",
  }).returning();
  res.status(201).json(serialize(ins[0]!));
});

router.get("/me/playbooks/:id", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const p = await ownPlaybook(userId, id);
  if (!p) { res.status(404).json({ error: "Playbook not found" }); return; }
  const rules = await db.select().from(playbookRulesV2Table)
    .where(and(eq(playbookRulesV2Table.userId, userId), eq(playbookRulesV2Table.playbookId, id)))
    .orderBy(playbookRulesV2Table.orderIndex);
  res.json({ ...serialize(p), rules });
});

router.patch("/me/playbooks/:id", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const p = await ownPlaybook(userId, id);
  if (!p) { res.status(404).json({ error: "Playbook not found" }); return; }
  const b = req.body ?? {};
  const upd: Partial<typeof userPlaybooksTable.$inferInsert> = { updatedAt: new Date() };
  for (const k of ["title", "description", "strategyType", "marketType", "timeframe", "entryModel", "exitModel", "riskModel"] as const) {
    if (typeof b[k] === "string") (upd as Record<string, unknown>)[k] = b[k];
  }
  for (const k of ["preferredSymbols", "preferredSessions", "invalidationRules", "confirmationRules", "avoidRules", "checklist"] as const) {
    if (Array.isArray(b[k])) (upd as Record<string, unknown>)[k] = b[k];
  }
  if (b.status && VALID_STATUS.includes(b.status)) upd.status = b.status;
  const u = await db.update(userPlaybooksTable).set(upd)
    .where(and(eq(userPlaybooksTable.id, id), eq(userPlaybooksTable.userId, userId))).returning();
  res.json(serialize(u[0]!));
});

router.delete("/me/playbooks/:id", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  if (!(await ownPlaybook(userId, id))) { res.status(404).json({ error: "Playbook not found" }); return; }
  await db.delete(playbookRulesV2Table)
    .where(and(eq(playbookRulesV2Table.userId, userId), eq(playbookRulesV2Table.playbookId, id)));
  await db.delete(userPlaybooksTable)
    .where(and(eq(userPlaybooksTable.id, id), eq(userPlaybooksTable.userId, userId)));
  res.json({ ok: true });
});

router.post("/me/playbooks/:id/archive", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  if (!(await ownPlaybook(userId, id))) { res.status(404).json({ error: "Playbook not found" }); return; }
  const u = await db.update(userPlaybooksTable).set({ status: "archived", updatedAt: new Date() })
    .where(and(eq(userPlaybooksTable.id, id), eq(userPlaybooksTable.userId, userId))).returning();
  res.json(serialize(u[0]!));
});
router.post("/me/playbooks/:id/activate", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  if (!(await ownPlaybook(userId, id))) { res.status(404).json({ error: "Playbook not found" }); return; }
  const u = await db.update(userPlaybooksTable).set({ status: "active", updatedAt: new Date() })
    .where(and(eq(userPlaybooksTable.id, id), eq(userPlaybooksTable.userId, userId))).returning();
  res.json(serialize(u[0]!));
});

// ── Rules CRUD (scoped) ──────────────────────────────────────────────────
router.get("/me/playbooks/:id/rules", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  if (!(await ownPlaybook(userId, id))) { res.status(404).json({ error: "Playbook not found" }); return; }
  const rows = await db.select().from(playbookRulesV2Table)
    .where(and(eq(playbookRulesV2Table.userId, userId), eq(playbookRulesV2Table.playbookId, id)))
    .orderBy(playbookRulesV2Table.orderIndex);
  res.json({ rules: rows });
});
router.post("/me/playbooks/:id/rules", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  if (!(await ownPlaybook(userId, id))) { res.status(404).json({ error: "Playbook not found" }); return; }
  const b = req.body ?? {};
  if (!VALID_RULE_TYPES.includes(b.ruleType)) { res.status(400).json({ error: "invalid ruleType" }); return; }
  if (!b.ruleText || typeof b.ruleText !== "string") { res.status(400).json({ error: "ruleText required" }); return; }
  const sev = VALID_SEVERITIES.includes(b.severity) ? b.severity : "recommended";
  const ins = await db.insert(playbookRulesV2Table).values({
    userId, playbookId: id, ruleType: b.ruleType, ruleText: b.ruleText, severity: sev,
    orderIndex: typeof b.orderIndex === "number" ? b.orderIndex : 0,
  }).returning();
  res.status(201).json(ins[0]);
});
router.patch("/me/playbooks/:id/rules/:ruleId", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id); const ruleId = Number(req.params.ruleId);
  if (!Number.isFinite(id) || !Number.isFinite(ruleId)) { res.status(400).json({ error: "invalid id" }); return; }
  if (!(await ownPlaybook(userId, id))) { res.status(404).json({ error: "Playbook not found" }); return; }
  const b = req.body ?? {};
  const upd: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof b.ruleText === "string") upd.ruleText = b.ruleText;
  if (VALID_RULE_TYPES.includes(b.ruleType)) upd.ruleType = b.ruleType;
  if (VALID_SEVERITIES.includes(b.severity)) upd.severity = b.severity;
  if (typeof b.orderIndex === "number") upd.orderIndex = b.orderIndex;
  const u = await db.update(playbookRulesV2Table).set(upd)
    .where(and(eq(playbookRulesV2Table.id, ruleId), eq(playbookRulesV2Table.userId, userId), eq(playbookRulesV2Table.playbookId, id))).returning();
  if (!u[0]) { res.status(404).json({ error: "Rule not found" }); return; }
  res.json(u[0]);
});
router.delete("/me/playbooks/:id/rules/:ruleId", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id); const ruleId = Number(req.params.ruleId);
  if (!Number.isFinite(id) || !Number.isFinite(ruleId)) { res.status(400).json({ error: "invalid id" }); return; }
  if (!(await ownPlaybook(userId, id))) { res.status(404).json({ error: "Playbook not found" }); return; }
  const d = await db.delete(playbookRulesV2Table)
    .where(and(eq(playbookRulesV2Table.id, ruleId), eq(playbookRulesV2Table.userId, userId), eq(playbookRulesV2Table.playbookId, id))).returning();
  if (!d[0]) { res.status(404).json({ error: "Rule not found" }); return; }
  res.json({ ok: true });
});

// ── AI generation ────────────────────────────────────────────────────────
async function persistGenerated(userId: number, gen: ReturnType<typeof generatePlaybookFromHistory>) {
  const ins = await db.insert(userPlaybooksTable).values({
    userId, title: gen.title, description: gen.description, strategyType: gen.strategyType,
    marketType: gen.marketType, preferredSymbols: gen.preferredSymbols, preferredSessions: gen.preferredSessions,
    timeframe: gen.timeframe,
    entryModel: gen.entryModel, exitModel: gen.exitModel, riskModel: gen.riskModel,
    invalidationRules: gen.invalidationRules, confirmationRules: gen.confirmationRules,
    avoidRules: gen.avoidRules, checklist: gen.checklist,
    status: "draft", source: gen.source,
    confidenceScore: gen.confidenceScore, winRateSnapshot: gen.winRateSnapshot, sampleSize: gen.sampleSize,
  }).returning();
  const pb = ins[0]!;
  if (gen.rules.length > 0) {
    await db.insert(playbookRulesV2Table).values(gen.rules.map((r) => ({
      userId, playbookId: pb.id, ruleType: r.ruleType, ruleText: r.ruleText, severity: r.severity, orderIndex: r.orderIndex,
    })));
  }
  return pb;
}

router.post("/me/playbooks/generate-from-history", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const trades = await db.select().from(paperTradesTable).where(eq(paperTradesTable.userId, userId));
  const reviews = await db.select().from(aiTradeReviewsTable).where(eq(aiTradeReviewsTable.userId, userId));
  const gen = generatePlaybookFromHistory(trades, reviews);
  const pb = await persistGenerated(userId, gen);
  res.status(201).json({ ...serialize(pb), notice: gen.notice, generatedRulesCount: gen.rules.length });
});

router.post("/me/paper-trades/:id/promote-to-playbook", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const tradeId = Number(req.params.id);
  if (!Number.isFinite(tradeId)) { res.status(400).json({ error: "invalid id" }); return; }
  const trade = await ownTrade(userId, tradeId);
  if (!trade) { res.status(404).json({ error: "Trade not found" }); return; }
  const review = (await db.select().from(aiTradeReviewsTable)
    .where(and(eq(aiTradeReviewsTable.userId, userId), eq(aiTradeReviewsTable.paperTradeId, tradeId))).limit(1))[0] ?? null;
  const gen = generatePlaybookFromSingleTrade(trade, review);
  const pb = await persistGenerated(userId, gen);
  res.status(201).json({ ...serialize(pb), notice: gen.notice });
});

router.post("/me/playbooks/:id/improve", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const pb = await ownPlaybook(userId, id);
  if (!pb) { res.status(404).json({ error: "Playbook not found" }); return; }
  const trades = await db.select().from(paperTradesTable).where(eq(paperTradesTable.userId, userId));
  const reviews = await db.select().from(aiTradeReviewsTable).where(eq(aiTradeReviewsTable.userId, userId));
  const gen = generatePlaybookFromHistory(trades, reviews);
  // Merge: append new avoid rules + bump snapshots, keep title/description if user customized
  const u = await db.update(userPlaybooksTable).set({
    avoidRules: Array.from(new Set([...(pb.avoidRules ?? []), ...gen.avoidRules])),
    confirmationRules: Array.from(new Set([...(pb.confirmationRules ?? []), ...gen.confirmationRules])),
    winRateSnapshot: gen.winRateSnapshot, sampleSize: gen.sampleSize,
    confidenceScore: gen.confidenceScore, updatedAt: new Date(),
  }).where(and(eq(userPlaybooksTable.id, id), eq(userPlaybooksTable.userId, userId))).returning();
  res.json({ ...serialize(u[0]!), notice: gen.notice ?? "Playbook updated with latest patterns from your trades." });
});

// ── Pre-trade checklist ──────────────────────────────────────────────────
router.post("/me/playbooks/:id/pre-trade-check", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const pb = await ownPlaybook(userId, id);
  if (!pb) { res.status(404).json({ error: "Playbook not found" }); return; }
  const b = req.body ?? {};
  if (!b.symbol || typeof b.symbol !== "string") { res.status(400).json({ error: "symbol required" }); return; }
  const rules = await db.select().from(playbookRulesV2Table)
    .where(and(eq(playbookRulesV2Table.userId, userId), eq(playbookRulesV2Table.playbookId, id)));

  // Recent behavior
  const recent = await db.select().from(paperTradesTable)
    .where(and(eq(paperTradesTable.userId, userId), eq(paperTradesTable.status, "closed")))
    .orderBy(desc(paperTradesTable.closedAt)).limit(20);
  const now = Date.now();
  const lastClosed = recent[0];
  const lastClosedWasLoss = !!(lastClosed && (lastClosed.pnl ?? 0) < 0 && lastClosed.closedAt && (now - lastClosed.closedAt.getTime()) < 60 * 60_000);
  const tradesInLastHour = recent.filter((t) => t.closedAt && (now - t.closedAt.getTime()) < 60 * 60_000).length;

  const result = evaluatePreTradeCheck(pb, rules, {
    symbol: b.symbol, side: b.side ?? null,
    stopLoss: b.stopLoss ?? null, takeProfit: b.takeProfit ?? null,
    entryPrice: b.entryPrice ?? null, lotSize: b.lotSize ?? null,
    riskAmount: b.riskAmount ?? null, riskPercent: b.riskPercent ?? null,
    rewardRiskRatio: b.rewardRiskRatio ?? null, reasonForEntry: b.reasonForEntry ?? null,
  }, { lastClosedWasLoss, tradesInLastHour });

  let paperTradeId: number | null = null;
  if (b.paperTradeId != null) {
    const t = await ownTrade(userId, Number(b.paperTradeId));
    if (!t) { res.status(404).json({ error: "Linked trade not found" }); return; }
    paperTradeId = t.id;
  }

  const ins = await db.insert(preTradeChecksTable).values({
    userId, playbookId: id, paperTradeId,
    tradingSessionId: b.tradingSessionId ?? null,
    symbol: b.symbol, side: b.side ?? null,
    checklistResult: result.checklistResult,
    passedRequiredCount: result.passedRequiredCount,
    failedRequiredCount: result.failedRequiredCount,
    score: result.score, decision: result.decision,
    notes: b.notes ?? null,
  }).returning();

  res.status(201).json({
    id: ins[0]!.id, ...result,
    safetyMode: "paper_only", educationalOnly: true,
    note: result.decision === "block"
      ? "BLOCK is advisory in paper mode only. No live broker execution can be triggered from this app."
      : "Educational paper-trading guidance only.",
  });
});

router.get("/me/pre-trade-checks", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const rows = await db.select().from(preTradeChecksTable)
    .where(eq(preTradeChecksTable.userId, userId))
    .orderBy(desc(preTradeChecksTable.createdAt)).limit(200);
  res.json({ checks: rows, isEmpty: rows.length === 0 });
});

router.get("/me/pre-trade-checks/:id", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const r = await db.select().from(preTradeChecksTable)
    .where(and(eq(preTradeChecksTable.id, id), eq(preTradeChecksTable.userId, userId))).limit(1);
  if (!r[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json(r[0]);
});

export default router;
