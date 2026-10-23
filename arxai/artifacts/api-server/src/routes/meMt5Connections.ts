// Phase 3B/3C — Per-user MT5 connection records.
// SECURITY:
//   - Bridge tokens are generated per connection (32 random bytes, base64url).
//   - Raw token shown ONCE on create / regenerate. Never logged. Never returned again.
//   - Only the SHA-256 hash of the token is stored in apiKeyHash.
//   - All routes require auth; queries scoped by req.authUser.id.
//   - Client-supplied userId is ignored for ownership.
import { Router } from "express";
import { db, mt5ConnectionTable } from "@workspace/db";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod/v4";
import { randomBytes, createHash } from "crypto";
import { requireUser } from "../lib/auth/middleware.js";

const router = Router();

const STALE_MS = 60_000;

export function hashBridgeToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function generateToken(): { raw: string; hash: string; last4: string } {
  // 32 random bytes → base64url (43 chars, ~256 bits of entropy).
  const raw = randomBytes(32).toString("base64url");
  const hash = hashBridgeToken(raw);
  const last4 = raw.slice(-4);
  return { raw, hash, last4 };
}

// Broker account logins never leave the API raw — mask to the last 4 digits
// (same policy as brokerReadOnly/service.ts maskAccountId; short values are
// fully masked so nothing is revealed).
function maskAccountNumber(acct: string | null): string | null {
  if (!acct) return acct;
  if (acct.length <= 4) return "*".repeat(acct.length);
  return `****${acct.slice(-4)}`;
}

function deriveStatus(row: typeof mt5ConnectionTable.$inferSelect): string {
  if (row.tokenRevokedAt) return "revoked";
  if (!row.lastHeartbeat) return "waiting";
  const age = Date.now() - new Date(row.lastHeartbeat).getTime();
  if (age < 15_000) return "connected";
  if (age < STALE_MS) return "stale";
  return "disconnected";
}

function serialize(row: typeof mt5ConnectionTable.$inferSelect, opts: { rawToken?: string } = {}) {
  const status = deriveStatus(row);
  const heartbeatAgeSeconds = row.lastHeartbeat
    ? Math.floor((Date.now() - new Date(row.lastHeartbeat).getTime()) / 1000)
    : null;
  // Compute margin level on read so we don't need a schema migration.
  // MT5 convention: marginLevel% = (equity / margin) * 100. When margin
  // is zero (no open positions) the broker reports 0; we surface null so
  // the UI can render "—" instead of a misleading 0%.
  const equityN = Number(row.accountEquity ?? 0);
  const marginN = Number(row.margin ?? 0);
  const marginLevelPercent = marginN > 0 ? (equityN / marginN) * 100 : null;
  // Account snapshot freshness — heartbeat is the canonical liveness
  // signal (EA POSTs both heartbeat and sync-account every 5s). 15s
  // matches the Phase B `heartbeat age ≤ 15s` gate.
  const accountSnapshotFresh = heartbeatAgeSeconds != null && heartbeatAgeSeconds <= 15;
  return {
    id: row.id,
    connectionName: row.connectionName,
    status,
    broker: row.brokerName,
    server: row.serverName,
    account: maskAccountNumber(row.accountNumber),
    accountCurrency: row.accountCurrency,
    balance: row.accountBalance,
    equity: row.accountEquity,
    margin: row.margin,
    freeMargin: row.freeMargin,
    marginLevelPercent,
    leverage: row.leverage,
    accountType: row.accountType,
    accountSnapshotFresh,
    lastHeartbeatAt: row.lastHeartbeat?.toISOString() ?? null,
    heartbeatAgeSeconds,
    tokenLast4: row.tokenLast4,
    tokenCreatedAt: row.tokenCreatedAt?.toISOString() ?? null,
    tokenRevokedAt: row.tokenRevokedAt?.toISOString() ?? null,
    readOnlyMode: row.readOnlyMode,
    allowOrderExecution: row.allowOrderExecution,
    liveLocked: row.liveLocked,
    mode: row.mode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(opts.rawToken ? { rawToken: opts.rawToken, rawTokenWarning: "Shown once. Save it now — it cannot be retrieved later." } : {}),
  };
}

const CreateBody = z.object({
  connectionName: z.string().min(1).max(120),
});
// Safety flag updates are restricted: read_only/allow_order/live_locked locked
// per Phase 3E. Non-safety descriptive fields are user-editable.
const UpdateBody = z.object({
  connectionName: z.string().min(1).max(120).optional(),
  brokerName: z.string().max(120).nullable().optional(),
  serverName: z.string().max(120).nullable().optional(),
});

router.get("/me/mt5-connections", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const rows = await db.select().from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.userId, userId))
    .orderBy(desc(mt5ConnectionTable.createdAt));
  res.json({ connections: rows.map((r) => serialize(r)) });
});

router.post("/me/mt5-connections", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const body = CreateBody.parse(req.body ?? {});
    const tok = generateToken();
    const inserted = await db.insert(mt5ConnectionTable).values({
      userId,
      connectionName: body.connectionName,
      apiKeyHash: tok.hash,
      tokenLast4: tok.last4,
      tokenCreatedAt: new Date(),
      status: "waiting",
      // Phase 3E safety locks
      readOnlyMode: true,
      allowOrderExecution: false,
      liveLocked: true,
      mode: "MOCK",
    }).returning();
    // Phase 10F — notify + activity (no token in payload).
    try {
      const { fireNotify } = await import("../lib/notificationService.js");
      fireNotify(userId,
        { notificationType: "mt5_connected", severity: "info", title: "MT5 connection created", message: `Connection "${body.connectionName}" is ready for the bridge handshake.`, source: "mt5", entityType: "mt5_connection", entityId: inserted[0]!.id, actionLabel: "Open MT5 settings", actionTarget: "/bot-control" },
        { eventType: "mt5_connection_created", title: "MT5 connection created", description: body.connectionName, source: "mt5", entityType: "mt5_connection", entityId: inserted[0]!.id }
      );
    } catch { /* fire-and-forget */ }
    res.status(201).json(serialize(inserted[0]!, { rawToken: tok.raw }));
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /me/mt5-connections failed");
    res.status(500).json({ error: "Failed to create connection" });
  }
});

router.get("/me/mt5-connections/:id", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const rows = await db.select().from(mt5ConnectionTable)
    .where(and(eq(mt5ConnectionTable.id, id), eq(mt5ConnectionTable.userId, userId)))
    .limit(1);
  if (!rows[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json(serialize(rows[0]));
});

router.get("/me/mt5-connections/:id/status", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const rows = await db.select().from(mt5ConnectionTable)
    .where(and(eq(mt5ConnectionTable.id, id), eq(mt5ConnectionTable.userId, userId)))
    .limit(1);
  const r = rows[0];
  if (!r) { res.status(404).json({ error: "Not found" }); return; }
  res.json({
    id: r.id,
    connectionName: r.connectionName,
    status: deriveStatus(r),
    lastHeartbeatAt: r.lastHeartbeat?.toISOString() ?? null,
    heartbeatAgeSeconds: r.lastHeartbeat ? Math.floor((Date.now() - new Date(r.lastHeartbeat).getTime()) / 1000) : null,
    account: maskAccountNumber(r.accountNumber),
    broker: r.brokerName,
    balance: r.accountBalance,
    equity: r.accountEquity,
    readOnlyMode: r.readOnlyMode,
    allowOrderExecution: r.allowOrderExecution,
    liveLocked: r.liveLocked,
  });
});

router.patch("/me/mt5-connections/:id", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const body = UpdateBody.parse(req.body ?? {});
    // SAFETY: explicit whitelist — never allow safety flags
    // (readOnlyMode/allowOrderExecution/liveLocked) or token fields to be
    // mutated through this route, even if UpdateBody is later expanded.
    const set: { connectionName?: string; brokerName?: string | null; serverName?: string | null; updatedAt: Date } = { updatedAt: new Date() };
    if (body.connectionName !== undefined) set.connectionName = body.connectionName;
    if (body.brokerName !== undefined) set.brokerName = body.brokerName;
    if (body.serverName !== undefined) set.serverName = body.serverName;
    const updated = await db.update(mt5ConnectionTable).set(set)
      .where(and(eq(mt5ConnectionTable.id, id), eq(mt5ConnectionTable.userId, userId)))
      .returning();
    if (!updated[0]) { res.status(404).json({ error: "Not found" }); return; }
    res.json(serialize(updated[0]));
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "PATCH /me/mt5-connections/:id failed");
    res.status(500).json({ error: "Failed to update connection" });
  }
});

router.post("/me/mt5-connections/:id/regenerate-token", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const own = await db.select().from(mt5ConnectionTable)
    .where(and(eq(mt5ConnectionTable.id, id), eq(mt5ConnectionTable.userId, userId)))
    .limit(1);
  if (!own[0]) { res.status(404).json({ error: "Not found" }); return; }
  const tok = generateToken();
  const updated = await db.update(mt5ConnectionTable).set({
    apiKeyHash: tok.hash,
    tokenLast4: tok.last4,
    tokenCreatedAt: new Date(),
    tokenRevokedAt: null,
    status: "waiting",
    lastHeartbeat: null,
    updatedAt: new Date(),
  }).where(and(eq(mt5ConnectionTable.id, id), eq(mt5ConnectionTable.userId, userId))).returning();
  res.json(serialize(updated[0]!, { rawToken: tok.raw }));
});

router.post("/me/mt5-connections/:id/revoke", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const updated = await db.update(mt5ConnectionTable).set({
    status: "revoked",
    tokenRevokedAt: new Date(),
    apiKeyHash: null,
    updatedAt: new Date(),
  }).where(and(eq(mt5ConnectionTable.id, id), eq(mt5ConnectionTable.userId, userId))).returning();
  if (!updated[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json(serialize(updated[0]));
});

router.delete("/me/mt5-connections/:id", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  // Soft-delete by revoking; preserves audit trail.
  const updated = await db.update(mt5ConnectionTable).set({
    status: "revoked",
    tokenRevokedAt: new Date(),
    apiKeyHash: null,
    updatedAt: new Date(),
  }).where(and(eq(mt5ConnectionTable.id, id), eq(mt5ConnectionTable.userId, userId))).returning();
  if (!updated[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ok: true, softDeleted: true, id: updated[0].id });
});

// Phase 3C — Personal MT5 status: aggregates the user's most-recent active
// connection. Distinct from /api/mt5/status (system bridge view). Returns
// `waiting` when the user has no connections.
router.get("/me/mt5-status", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const rows = await db.select().from(mt5ConnectionTable)
    .where(and(
      eq(mt5ConnectionTable.userId, userId),
      isNotNull(mt5ConnectionTable.apiKeyHash),
      isNull(mt5ConnectionTable.tokenRevokedAt),
    ))
    .orderBy(desc(mt5ConnectionTable.lastHeartbeat), desc(mt5ConnectionTable.createdAt))
    .limit(1);
  const r = rows[0];
  if (!r) {
    res.json({
      hasConnection: false,
      status: "waiting",
      message: "No MT5 connection yet. Create one to get a personal bridge token.",
      liveLocked: true,
      readOnlyMode: true,
      allowOrderExecution: false,
    });
    return;
  }
  res.json({
    hasConnection: true,
    connectionId: r.id,
    connectionName: r.connectionName,
    status: deriveStatus(r),
    account: maskAccountNumber(r.accountNumber),
    broker: r.brokerName,
    server: r.serverName,
    balance: r.accountBalance,
    equity: r.accountEquity,
    accountCurrency: r.accountCurrency,
    lastHeartbeatAt: r.lastHeartbeat?.toISOString() ?? null,
    heartbeatAgeSeconds: r.lastHeartbeat ? Math.floor((Date.now() - new Date(r.lastHeartbeat).getTime()) / 1000) : null,
    liveLocked: r.liveLocked,
    readOnlyMode: r.readOnlyMode,
    allowOrderExecution: r.allowOrderExecution,
    tokenLast4: r.tokenLast4,
  });
});

export default router;
