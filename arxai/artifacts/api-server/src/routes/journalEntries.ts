// Build I — Trade Journal & Review Center routes.
//
// COMPOSES:
//   - tradesTable                (system-of-record trade rows; we read pnl/strategy)
//   - tradeJournalEntriesTable   (NEW — rich learning record per trade)
//   - tradeReviewSessionsTable   (NEW — periodic rollup)
//   - vault_events               (truthDomain="JOURNAL" feeds AI Coach + scoring)
//
// Mounted under /api. The legacy /api/journal route (minimal quick-log) is
// preserved untouched in routes/journal.ts.

import { Router } from "express";
import {
  db,
  tradesTable,
  tradeJournalEntriesTable,
  tradeReviewSessionsTable,
  vaultEventsTable,
} from "@workspace/db";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import {
  MISTAKE_TAGS, STRENGTH_TAGS, EMOTIONAL_STATES,
  unknownMistakeTags, unknownStrengthTags,
  reviewJournalEntry, summarizeReviewSession,
  MISTAKE_IMPACT, STRENGTH_IMPACT,
  type JournalEntryInput,
} from "@workspace/domain/journal";

const router = Router();

const TagsArr = z.array(z.string()).max(32);

const CreateBody = z.object({
  tradeId: z.number().int().positive().nullable().optional(),
  symbol: z.string().min(1),
  direction: z.enum(["BUY", "SELL"]),
  strategyUsed: z.string().nullable().optional(),
  setupType: z.string().nullable().optional(),
  emotionalStateBefore: z.enum(EMOTIONAL_STATES).nullable().optional(),
  emotionalStateAfter: z.enum(EMOTIONAL_STATES).nullable().optional(),
  confidenceLevel: z.number().int().min(0).max(100).nullable().optional(),
  mistakeTags: TagsArr.optional(),
  strengthTags: TagsArr.optional(),
  screenshots: z.array(z.string().url()).max(10).optional(),
  userNotes: z.string().max(5000).nullable().optional(),
  lessonLearned: z.string().max(2000).nullable().optional(),
  followUpGoal: z.string().max(500).nullable().optional(),
});
const UpdateBody = CreateBody.partial();

function validateTags(mistakeTags?: string[], strengthTags?: string[]) {
  const errs: string[] = [];
  if (mistakeTags) {
    const u = unknownMistakeTags(mistakeTags);
    if (u.length) errs.push(`Unknown mistake tags: ${u.join(", ")}`);
  }
  if (strengthTags) {
    const u = unknownStrengthTags(strengthTags);
    if (u.length) errs.push(`Unknown strength tags: ${u.join(", ")}`);
  }
  return errs;
}

function serialize(row: typeof tradeJournalEntriesTable.$inferSelect) {
  return {
    id: row.id,
    tradeId: row.tradeId,
    symbol: row.symbol,
    direction: row.direction,
    strategyUsed: row.strategyUsed,
    setupType: row.setupType,
    emotionalStateBefore: row.emotionalStateBefore,
    emotionalStateAfter: row.emotionalStateAfter,
    confidenceLevel: row.confidenceLevel,
    mistakeTags: row.mistakeTags ?? [],
    strengthTags: row.strengthTags ?? [],
    screenshots: row.screenshots ?? [],
    userNotes: row.userNotes,
    aiReview: row.aiReview,
    lessonLearned: row.lessonLearned,
    followUpGoal: row.followUpGoal,
    createdAtIso: row.createdAt.toISOString(),
    updatedAtIso: row.updatedAt.toISOString(),
  };
}

function serializeSession(row: typeof tradeReviewSessionsTable.$inferSelect) {
  return {
    id: row.id,
    reviewType: row.reviewType,
    dateRangeStartIso: row.dateRangeStart.toISOString(),
    dateRangeEndIso: row.dateRangeEnd.toISOString(),
    totalTradesReviewed: row.totalTradesReviewed,
    biggestStrength: row.biggestStrength,
    biggestWeakness: row.biggestWeakness,
    aiSummary: row.aiSummary,
    actionPlan: row.actionPlan ?? [],
    metrics: row.metrics,
    createdAtIso: row.createdAt.toISOString(),
  };
}

// Use the canonical BEHAVIOR truth-domain — journal entries record operator
// behavior, and BEHAVIOR is part of the typed VaultTruthDomain vocabulary.
async function vault(kind: string, severity: "INFO" | "WARN" | "DANGER", payload: Record<string, unknown>) {
  await db.insert(vaultEventsTable).values({
    kind, severity, source: "USER", truthDomain: "BEHAVIOR",
    summary: kind, payload, reasons: [], blockers: [],
    generatedAtIso: new Date().toISOString(),
  });
}

async function buildEntryInput(row: typeof tradeJournalEntriesTable.$inferSelect): Promise<JournalEntryInput> {
  let pnl: number | null = null;
  if (row.tradeId) {
    const t = await db.select().from(tradesTable).where(eq(tradesTable.id, row.tradeId)).limit(1);
    pnl = t[0]?.pnl ?? null;
  }
  return {
    symbol: row.symbol,
    direction: row.direction as "BUY" | "SELL",
    strategyUsed: row.strategyUsed,
    setupType: row.setupType,
    emotionalStateBefore: row.emotionalStateBefore,
    emotionalStateAfter: row.emotionalStateAfter,
    confidenceLevel: row.confidenceLevel,
    mistakeTags: row.mistakeTags ?? [],
    strengthTags: row.strengthTags ?? [],
    pnl,
    userNotes: row.userNotes,
  };
}

// ── routes ─────────────────────────────────────────────────────────────────

// GET /journal/entries
router.get("/journal/entries", requireUser, async (req, res) => {
  try {
    const userId = req.authUser!.id;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol : null;
    const conds = [eq(tradeJournalEntriesTable.userId, userId)];
    if (symbol) conds.push(eq(tradeJournalEntriesTable.symbol, symbol));
    const rows = await db.select().from(tradeJournalEntriesTable)
      .where(and(...conds))
      .orderBy(desc(tradeJournalEntriesTable.createdAt))
      .limit(limit);
    res.json({ entries: rows.map(serialize) });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /journal/entries failed");
    res.status(500).json({ error: "Failed to load journal entries" });
  }
});

// GET /journal/entries/:id
router.get("/journal/entries/:id", requireUser, async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const rows = await db.select().from(tradeJournalEntriesTable)
      .where(and(eq(tradeJournalEntriesTable.id, id), eq(tradeJournalEntriesTable.userId, req.authUser!.id)))
      .limit(1);
    const row = rows[0];
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(serialize(row));
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /journal/entries/:id failed");
    res.status(500).json({ error: "Failed to load entry" });
  }
});

// POST /journal/entries
router.post("/journal/entries", requireUser, async (req, res): Promise<void> => {
  try {
    const body = CreateBody.parse(req.body ?? {});
    const tagErrs = validateTags(body.mistakeTags, body.strengthTags);
    if (tagErrs.length) { res.status(400).json({ error: "Invalid tags", details: tagErrs }); return; }
    const inserted = await db.insert(tradeJournalEntriesTable).values({
      userId: req.authUser!.id,
      tradeId: body.tradeId ?? null,
      symbol: body.symbol,
      direction: body.direction,
      strategyUsed: body.strategyUsed ?? null,
      setupType: body.setupType ?? null,
      emotionalStateBefore: body.emotionalStateBefore ?? null,
      emotionalStateAfter: body.emotionalStateAfter ?? null,
      confidenceLevel: body.confidenceLevel ?? null,
      mistakeTags: body.mistakeTags ?? [],
      strengthTags: body.strengthTags ?? [],
      screenshots: body.screenshots ?? [],
      userNotes: body.userNotes ?? null,
      lessonLearned: body.lessonLearned ?? null,
      followUpGoal: body.followUpGoal ?? null,
    }).returning();
    const row = inserted[0]!;
    await vault("JOURNAL_ENTRY_CREATED", "INFO", {
      entryId: row.id, tradeId: row.tradeId, mistakeTags: row.mistakeTags, strengthTags: row.strengthTags,
    });
    res.status(201).json(serialize(row));
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /journal/entries failed");
    res.status(500).json({ error: "Failed to create entry" });
  }
});

// PATCH /journal/entries/:id
router.patch("/journal/entries/:id", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const body = UpdateBody.parse(req.body ?? {});
    const tagErrs = validateTags(body.mistakeTags, body.strengthTags);
    if (tagErrs.length) { res.status(400).json({ error: "Invalid tags", details: tagErrs }); return; }

    const prevRows = await db.select().from(tradeJournalEntriesTable)
      .where(and(eq(tradeJournalEntriesTable.id, id), eq(tradeJournalEntriesTable.userId, userId)))
      .limit(1);
    const prev = prevRows[0];
    if (!prev) { res.status(404).json({ error: "Not found" }); return; }

    const updated = await db.update(tradeJournalEntriesTable).set({
      ...(body.tradeId !== undefined ? { tradeId: body.tradeId } : {}),
      ...(body.symbol !== undefined ? { symbol: body.symbol } : {}),
      ...(body.direction !== undefined ? { direction: body.direction } : {}),
      ...(body.strategyUsed !== undefined ? { strategyUsed: body.strategyUsed } : {}),
      ...(body.setupType !== undefined ? { setupType: body.setupType } : {}),
      ...(body.emotionalStateBefore !== undefined ? { emotionalStateBefore: body.emotionalStateBefore } : {}),
      ...(body.emotionalStateAfter !== undefined ? { emotionalStateAfter: body.emotionalStateAfter } : {}),
      ...(body.confidenceLevel !== undefined ? { confidenceLevel: body.confidenceLevel } : {}),
      ...(body.mistakeTags !== undefined ? { mistakeTags: body.mistakeTags } : {}),
      ...(body.strengthTags !== undefined ? { strengthTags: body.strengthTags } : {}),
      ...(body.screenshots !== undefined ? { screenshots: body.screenshots } : {}),
      ...(body.userNotes !== undefined ? { userNotes: body.userNotes } : {}),
      ...(body.lessonLearned !== undefined ? { lessonLearned: body.lessonLearned } : {}),
      ...(body.followUpGoal !== undefined ? { followUpGoal: body.followUpGoal } : {}),
      updatedAt: new Date(),
    }).where(and(eq(tradeJournalEntriesTable.id, id), eq(tradeJournalEntriesTable.userId, userId))).returning();
    const row = updated[0]!;
    await vault("JOURNAL_ENTRY_UPDATED", "INFO", {
      entryId: row.id,
      mistakeTagsAdded: diffTags(prev.mistakeTags ?? [], row.mistakeTags ?? []),
      strengthTagsAdded: diffTags(prev.strengthTags ?? [], row.strengthTags ?? []),
    });
    res.json(serialize(row));
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "PATCH /journal/entries/:id failed");
    res.status(500).json({ error: "Failed to update entry" });
  }
});

// POST /journal/entries/:id/ai-review
router.post("/journal/entries/:id/ai-review", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const rows = await db.select().from(tradeJournalEntriesTable)
      .where(and(eq(tradeJournalEntriesTable.id, id), eq(tradeJournalEntriesTable.userId, userId)))
      .limit(1);
    const row = rows[0];
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    const input = await buildEntryInput(row);
    const review = reviewJournalEntry(input, new Date().toISOString());
    const updated = await db.update(tradeJournalEntriesTable)
      .set({ aiReview: review, updatedAt: new Date() })
      .where(and(eq(tradeJournalEntriesTable.id, id), eq(tradeJournalEntriesTable.userId, userId)))
      .returning();
    res.json(serialize(updated[0]!));
  } catch (err) {
    req.log.error({ err: String(err) }, "POST /journal/entries/:id/ai-review failed");
    res.status(500).json({ error: "Failed to generate review" });
  }
});

// GET /journal/reviews
router.get("/journal/reviews", requireUser, async (req, res) => {
  try {
    const userId = req.authUser!.id;
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const rows = await db.select().from(tradeReviewSessionsTable)
      .where(eq(tradeReviewSessionsTable.userId, userId))
      .orderBy(desc(tradeReviewSessionsTable.createdAt))
      .limit(limit);
    res.json({ sessions: rows.map(serializeSession) });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /journal/reviews failed");
    res.status(500).json({ error: "Failed to load reviews" });
  }
});

// POST /journal/reviews/weekly  and  /journal/reviews/monthly
async function createReview(userId: number, reviewType: "WEEKLY" | "MONTHLY") {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - (reviewType === "WEEKLY" ? 7 : 30));

  const entries = await db.select().from(tradeJournalEntriesTable).where(
    and(
      eq(tradeJournalEntriesTable.userId, userId),
      gte(tradeJournalEntriesTable.createdAt, start),
      lte(tradeJournalEntriesTable.createdAt, end),
    ),
  );

  const inputs: JournalEntryInput[] = await Promise.all(entries.map((row) => buildEntryInput(row)));
  const summary = summarizeReviewSession({ reviewType, dateRangeStart: start, dateRangeEnd: end, entries: inputs });

  const inserted = await db.insert(tradeReviewSessionsTable).values({
    userId,
    reviewType,
    dateRangeStart: start,
    dateRangeEnd: end,
    totalTradesReviewed: summary.totalTradesReviewed,
    biggestStrength: summary.biggestStrength,
    biggestWeakness: summary.biggestWeakness,
    aiSummary: summary.aiSummary,
    actionPlan: summary.actionPlan,
    metrics: summary.metrics,
  }).returning();
  const row = inserted[0]!;
  await vault(reviewType === "WEEKLY" ? "JOURNAL_WEEKLY_REVIEW" : "JOURNAL_MONTHLY_REVIEW", "INFO", {
    reviewId: row.id, totalTradesReviewed: row.totalTradesReviewed,
  });
  return row;
}

router.post("/journal/reviews/weekly", requireUser, async (req, res) => {
  try { res.json(serializeSession(await createReview(req.authUser!.id, "WEEKLY"))); }
  catch (err) { req.log.error({ err: String(err) }, "weekly review failed"); res.status(500).json({ error: "Failed to create weekly review" }); }
});
router.post("/journal/reviews/monthly", requireUser, async (req, res) => {
  try { res.json(serializeSession(await createReview(req.authUser!.id, "MONTHLY"))); }
  catch (err) { req.log.error({ err: String(err) }, "monthly review failed"); res.status(500).json({ error: "Failed to create monthly review" }); }
});

// GET /journal/tags-summary — counts + score impact per tag
router.get("/journal/tags-summary", requireUser, async (req, res) => {
  try {
    const rows = await db.select({
      mistakeTags: tradeJournalEntriesTable.mistakeTags,
      strengthTags: tradeJournalEntriesTable.strengthTags,
    }).from(tradeJournalEntriesTable)
      .where(eq(tradeJournalEntriesTable.userId, req.authUser!.id));
    const mistake = new Map<string, number>();
    const strength = new Map<string, number>();
    for (const r of rows) {
      for (const t of r.mistakeTags ?? []) mistake.set(t, (mistake.get(t) ?? 0) + 1);
      for (const t of r.strengthTags ?? []) strength.set(t, (strength.get(t) ?? 0) + 1);
    }
    res.json({
      totalEntries: rows.length,
      mistakeTags: [...mistake.entries()].map(([tag, count]) => ({
        tag, count, impact: MISTAKE_IMPACT[tag as keyof typeof MISTAKE_IMPACT] ?? null,
      })).sort((a, b) => b.count - a.count),
      strengthTags: [...strength.entries()].map(([tag, count]) => ({
        tag, count, impact: STRENGTH_IMPACT[tag as keyof typeof STRENGTH_IMPACT] ?? null,
      })).sort((a, b) => b.count - a.count),
      vocab: { mistake: [...MISTAKE_TAGS], strength: [...STRENGTH_TAGS], emotional: [...EMOTIONAL_STATES] },
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /journal/tags-summary failed");
    res.status(500).json({ error: "Failed to load tag summary" });
  }
});

function diffTags(prev: string[], next: string[]): string[] {
  const set = new Set(prev);
  return next.filter((t) => !set.has(t));
}

export default router;
void sql;
