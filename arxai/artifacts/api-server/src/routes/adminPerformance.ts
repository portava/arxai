// Admin Performance Dashboard.
//
// GET /api/admin/performance — read-only operator view of:
//
//   - live command queue depth by status (LIVE_CONFIRMATION_REQUIRED,
//     LIVE_APPROVED, SENT_TO_MT5_LIVE, FILLED_LIVE, LIVE_BLOCKED)
//   - demo command queue depth by status
//   - dispatch rate (commands per minute, last 1h)
//   - average fill time (sentToMt5At -> filledAt)
//   - rejected / failed counts
//   - bridge heartbeats with age
//   - active users (distinct user_id touching commands in last 1h)
//   - active master exposure reservations
//
// Every handler requireAdmin. The endpoint MUST NOT return raw bridge
// tokens, API key hashes, or session secrets — only IDs, account
// numbers (operator visibility), and aggregate metrics.
import express, { type IRouter, Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { readRoleFromRequest } from "../lib/security/middleware.js";
import { describeCacheRuntime } from "../lib/cache/cacheAdapter.js";
import {
  readRecentPerf,
  recordPerf,
  summariseByAction,
} from "../lib/perf/perfRecorder.js";

const router: IRouter = Router();
router.use(express.json());

function requireAdmin(req: Request, res: Response): boolean {
  const role = readRoleFromRequest(req);
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" });
    return false;
  }
  return true;
}

router.get("/admin/performance", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  // Use ONE pool client for all reads so the snapshot is consistent.
  const c = await pool.connect();
  try {
    const live = await c.query<{ status: string; n: string }>(
      `SELECT status, COUNT(*)::text AS n
         FROM arx_live_commands
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY status`,
    );
    const demo = await c.query<{ status: string; n: string }>(
      `SELECT status, COUNT(*)::text AS n
         FROM mt5_demo_commands
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY status`,
    );
    const dispatchRate = await c.query<{ commands_last_hour: string }>(
      `SELECT COUNT(*)::text AS commands_last_hour
         FROM arx_live_commands
        WHERE sent_to_mt5_at > NOW() - INTERVAL '1 hour'`,
    );
    const avgFill = await c.query<{ avg_seconds: string | null }>(
      `SELECT AVG(EXTRACT(EPOCH FROM (filled_at - sent_to_mt5_at)))::text AS avg_seconds
         FROM arx_live_commands
        WHERE filled_at IS NOT NULL
          AND sent_to_mt5_at IS NOT NULL
          AND filled_at > NOW() - INTERVAL '24 hours'`,
    );
    const bridges = await c.query<{
      id: number; user_id: number; account_number: string | null;
      mode: string; last_heartbeat: Date | null;
    }>(
      `SELECT id, user_id, account_number, mode, last_heartbeat
         FROM mt5_connection
        WHERE token_revoked_at IS NULL
        ORDER BY last_heartbeat DESC NULLS LAST
        LIMIT 50`,
    );
    const activeUsers = await c.query<{ n: string }>(
      `SELECT COUNT(DISTINCT user_id)::text AS n
         FROM arx_live_commands
        WHERE created_at > NOW() - INTERVAL '1 hour'`,
    );
    const reservations = await c.query<{ status: string; n: string; total_lots: string }>(
      `SELECT status, COUNT(*)::text AS n, COALESCE(SUM(lot_size), 0)::text AS total_lots
         FROM arx_dispatch_exposure_reservations
        GROUP BY status`,
    );

    const now = Date.now();
    const bridgeRows = bridges.rows.map((b) => ({
      id: b.id, userId: b.user_id, mode: b.mode,
      accountNumberLast4: b.account_number ? b.account_number.slice(-4) : null,
      heartbeatAgeSec: b.last_heartbeat
        ? Math.max(0, Math.floor((now - new Date(b.last_heartbeat).getTime()) / 1000))
        : null,
    }));

    return res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      cacheRuntime: describeCacheRuntime(),
      live: {
        byStatus: Object.fromEntries(live.rows.map((r) => [r.status, Number(r.n)])),
        dispatchRatePerHour: Number(dispatchRate.rows[0]?.commands_last_hour ?? 0),
        avgFillSeconds: avgFill.rows[0]?.avg_seconds != null ? Number(avgFill.rows[0].avg_seconds) : null,
      },
      demo: {
        byStatus: Object.fromEntries(demo.rows.map((r) => [r.status, Number(r.n)])),
      },
      bridges: bridgeRows,
      activeUsersLastHour: Number(activeUsers.rows[0]?.n ?? 0),
      exposureReservations: Object.fromEntries(
        reservations.rows.map((r) => [r.status, { n: Number(r.n), totalLots: Number(r.total_lots) }]),
      ),
    });
  } finally {
    c.release();
  }
});

// Lightweight read of just the cache runtime — used by the admin
// diagnostics page so it can show cache mode + warnings without paying for
// the heavy queue/exposure queries.
router.get("/admin/performance/cache-mode", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  return res.json({ ok: true, ...describeCacheRuntime() });
});

// PART A — perf instrumentation readout.
//
// Recent server + client perf rows from the in-memory ring buffer.
// Admin-only. Normal users never see this surface.
//
// Query params:
//   limit    — number of rows to return (default 200, max 1024)
//   slowOnly — when "1"/"true", only return rows that tripped the slow
//              threshold for their action class.
router.get("/admin/performance/recent-actions", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Number.parseInt(String(req.query["limit"] ?? "200"), 10);
  const slowOnly = String(req.query["slowOnly"] ?? "").match(/^(1|true|yes)$/i) != null;
  return res.json({
    ok: true,
    rows: readRecentPerf({ limit: Number.isFinite(limit) ? limit : 200, slowOnly }),
  });
});

// p50/p95/max + slow-count grouped by action. Drives the admin "top
// offenders" view without needing to ship the full ring buffer.
router.get("/admin/performance/action-summary", (req, res) => {
  if (!requireAdmin(req, res)) return;
  return res.json({ ok: true, actions: summariseByAction() });
});

// Ingest endpoint for browser-side perf rows produced by
// `artifacts/trading-dashboard/src/lib/perf.ts`. Admin-only on purpose
// — non-admin sessions get 403 and the client swallows the failure so
// normal users never trigger background telemetry traffic.
//
// Each request is expected to carry { rows: ClientPerfRow[] }. We hard
// cap at 100 rows per batch to bound the work and never trust the
// caller's timing fields beyond clamping them into the recorder.
const MAX_BATCH = 100;
interface ClientPerfRowIn {
  action: unknown;
  page?: unknown;
  totalMs: unknown;
  uiFeedbackMs?: unknown;
  frontendRenderMs?: unknown;
  apiMs?: unknown;
  feedMs?: unknown;
  dbMs?: unknown;
  cacheHit?: unknown;
  bottleneck?: unknown;
  viewport?: unknown;
}
function numOrNull(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}
function boolOrNull(x: unknown): boolean | null {
  return typeof x === "boolean" ? x : null;
}
function strOrNull(x: unknown): string | null {
  return typeof x === "string" && x.length > 0 && x.length < 64 ? x : null;
}
function viewportOrNull(x: unknown): "mobile" | "desktop" | null {
  return x === "mobile" || x === "desktop" ? x : null;
}
router.post("/admin/performance/client-action", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = req.body as { rows?: unknown };
  const raw = Array.isArray(body?.rows) ? body!.rows!.slice(0, MAX_BATCH) : [];
  let accepted = 0;
  const auth = (req as unknown as { authUser?: { id?: unknown } }).authUser;
  const userId = typeof auth?.id === "number" ? auth.id : null;
  for (const r of raw as ClientPerfRowIn[]) {
    const action = strOrNull(r?.action);
    const totalMs = numOrNull(r?.totalMs);
    if (action == null || totalMs == null) continue;
    recordPerf({
      source: "client",
      action,
      page: strOrNull(r?.page) ?? null,
      userId,
      totalMs,
      uiFeedbackMs: numOrNull(r?.uiFeedbackMs),
      frontendRenderMs: numOrNull(r?.frontendRenderMs),
      apiMs: numOrNull(r?.apiMs),
      feedMs: numOrNull(r?.feedMs),
      dbMs: numOrNull(r?.dbMs),
      cacheHit: boolOrNull(r?.cacheHit),
      bottleneck: strOrNull(r?.bottleneck),
      viewport: viewportOrNull(r?.viewport),
    });
    accepted += 1;
  }
  return res.json({ ok: true, accepted });
});

export default router;
