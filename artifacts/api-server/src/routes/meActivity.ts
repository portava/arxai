// Phase 10D — Per-user activity timeline.
// SAFETY: requireUser; scope by req.authUser.id; never logs secrets.
import { Router } from "express";
import { db, userActivityTimelineTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";

const router = Router();
const SAFETY_ENVELOPE = { safetyMode: "paper_only" as const, liveLocked: true as const, readOnlyMode: true as const, allowOrderExecution: false as const };

router.get("/me/activity", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const source = typeof req.query.source === "string" ? req.query.source : null;
  const where = source
    ? and(eq(userActivityTimelineTable.userId, userId), eq(userActivityTimelineTable.source, source))
    : eq(userActivityTimelineTable.userId, userId);
  const rows = await db.select().from(userActivityTimelineTable).where(where).orderBy(desc(userActivityTimelineTable.createdAt)).limit(200);
  res.json({ events: rows, isEmpty: rows.length === 0, ...SAFETY_ENVELOPE });
});

router.get("/me/activity/recent", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const rows = await db.select().from(userActivityTimelineTable)
    .where(eq(userActivityTimelineTable.userId, userId)).orderBy(desc(userActivityTimelineTable.createdAt)).limit(20);
  res.json({ events: rows, isEmpty: rows.length === 0, ...SAFETY_ENVELOPE });
});

router.get("/me/activity/:id", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const row = await db.select().from(userActivityTimelineTable)
    .where(and(eq(userActivityTimelineTable.id, id), eq(userActivityTimelineTable.userId, userId))).limit(1);
  if (!row[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...row[0], ...SAFETY_ENVELOPE });
});

export default router;
