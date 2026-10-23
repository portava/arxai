// Phase 5C — Per-user trade journal routes.
// Wraps the existing tradeJournalEntries table with strict per-user scoping
// and verifies any linked paperTradeId/tradingSessionId belongs to the same user.
import { Router } from "express";
import { db, tradeJournalEntriesTable, paperTradesTable, tradingSessionsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";

const router = Router();

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
  mood: z.string().max(40).nullable().optional(),
  disciplineScore: z.number().int().min(0).max(100).nullable().optional(),
  executionScore: z.number().int().min(0).max(100).nullable().optional(),
  mistakeTags: z.array(z.string().max(40)).max(20).optional(),
  lessonLearned: z.string().max(2000).nullable().optional(),
  paperTradeId: z.number().int().nullable().optional(),
  tradingSessionId: z.number().int().nullable().optional(),
});
const PatchBody = CreateBody.partial();

async function verifyPaperTrade(userId: number, id: number | null | undefined) {
  if (id == null) return true;
  const r = await db.select({ id: paperTradesTable.id }).from(paperTradesTable)
    .where(and(eq(paperTradesTable.id, id), eq(paperTradesTable.userId, userId))).limit(1);
  return !!r[0];
}
async function verifySession(userId: number, id: number | null | undefined) {
  if (id == null) return true;
  const r = await db.select({ id: tradingSessionsTable.id }).from(tradingSessionsTable)
    .where(and(eq(tradingSessionsTable.id, id), eq(tradingSessionsTable.userId, userId))).limit(1);
  return !!r[0];
}

// The legacy journal_entries schema uses different column names; we map our
// Phase-5 contract on top by storing title in setupType, body in userNotes,
// mood in emotionalStateAfter, disciplineScore in confidenceLevel (0-100),
// executionScore packed into followUpGoal as `exec:<n>`. paperTradeId is
// stored in tradeId (loose). We round-trip via serialize().
function serialize(r: typeof tradeJournalEntriesTable.$inferSelect, paperTradeMap: Record<number, number> = {}) {
  const meta = (r.aiReview && (r.aiReview as { _meta?: Record<string, unknown> })._meta) ?? {};
  return {
    id: r.id,
    userId: r.userId,
    paperTradeId: r.tradeId ?? (paperTradeMap[r.id] ?? null),
    tradingSessionId: (meta as { tradingSessionId?: number }).tradingSessionId ?? null,
    title: r.setupType ?? "(untitled)",
    body: r.userNotes ?? "",
    mood: r.emotionalStateAfter ?? null,
    disciplineScore: r.confidenceLevel ?? null,
    executionScore: (meta as { executionScore?: number }).executionScore ?? null,
    mistakeTags: r.mistakeTags ?? [],
    lessonLearned: r.lessonLearned ?? null,
    createdAt: r.createdAt?.toISOString() ?? null,
    updatedAt: r.updatedAt?.toISOString() ?? null,
  };
}

router.get("/me/trade-journal", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const rows = await db.select().from(tradeJournalEntriesTable)
    .where(eq(tradeJournalEntriesTable.userId, userId))
    .orderBy(desc(tradeJournalEntriesTable.createdAt)).limit(500);
  res.json({ entries: rows.map((r) => serialize(r)) });
});

router.get("/me/trade-journal/:id", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const r = await db.select().from(tradeJournalEntriesTable)
    .where(and(eq(tradeJournalEntriesTable.id, id), eq(tradeJournalEntriesTable.userId, userId)))
    .limit(1);
  if (!r[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json(serialize(r[0]));
});

router.post("/me/trade-journal", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const body = CreateBody.parse(req.body ?? {});
    if (!(await verifyPaperTrade(userId, body.paperTradeId))) {
      res.status(404).json({ error: "Paper trade not found" }); return;
    }
    if (!(await verifySession(userId, body.tradingSessionId))) {
      res.status(404).json({ error: "Trading session not found" }); return;
    }
    const inserted = await db.insert(tradeJournalEntriesTable).values({
      userId,
      tradeId: body.paperTradeId ?? null,
      symbol: "JOURNAL",   // legacy not-null; placeholder for journal-only entries
      direction: "NA",
      setupType: body.title,
      userNotes: body.body,
      emotionalStateAfter: body.mood ?? null,
      confidenceLevel: body.disciplineScore ?? null,
      mistakeTags: body.mistakeTags ?? [],
      lessonLearned: body.lessonLearned ?? null,
      aiReview: { _meta: {
        executionScore: body.executionScore ?? null,
        tradingSessionId: body.tradingSessionId ?? null,
      } } as never,
    }).returning();
    res.status(201).json(serialize(inserted[0]!));
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /me/trade-journal failed");
    res.status(500).json({ error: "Failed" });
  }
});

router.patch("/me/trade-journal/:id", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const exists = await db.select().from(tradeJournalEntriesTable)
      .where(and(eq(tradeJournalEntriesTable.id, id), eq(tradeJournalEntriesTable.userId, userId))).limit(1);
    if (!exists[0]) { res.status(404).json({ error: "Not found" }); return; }
    const body = PatchBody.parse(req.body ?? {});
    if (body.paperTradeId !== undefined && !(await verifyPaperTrade(userId, body.paperTradeId))) {
      res.status(404).json({ error: "Paper trade not found" }); return;
    }
    if (body.tradingSessionId !== undefined && !(await verifySession(userId, body.tradingSessionId))) {
      res.status(404).json({ error: "Trading session not found" }); return;
    }
    const cur = exists[0];
    const curMeta = (cur.aiReview && (cur.aiReview as { _meta?: Record<string, unknown> })._meta) ?? {};
    const updated = await db.update(tradeJournalEntriesTable).set({
      tradeId: body.paperTradeId !== undefined ? body.paperTradeId : cur.tradeId,
      setupType: body.title ?? cur.setupType,
      userNotes: body.body ?? cur.userNotes,
      emotionalStateAfter: body.mood !== undefined ? body.mood : cur.emotionalStateAfter,
      confidenceLevel: body.disciplineScore !== undefined ? body.disciplineScore : cur.confidenceLevel,
      mistakeTags: body.mistakeTags ?? cur.mistakeTags ?? [],
      lessonLearned: body.lessonLearned !== undefined ? body.lessonLearned : cur.lessonLearned,
      aiReview: { _meta: {
        ...curMeta,
        executionScore: body.executionScore !== undefined ? body.executionScore : (curMeta as { executionScore?: number }).executionScore,
        tradingSessionId: body.tradingSessionId !== undefined ? body.tradingSessionId : (curMeta as { tradingSessionId?: number }).tradingSessionId,
      } } as never,
      updatedAt: new Date(),
    }).where(and(eq(tradeJournalEntriesTable.id, id), eq(tradeJournalEntriesTable.userId, userId))).returning();
    res.json(serialize(updated[0]!));
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "PATCH /me/trade-journal/:id failed");
    res.status(500).json({ error: "Failed" });
  }
});

router.delete("/me/trade-journal/:id", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const r = await db.delete(tradeJournalEntriesTable)
    .where(and(eq(tradeJournalEntriesTable.id, id), eq(tradeJournalEntriesTable.userId, userId))).returning();
  if (!r[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ deleted: true, id });
});

export default router;
