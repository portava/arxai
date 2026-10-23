// Phase 3A — Per-user trading sessions. All endpoints require auth and are
// scoped by req.authUser.id. Client-supplied userId is ignored for ownership.
import { Router } from "express";
import { db, tradingSessionsTable, mt5ConnectionTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import { detectLegacyPaperModeRequest } from "../lib/safety/rejectLegacyPaperMode.js";

const router = Router();

// Phase 5: "paper" removed from production mode union. Legacy requests
// sending mode=paper are intercepted before Zod runs (see route handlers
// below) and rejected with the canonical message.
const ModeEnum = z.enum(["demo", "live_locked"]);
const StatusEnum = z.enum(["active", "paused", "closed"]);

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  mode: ModeEnum.optional(),
  startingBalance: z.number().nullable().optional(),
  linkedMt5ConnectionId: z.number().int().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
const UpdateBody = z.object({
  title: z.string().min(1).max(200).optional(),
  mode: ModeEnum.optional(),
  status: StatusEnum.optional(),
  startingBalance: z.number().nullable().optional(),
  endingBalance: z.number().nullable().optional(),
  pnl: z.number().nullable().optional(),
  winCount: z.number().int().min(0).optional(),
  lossCount: z.number().int().min(0).optional(),
  linkedMt5ConnectionId: z.number().int().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

function serialize(row: typeof tradingSessionsTable.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    status: row.status,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    linkedMt5ConnectionId: row.linkedMt5ConnectionId,
    startingBalance: row.startingBalance,
    endingBalance: row.endingBalance,
    pnl: row.pnl,
    winCount: row.winCount,
    lossCount: row.lossCount,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Verify the connection belongs to this user, or return null.
async function ensureOwnedConnection(userId: number, connId: number | null | undefined): Promise<number | null> {
  if (connId == null) return null;
  const rows = await db.select().from(mt5ConnectionTable)
    .where(and(eq(mt5ConnectionTable.id, connId), eq(mt5ConnectionTable.userId, userId)))
    .limit(1);
  return rows[0] ? connId : null;
}

router.get("/me/trading-sessions", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const rows = await db.select().from(tradingSessionsTable)
    .where(eq(tradingSessionsTable.userId, userId))
    .orderBy(desc(tradingSessionsTable.createdAt));
  res.json({ sessions: rows.map(serialize) });
});

router.post("/me/trading-sessions", requireUser, async (req, res): Promise<void> => {
  try {
    const legacy = detectLegacyPaperModeRequest(req.body);
    if (legacy) { res.status(400).json({ ok: false, ...legacy }); return; }
    const body = CreateBody.parse(req.body ?? {});
    const userId = req.authUser!.id;
    const linked = await ensureOwnedConnection(userId, body.linkedMt5ConnectionId ?? null);
    const inserted = await db.insert(tradingSessionsTable).values({
      userId,
      title: body.title,
      // Phase 5: default flipped from "paper" → "demo". The two
      // production modes are DEMO and LIVE; "paper" is no longer
      // accepted on either insert or update.
      mode: body.mode ?? "demo",
      status: "active",
      startingBalance: body.startingBalance ?? null,
      linkedMt5ConnectionId: linked,
      notes: body.notes ?? null,
    }).returning();
    res.status(201).json(serialize(inserted[0]!));
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /me/trading-sessions failed");
    res.status(500).json({ error: "Failed to create session" });
  }
});

router.get("/me/trading-sessions/:id", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const rows = await db.select().from(tradingSessionsTable)
    .where(and(eq(tradingSessionsTable.id, id), eq(tradingSessionsTable.userId, userId)))
    .limit(1);
  if (!rows[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json(serialize(rows[0]));
});

router.patch("/me/trading-sessions/:id", requireUser, async (req, res): Promise<void> => {
  try {
    const legacy = detectLegacyPaperModeRequest(req.body);
    if (legacy) { res.status(400).json({ ok: false, ...legacy }); return; }
    const userId = req.authUser!.id;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const body = UpdateBody.parse(req.body ?? {});
    const linked = body.linkedMt5ConnectionId !== undefined
      ? await ensureOwnedConnection(userId, body.linkedMt5ConnectionId)
      : undefined;
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (body.title !== undefined) set.title = body.title;
    if (body.mode !== undefined) set.mode = body.mode;
    if (body.status !== undefined) set.status = body.status;
    if (body.startingBalance !== undefined) set.startingBalance = body.startingBalance;
    if (body.endingBalance !== undefined) set.endingBalance = body.endingBalance;
    if (body.pnl !== undefined) set.pnl = body.pnl;
    if (body.winCount !== undefined) set.winCount = body.winCount;
    if (body.lossCount !== undefined) set.lossCount = body.lossCount;
    if (linked !== undefined) set.linkedMt5ConnectionId = linked;
    if (body.notes !== undefined) set.notes = body.notes;
    const updated = await db.update(tradingSessionsTable).set(set)
      .where(and(eq(tradingSessionsTable.id, id), eq(tradingSessionsTable.userId, userId)))
      .returning();
    if (!updated[0]) { res.status(404).json({ error: "Not found" }); return; }
    res.json(serialize(updated[0]));
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "PATCH /me/trading-sessions/:id failed");
    res.status(500).json({ error: "Failed to update session" });
  }
});

router.post("/me/trading-sessions/:id/close", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const body = z.object({
      endingBalance: z.number().nullable().optional(),
      pnl: z.number().nullable().optional(),
      winCount: z.number().int().min(0).optional(),
      lossCount: z.number().int().min(0).optional(),
      notes: z.string().max(2000).nullable().optional(),
    }).parse(req.body ?? {});
    const set: Record<string, unknown> = {
      status: "closed",
      endedAt: new Date(),
      updatedAt: new Date(),
    };
    if (body.endingBalance !== undefined) set.endingBalance = body.endingBalance;
    if (body.pnl !== undefined) set.pnl = body.pnl;
    if (body.winCount !== undefined) set.winCount = body.winCount;
    if (body.lossCount !== undefined) set.lossCount = body.lossCount;
    if (body.notes !== undefined) set.notes = body.notes;
    const updated = await db.update(tradingSessionsTable).set(set)
      .where(and(eq(tradingSessionsTable.id, id), eq(tradingSessionsTable.userId, userId)))
      .returning();
    if (!updated[0]) { res.status(404).json({ error: "Not found" }); return; }
    res.json(serialize(updated[0]));
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /me/trading-sessions/:id/close failed");
    res.status(500).json({ error: "Failed to close session" });
  }
});

export default router;
