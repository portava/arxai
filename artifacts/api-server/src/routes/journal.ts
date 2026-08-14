import { Router } from "express";
import { db, tradeJournalTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";

const router = Router();

const CreateJournalBody = z.object({
  symbol: z.string().min(1),
  direction: z.enum(["BUY", "SELL", "WAIT"]),
  strategy: z.string().min(1),
  entryIdea: z.string().min(1),
  actualOutcome: z.string().optional(),
  pnl: z.number().optional(),
  emotionTag: z.enum(["Calm", "FOMO", "Fear", "Greed", "Revenge", "Disciplined", "Uncertain"]).optional(),
  mistakeTag: z.enum(["Early Entry", "Late Entry", "Bad SL", "Overtraded", "Revenge Trade", "Ignored Signal", "Bad Risk:Reward", "None"]).optional(),
  lessonLearned: z.string().optional(),
  screenshotUrl: z.string().optional(),
});

const UpdateJournalBody = CreateJournalBody.partial();
const JournalIdParam = z.object({ id: z.coerce.number().int().positive() });

router.get("/journal", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const rows = await db.select().from(tradeJournalTable)
    .where(eq(tradeJournalTable.userId, userId))
    .orderBy(desc(tradeJournalTable.createdAt))
    .limit(100);
  res.json(rows.map((r) => ({ ...r, createdAt: r.createdAt?.toISOString() ?? new Date().toISOString() })));
});

router.post("/journal", requireUser, async (req, res) => {
  const parsed = CreateJournalBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid journal entry", details: parsed.error.issues }); return; }
  const inserted = await db.insert(tradeJournalTable).values({ ...parsed.data, userId: req.authUser!.id }).returning();
  res.status(201).json({ ...inserted[0], createdAt: inserted[0].createdAt?.toISOString() ?? new Date().toISOString() });
});

router.patch("/journal/:id", requireUser, async (req, res) => {
  const idParsed = JournalIdParam.safeParse(req.params);
  if (!idParsed.success) { res.status(400).json({ error: "Invalid journal id" }); return; }
  const bodyParsed = UpdateJournalBody.safeParse(req.body);
  if (!bodyParsed.success) { res.status(400).json({ error: "Invalid update data" }); return; }
  const updated = await db.update(tradeJournalTable).set(bodyParsed.data)
    .where(and(eq(tradeJournalTable.id, idParsed.data.id), eq(tradeJournalTable.userId, req.authUser!.id)))
    .returning();
  if (!updated[0]) { res.status(404).json({ error: "Journal entry not found" }); return; }
  res.json({ ...updated[0], createdAt: updated[0].createdAt?.toISOString() ?? new Date().toISOString() });
});

router.delete("/journal/:id", requireUser, async (req, res) => {
  const idParsed = JournalIdParam.safeParse(req.params);
  if (!idParsed.success) { res.status(400).json({ error: "Invalid journal id" }); return; }
  const r = await db.delete(tradeJournalTable)
    .where(and(eq(tradeJournalTable.id, idParsed.data.id), eq(tradeJournalTable.userId, req.authUser!.id)))
    .returning({ id: tradeJournalTable.id });
  res.json({ deleted: r.length });
});

export default router;
