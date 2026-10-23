// Phase 12C — Public + per-user system health endpoints.
//
// PUBLIC (allowlisted in globalGate):
//   GET /healthz — minimal liveness probe; no secrets, no user data.
//
// AUTHENTICATED (user-scoped):
//   GET /me/system-health — per-user diagnostic envelope. Returns only the
//   caller's own MT5 connection count, active session, risk-governor flag,
//   notification unread count, and report counts. No tokens, no hashes,
//   no other users' data.

import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import {
  db,
  mt5ConnectionTable,
  tradingSessionsTable,
  userNotificationsTable,
  userReportsTable,
  userRiskSettingsTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";

const router: IRouter = Router();

const PROCESS_STARTED_AT = Date.now();
const APP_VERSION =
  process.env["APP_VERSION"] ??
  process.env["REPL_BUILD_ID"] ??
  "0.0.0-dev";

const SAFETY_ENVELOPE = {
  safetyMode: "paper_only" as const,
  liveLocked: true as const,
  readOnlyMode: true as const,
  allowOrderExecution: false as const,
};

router.get("/healthz", (_req, res) => {
  // Keep the canonical zod-validated minimal payload first (back-compat),
  // then add safe public diagnostics (uptime, timestamp, version).
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json({
    ...data,
    ok: true,
    app: "ARX AI",
    version: APP_VERSION,
    uptimeSeconds: Math.floor((Date.now() - PROCESS_STARTED_AT) / 1000),
    timestamp: new Date().toISOString(),
  });
});

// User-scoped diagnostic. Returns ONLY data owned by the caller.
router.get("/me/system-health", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  try {
    // Personal MT5 connection count (active only; never exposes apiKeyHash/tokens).
    const mt5Rows = await db
      .select({
        id: mt5ConnectionTable.id,
        status: mt5ConnectionTable.status,
        lastHeartbeatAt: mt5ConnectionTable.lastHeartbeat,
      })
      .from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.userId, userId));

    const now = Date.now();
    const personalMt5 = mt5Rows.map((r) => {
      const age = r.lastHeartbeatAt ? now - new Date(r.lastHeartbeatAt).getTime() : null;
      const heartbeatHealth: "ok" | "stale" | "down" =
        age == null ? "down" : age < 15_000 ? "ok" : age < 60_000 ? "stale" : "down";
      return { id: r.id, status: r.status, heartbeatHealth };
    });

    // Active session for the caller.
    const activeSessions = await db
      .select({ id: tradingSessionsTable.id, status: tradingSessionsTable.status })
      .from(tradingSessionsTable)
      .where(and(
        eq(tradingSessionsTable.userId, userId),
        eq(tradingSessionsTable.status, "active"),
      ))
      .limit(5);

    // Personal risk-governor row (defaults if none yet).
    const rg = await db
      .select()
      .from(userRiskSettingsTable)
      .where(eq(userRiskSettingsTable.userId, userId))
      .limit(1);

    // Unread notifications.
    const unreadRows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(userNotificationsTable)
      .where(and(
        eq(userNotificationsTable.userId, userId),
        sql`${userNotificationsTable.readAt} IS NULL`,
      ));
    const unreadNotifications = unreadRows[0]?.n ?? 0;

    // Report status counts.
    const reportRows = await db
      .select({ status: userReportsTable.status })
      .from(userReportsTable)
      .where(eq(userReportsTable.userId, userId));
    const reportCounts: Record<string, number> = { processing: 0, completed: 0, failed: 0 };
    for (const r of reportRows) {
      const s = String(r.status ?? "completed");
      reportCounts[s] = (reportCounts[s] ?? 0) + 1;
    }

    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      auth: { authenticated: true, userId },
      account: {
        userId,
        email: req.authUser!.email ?? null,
        role: req.authUser!.role ?? "user",
      },
      mt5: {
        personalConnectionCount: personalMt5.length,
        connections: personalMt5,
        anyHealthy: personalMt5.some((c) => c.heartbeatHealth === "ok"),
      },
      tradingSession: {
        activeCount: activeSessions.length,
        sessionIds: activeSessions.map((s) => s.id),
      },
      riskGovernor: {
        configured: rg.length > 0,
        active: true,
        liveBlocked: true,
      },
      notifications: { unreadCount: unreadNotifications },
      reports: reportCounts,
      ...SAFETY_ENVELOPE,
    });
  } catch (e) {
    // Never echo raw error.message — could leak stack frames / SQL / paths.
    req.log?.error({ err: e }, "/me/system-health failed");
    res.status(500).json({
      ok: false,
      error: "system_health_failed",
      ...SAFETY_ENVELOPE,
    });
  }
});

export default router;
