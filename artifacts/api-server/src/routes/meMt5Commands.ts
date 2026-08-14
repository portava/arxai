// Phase 4D — User-facing safe MT5 command routes.
// Allowed actions are READ-ONLY/SAFE only. Live order paths are explicitly
// rejected with HTTP 403. Every route requires login and verifies the
// target mt5_connection belongs to req.authUser.id.
import { Router } from "express";
import { db, mt5CommandsTable, mt5ConnectionTable, tradingSessionsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";

const router = Router();

const SAFE_ACTIONS = new Set([
  "PING",
  "HEARTBEAT_TEST",
  "ACCOUNT_SNAPSHOT_REQUEST",
  "POSITIONS_SNAPSHOT_REQUEST",
  "PAPER_ORDER_TEST",
  // Task #432 — ask the EA to stream candle HISTORY (CopyRates backfill) for a
  // symbol+timeframe back to /api/mt5/sync-candle-history. Pure market-data
  // telemetry: read-only, never an order, never through the execution gate.
  "CANDLE_HISTORY_REQUEST",
]);
const FORBIDDEN_ACTIONS = new Set([
  "LIVE_BUY",
  "LIVE_SELL",
  "MODIFY_LIVE_ORDER",
  "CLOSE_LIVE_POSITION",
  "OPEN",
  "CLOSE",
  "MODIFY",
  "CLOSE_ALL",
  "ORDER_SEND",
]);

const CreateCommandBody = z.object({
  action: z.string().min(1).max(64),
  payload: z.record(z.string(), z.unknown()).nullable().optional(),
  tradingSessionId: z.number().int().nullable().optional(),
  expiresInSeconds: z.number().int().min(5).max(3600).nullable().optional(),
});

async function ownConnection(userId: number, id: number) {
  const rows = await db.select().from(mt5ConnectionTable)
    .where(and(eq(mt5ConnectionTable.id, id), eq(mt5ConnectionTable.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

function serialize(r: typeof mt5CommandsTable.$inferSelect) {
  return {
    id: r.id,
    mt5ConnectionId: r.mt5ConnectionId,
    tradingSessionId: r.tradingSessionId,
    action: r.action,
    payload: r.payload,
    status: r.status,
    safetyMode: r.safetyMode,
    detail: r.detail,
    errorMessage: r.errorMessage,
    resultPayload: r.resultPayload,
    requestedByUserId: r.requestedByUserId,
    createdAt: r.createdAt?.toISOString() ?? null,
    deliveredAt: r.deliveredAt?.toISOString() ?? null,
    claimedAt: r.claimedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    failedAt: r.failedAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
  };
}

async function createSafeCommand(opts: {
  userId: number;
  connectionId: number;
  action: string;
  payload?: unknown;
  tradingSessionId?: number | null;
  expiresInSeconds?: number | null;
}) {
  const expiresAt = opts.expiresInSeconds
    ? new Date(Date.now() + opts.expiresInSeconds * 1000)
    : new Date(Date.now() + 5 * 60_000); // default 5 min
  const inserted = await db.insert(mt5CommandsTable).values({
    userId: opts.userId,
    mt5ConnectionId: opts.connectionId,
    tradingSessionId: opts.tradingSessionId ?? null,
    requestedByUserId: opts.userId,
    action: opts.action,
    payload: (opts.payload ?? null) as never,
    status: "PENDING",
    safetyMode: "paper_only",
    detail: `Safe ${opts.action} (paper_only) queued by user ${opts.userId}`,
    expiresAt,
  }).returning();
  return inserted[0]!;
}

// POST /api/me/mt5-connections/:id/commands — generic safe command insert.
router.post("/me/mt5-connections/:id/commands", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const body = CreateCommandBody.parse(req.body ?? {});
    const action = body.action.toUpperCase();
    if (FORBIDDEN_ACTIONS.has(action)) {
      try {
        const { logRiskEvent } = await import("./meRiskGovernor.js");
        await logRiskEvent({
          userId, eventType: "live_execution_blocked", severity: "critical", decision: "block",
          reason: `Blocked live action "${action}" — live trading is locked.`,
          details: { action, mt5ConnectionId: id },
          mt5ConnectionId: id,
        });
      } catch (e) { req.log.warn({ err: String(e) }, "live_execution_blocked log failed"); }
      res.status(403).json({
        error: "FORBIDDEN_LIVE_ACTION",
        message: `Action "${action}" is blocked. Live trading is locked. Only safe paper/read-only commands are permitted: ${[...SAFE_ACTIONS].join(", ")}.`,
        liveLocked: true,
        allowOrderExecution: false,
      });
      return;
    }
    if (!SAFE_ACTIONS.has(action)) {
      res.status(400).json({
        error: "UNKNOWN_OR_UNSAFE_ACTION",
        message: `Action "${action}" is not on the safe-command allowlist.`,
        allowed: [...SAFE_ACTIONS],
      });
      return;
    }
    const conn = await ownConnection(userId, id);
    if (!conn) { res.status(404).json({ error: "Not found" }); return; }
    if (conn.tokenRevokedAt) { res.status(409).json({ error: "Connection token revoked." }); return; }
    // Verify tradingSessionId ownership (if provided). Reject cross-user link.
    if (body.tradingSessionId != null) {
      const sess = await db.select({ id: tradingSessionsTable.id }).from(tradingSessionsTable)
        .where(and(eq(tradingSessionsTable.id, body.tradingSessionId), eq(tradingSessionsTable.userId, userId)))
        .limit(1);
      if (!sess[0]) { res.status(404).json({ error: "Trading session not found" }); return; }
    }
    const cmd = await createSafeCommand({
      userId, connectionId: conn.id, action,
      payload: body.payload ?? null,
      tradingSessionId: body.tradingSessionId ?? null,
      expiresInSeconds: body.expiresInSeconds ?? null,
    });
    res.status(201).json(serialize(cmd));
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /me/mt5-connections/:id/commands failed");
    res.status(500).json({ error: "Failed to queue command" });
  }
});

// POST /api/me/mt5-connections/:id/test-command — convenience PING.
router.post("/me/mt5-connections/:id/test-command", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const conn = await ownConnection(userId, id);
  if (!conn) { res.status(404).json({ error: "Not found" }); return; }
  if (conn.tokenRevokedAt) { res.status(409).json({ error: "Connection token revoked." }); return; }
  const cmd = await createSafeCommand({ userId, connectionId: conn.id, action: "PING" });
  res.status(201).json(serialize(cmd));
});

// GET /api/me/mt5-connections/:id/commands — list commands for one connection.
router.get("/me/mt5-connections/:id/commands", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const conn = await ownConnection(userId, id);
  if (!conn) { res.status(404).json({ error: "Not found" }); return; }
  const rows = await db.select().from(mt5CommandsTable)
    .where(and(eq(mt5CommandsTable.userId, userId), eq(mt5CommandsTable.mt5ConnectionId, id)))
    .orderBy(desc(mt5CommandsTable.createdAt))
    .limit(100);
  res.json({ commands: rows.map(serialize) });
});

// GET /api/me/mt5-commands — all commands across the user's connections.
router.get("/me/mt5-commands", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const rows = await db.select().from(mt5CommandsTable)
    .where(eq(mt5CommandsTable.userId, userId))
    .orderBy(desc(mt5CommandsTable.createdAt))
    .limit(200);
  res.json({ commands: rows.map(serialize) });
});

// POST /api/me/mt5-commands/:id/cancel — cancel a still-pending command.
router.post("/me/mt5-commands/:id/cancel", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const now = new Date();
  // Only cancel commands the EA hasn't already taken.
  const updated = await db.update(mt5CommandsTable).set({
    status: "cancelled",
    detail: "Cancelled by user",
    completedAt: now,
    updatedAt: now,
  }).where(and(
    eq(mt5CommandsTable.id, id),
    eq(mt5CommandsTable.userId, userId),
    eq(mt5CommandsTable.status, "PENDING"),
  )).returning();
  if (!updated[0]) { res.status(404).json({ error: "Not found or already delivered" }); return; }
  res.json(serialize(updated[0]));
});

export default router;
