// ── ARX Bridge v2 — EA ingest + admin trace routes (Task #371) ──────────────
//
// EA-facing ingest endpoint (per-user bridge token only) that accepts a single
// message or a small batch of broker-truth EVENTS and records them through the
// pure ingest service (validate → dedupe → sequence/gap → latency → trace).
//
// Plus ADMIN/OWNER-only observability endpoints that surface per-stream
// integrity counters and a recent-event trace.
//
// SAFETY:
// - Ingest NEVER executes or mutates a trade. It is broker-truth telemetry +
//   dedupe only; broker-impacting commands still flow through the existing
//   instant-trade router → live command pipeline → 16-gate Phase B dispatch,
//   transported via the EXISTING /api/mt5/commands seam the EA already polls.
// - Ingest auth is `bridgeAuthPerUserOnly`: per-user token only. The legacy
//   server-wide bridge token is rejected (handled inside the middleware).
// - Admin endpoints require an ADMIN/OWNER session; admin-previewing-as-user is
//   auto-downgraded upstream and lands in the 403 branch.
// - Per-user isolation: ingest attributes every row to the authenticated
//   connection's userId; admin trace can scope by userId.

import { Router, type Request, type Response } from "express";
import { db, bridgeV2EventsTable, bridgeV2StreamStateTable, mt5ConnectionTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { bridgeAuthPerUserOnly } from "./mt5.js";
import { ingestBridgeV2Message } from "../lib/bridgeV2/ingest.js";
import { loadBridgeV2ConfigForEa, listBridgeV2CommandsForEa } from "../lib/bridgeV2/egress.js";
import { buildBridgeV2AdminStatus } from "../lib/bridgeV2/status.js";

const router = Router();

type ConnReq = Request & {
  mt5Connection?: typeof mt5ConnectionTable.$inferSelect;
};

// ─── POST /api/bridge/v2/ingest ─────────────────────────────────────────────
// Body: a single message object OR { messages: [...] } (max 50). Each is run
// through the ingest service independently; the response reports per-message
// outcomes. A malformed/duplicate message NEVER fails the whole batch and NEVER
// reports a fabricated success.
router.post("/bridge/v2/ingest", bridgeAuthPerUserOnly, async (req: ConnReq, res: Response): Promise<void> => {
  const conn = req.mt5Connection;
  if (!conn || conn.userId == null) {
    res.status(401).json({ ok: false, error: "BRIDGE_NOT_ATTRIBUTED" });
    return;
  }
  const userId = conn.userId;
  const bridgeConnectionId = conn.id ?? null;
  const now = Date.now();

  const body = req.body as unknown;
  const messages: unknown[] = Array.isArray((body as { messages?: unknown })?.messages)
    ? ((body as { messages: unknown[] }).messages)
    : [body];

  if (messages.length === 0 || messages.length > 50) {
    res.status(400).json({ ok: false, error: "BATCH_SIZE_INVALID", detail: "1..50 messages per request" });
    return;
  }

  const results = [];
  for (const raw of messages) {
    try {
      const r = await ingestBridgeV2Message({
        userId,
        bridgeConnectionId,
        raw,
        serverReceivedAtEpochMs: now,
      });
      results.push(r);
    } catch (e) {
      req.log?.error({ event: "bridge_v2_ingest_error", userId, err: e instanceof Error ? e.message : String(e) }, "Bridge v2 ingest failed");
      results.push({ accepted: false, outcome: "ENVELOPE_INVALID" as const, detail: "INGEST_ERROR" });
    }
  }

  const acceptedCount = results.filter((r) => r.accepted).length;
  res.json({
    ok: true,
    received: messages.length,
    accepted: acceptedCount,
    results,
  });
});

// ─── GET /api/bridge/v2/config ──────────────────────────────────────────────
// EA pulls its versioned remote-config manifest. PURE READ. `executionAllowed`
// is served as the honest AND of the stored admin flag and the server master
// switch resolution (env AND db) — it can never advertise execution while the
// environment master switch is off, and it NEVER overrides the EA's local ARM
// inputs (ReadOnlyMode / AllowOrderExecution). No row = EA-safe defaults.
router.get("/bridge/v2/config", bridgeAuthPerUserOnly, async (req: ConnReq, res: Response): Promise<void> => {
  const conn = req.mt5Connection;
  if (!conn || conn.userId == null) {
    res.status(401).json({ ok: false, error: "BRIDGE_NOT_ATTRIBUTED" });
    return;
  }
  const manifest = await loadBridgeV2ConfigForEa(conn.userId, conn.id ?? null);
  // Flat shape the EA string-parses. executionAllowed is emitted as a string so
  // the EA can compare `executionAllowed == "true"`.
  res.json({
    ok: true,
    configVersion: manifest.configVersion,
    executionAllowed: manifest.executionAllowed ? "true" : "false",
    maxLiveLot: manifest.maxLiveLot,
    tunables: manifest.tunables,
    lastAckedVersion: manifest.lastAckedVersion,
  });
});

// ─── GET /api/bridge/v2/commands ────────────────────────────────────────────
// EA polls its whitelisted-command channel. PURE READ-PROJECTION of
// arx_live_commands rows that already passed all 16 Phase B gates (status
// SENT_TO_MT5_LIVE), scoped to this user + bridge connection. This endpoint
// ORIGINATES nothing and MUTATES nothing — it can never be a second execution
// path. Empty in steady state (production bridge is v1.50). State-flip on poll
// and the result-loop are deferred to the live-cycle task.
router.get("/bridge/v2/commands", bridgeAuthPerUserOnly, async (req: ConnReq, res: Response): Promise<void> => {
  const conn = req.mt5Connection;
  if (!conn || conn.userId == null) {
    res.status(401).json({ ok: false, error: "BRIDGE_NOT_ATTRIBUTED" });
    return;
  }
  const commands = await listBridgeV2CommandsForEa(conn.userId, conn.id ?? null);
  res.json({ ok: true, count: commands.length, commands });
});

// ─── Admin gating helper (mirrors adminEaHealth) ────────────────────────────
function requireAdmin(req: Request, res: Response): "ADMIN" | "OWNER" | null {
  const u = (req as Request & { authUser?: { id?: number; role?: string } }).authUser;
  const role = String(u?.role ?? "").toUpperCase();
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_OR_OWNER_REQUIRED" });
    return null;
  }
  return role as "ADMIN" | "OWNER";
}

// ─── GET /api/admin/bridge-v2/streams ───────────────────────────────────────
// Per-stream integrity counters (last sequence, gaps, duplicates, missed,
// resets) — the observability surface for transport health.
router.get("/admin/bridge-v2/streams", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const userIdRaw = req.query.userId;
  const userId = typeof userIdRaw === "string" && userIdRaw.length > 0 ? Number(userIdRaw) : null;

  const rows = await db
    .select()
    .from(bridgeV2StreamStateTable)
    .where(userId != null && Number.isFinite(userId) ? eq(bridgeV2StreamStateTable.userId, userId) : sql`true`)
    .orderBy(desc(bridgeV2StreamStateTable.updatedAt))
    .limit(500);

  res.json({ ok: true, count: rows.length, streams: rows });
});

// ─── GET /api/admin/bridge-v2/trace ─────────────────────────────────────────
// Recent ingest trace (validated + rejected + duplicate rows) for debugging the
// EA → server path. Payloads are broker-truth bodies (no tokens/secrets ever
// stored in these tables).
router.get("/admin/bridge-v2/trace", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const userIdRaw = req.query.userId;
  const userId = typeof userIdRaw === "string" && userIdRaw.length > 0 ? Number(userIdRaw) : null;
  const limitRaw = req.query.limit;
  const limit = Math.min(200, Math.max(1, typeof limitRaw === "string" ? Number(limitRaw) || 100 : 100));

  const rows = await db
    .select()
    .from(bridgeV2EventsTable)
    .where(userId != null && Number.isFinite(userId) ? eq(bridgeV2EventsTable.userId, userId) : sql`true`)
    .orderBy(desc(bridgeV2EventsTable.id))
    .limit(limit);

  // Summary counters across the returned window.
  const summary = rows.reduce(
    (acc, r) => {
      acc.total += 1;
      if (r.accepted) acc.accepted += 1;
      if (r.duplicateDropped) acc.duplicates += 1;
      if (r.sequenceVerdict === "GAP") acc.gaps += 1;
      if (!r.accepted && r.rejectReason && !r.duplicateDropped) acc.rejected += 1;
      return acc;
    },
    { total: 0, accepted: 0, duplicates: 0, gaps: 0, rejected: 0 },
  );

  res.json({ ok: true, summary, events: rows });
});

// ─── GET /api/admin/bridge-v2/status ────────────────────────────────────────
// Consolidated readiness DTO per bridge, derived over the v2 telemetry tables +
// the EA remote-config manifest + the whitelisted-command projection. This is
// the admin monitor's primary feed (the /streams + /trace endpoints remain for
// raw per-stream integrity + recent-event detail). READ ONLY. Empty in steady
// state (the production bridge is v1.50, not a v2 sensor).
router.get("/admin/bridge-v2/status", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const userIdRaw = req.query.userId;
  const userId = typeof userIdRaw === "string" && userIdRaw.length > 0 ? Number(userIdRaw) : null;
  const scoped = userId != null && Number.isFinite(userId) ? userId : null;
  const bridges = await buildBridgeV2AdminStatus(scoped);
  res.json({ ok: true, count: bridges.length, bridges });
});

export default router;
