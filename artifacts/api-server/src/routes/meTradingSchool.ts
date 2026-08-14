// Trading School progress routes (per-user learning state).
//
// Routes:
//   GET    /api/me/trading-school/progress  — read the caller's saved progress
//   PUT    /api/me/trading-school/progress  — write-through upsert of the full blob
//   DELETE /api/me/trading-school/progress  — remove the caller's saved row
//
// SAFETY / SCOPE:
//   - requireUser on every route. Strictly per-user: reads and writes are
//     scoped by req.authUser.id and the table has a unique user_id, so no row
//     from user A is ever returned to or overwritten by user B.
//   - Education progress only. Touches no trading, execution, balance, or
//     safety surface — never blocks anything.

import { Router } from "express";
import { db } from "@workspace/db";
import { tradingSchoolProgressTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  GetMeTradingSchoolProgressResponse,
  PutMeTradingSchoolProgressBody,
  DeleteMeTradingSchoolProgressResponse,
} from "@workspace/api-zod";
import { requireUser } from "../lib/auth/middleware.js";

const router = Router();

type TradingSchoolProgress = z.infer<
  typeof GetMeTradingSchoolProgressResponse
>["progress"];

const EMPTY_PROGRESS: TradingSchoolProgress = {
  startedAt: null,
  completedAt: null,
  lastLessonId: null,
  completedLessonIds: [],
  passedLessonIds: [],
  attempts: [],
  labsAttempted: [],
  earnedBadgeIds: [],
};

function rowToProgress(row: typeof tradingSchoolProgressTable.$inferSelect): TradingSchoolProgress {
  return {
    startedAt:          row.startedAt ?? null,
    completedAt:        row.completedAt ?? null,
    lastLessonId:       row.lastLessonId ?? null,
    completedLessonIds: row.completedLessonIds ?? [],
    passedLessonIds:    row.passedLessonIds ?? [],
    attempts:           row.attempts ?? [],
    labsAttempted:      row.labsAttempted ?? [],
    earnedBadgeIds:     row.earnedBadgeIds ?? [],
  };
}

// ── GET /api/me/trading-school/progress ───────────────────────────────────────
router.get("/me/trading-school/progress", requireUser, async (req, res) => {
  const userId = req.authUser!.id;

  const [row] = await db
    .select()
    .from(tradingSchoolProgressTable)
    .where(eq(tradingSchoolProgressTable.userId, userId))
    .limit(1);

  const progress = row ? rowToProgress(row) : EMPTY_PROGRESS;

  const data = GetMeTradingSchoolProgressResponse.parse({ ok: true, progress });
  return res.json(data);
});

// ── PUT /api/me/trading-school/progress ───────────────────────────────────────
router.put("/me/trading-school/progress", requireUser, async (req, res) => {
  const userId = req.authUser!.id;

  const parsed = PutMeTradingSchoolProgressBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "BAD_BODY", details: parsed.error.issues });
  }

  const p = parsed.data;

  const values = {
    userId,
    startedAt:          p.startedAt ?? null,
    completedAt:        p.completedAt ?? null,
    lastLessonId:       p.lastLessonId ?? null,
    completedLessonIds: p.completedLessonIds,
    passedLessonIds:    p.passedLessonIds,
    attempts:           p.attempts,
    labsAttempted:      p.labsAttempted,
    earnedBadgeIds:     p.earnedBadgeIds,
    updatedAt:          new Date(),
  };

  const [row] = await db
    .insert(tradingSchoolProgressTable)
    .values(values)
    .onConflictDoUpdate({
      target: tradingSchoolProgressTable.userId,
      set: {
        startedAt:          values.startedAt,
        completedAt:        values.completedAt,
        lastLessonId:       values.lastLessonId,
        completedLessonIds: values.completedLessonIds,
        passedLessonIds:    values.passedLessonIds,
        attempts:           values.attempts,
        labsAttempted:      values.labsAttempted,
        earnedBadgeIds:     values.earnedBadgeIds,
        updatedAt:          values.updatedAt,
      },
    })
    .returning();

  const data = GetMeTradingSchoolProgressResponse.parse({
    ok: true,
    progress: row ? rowToProgress(row) : rowToProgress({ ...values } as typeof tradingSchoolProgressTable.$inferSelect),
  });
  return res.json(data);
});

// ── DELETE /api/me/trading-school/progress ────────────────────────────────────
// Remove the caller's saved row outright. Idempotent — succeeds whether or not a
// row existed. Strictly per-user (scoped by req.authUser.id). Education data
// only; touches no trading, execution, balance, or safety surface.
router.delete("/me/trading-school/progress", requireUser, async (req, res) => {
  const userId = req.authUser!.id;

  const deletedRows = await db
    .delete(tradingSchoolProgressTable)
    .where(eq(tradingSchoolProgressTable.userId, userId))
    .returning();

  const data = DeleteMeTradingSchoolProgressResponse.parse({
    ok: true,
    deleted: deletedRows.length > 0,
  });
  return res.json(data);
});

export default router;
