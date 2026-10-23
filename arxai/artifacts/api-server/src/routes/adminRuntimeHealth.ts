// adminRuntimeHealth.ts — ADMIN/OWNER-only runtime/workflow health snapshot.
//
// Surfaces what the api-server can AUTHORITATIVELY report about its own
// runtime: uptime, version/build, DB reachability + latency, and aggregate
// MT5/EA bridge heartbeat health (counts only). Frontend-listening, served
// build hash, and orphaned/duplicate-process detection are intentionally
// out of band (a process cannot reliably introspect a sibling workflow's
// socket from inside its own container) and are reported by the shell command
// `pnpm run health:workflows`.
//
// SECURITY:
//   - ADMIN/OWNER session only. Admin-previewing-as-user is auto-downgraded
//     upstream by applyEffectiveViewMode and lands in the 403 branch.
//   - Read-only. No mutation, no audit row, no trade path.
//   - Counts only — never account numbers, IP addresses, tokens, or hashes.

import { Router, type IRouter, type Request, type Response } from "express";
import { db, mt5ConnectionTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { enforceSensitiveAction } from "../lib/security/handshake.js";

const router: IRouter = Router();

const PROCESS_STARTED_AT = Date.now();
const APP_VERSION =
  process.env["APP_VERSION"] ?? process.env["REPL_BUILD_ID"] ?? "0.0.0-dev";
const BUILD_TIMESTAMP = process.env["BUILD_TIMESTAMP"] ?? null;

const SAFETY_ENVELOPE = {
  safetyMode: "paper_only" as const,
  liveLocked: true as const,
  readOnlyMode: true as const,
  allowOrderExecution: false as const,
};

// Authority is the validated session role on req.authUser (set after verifying
// the session cookie). We do NOT read the x-security-role header here — the
// CI guard forbids it outside the auditable resolver, and req.authUser.role is
// already the trusted source.
function requireAdmin(req: Request, res: Response): "ADMIN" | "OWNER" | null {
  const u = (req as Request & { authUser?: { role?: string } }).authUser;
  const role = String(u?.role ?? "").toUpperCase();
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_OR_OWNER_REQUIRED" });
    return null;
  }
  return role as "ADMIN" | "OWNER";
}

router.get("/admin/runtime-health", async (req: Request, res: Response): Promise<void> => {
  const adminRole = requireAdmin(req, res);
  if (!adminRole) return;
  const callerId = (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;
  const hs = await enforceSensitiveAction("ADMIN_DIAGNOSTICS", {
    userId: callerId, role: adminRole, authenticated: true, adminSurfaceOk: true,
  });
  if (!hs.ok) { res.status(403).json({ ok: false, error: hs.reasonCode, message: hs.userMessage }); return; }
  const now = Date.now();

  // DB reachability + latency.
  let dbOk = false;
  let dbLatencyMs: number | null = null;
  const t0 = Date.now();
  try {
    await db.execute(sql`select 1`);
    dbOk = true;
    dbLatencyMs = Date.now() - t0;
  } catch (e) {
    req.log?.error({ err: e }, "runtime-health DB ping failed");
  }

  // Aggregate MT5/EA bridge heartbeat health — COUNTS ONLY.
  const bridge = {
    total: 0,
    healthy: 0,
    stale: 0,
    down: 0,
    latestHeartbeatAgeSeconds: null as number | null,
  };
  try {
    const rows = await db
      .select({ lastHeartbeat: mt5ConnectionTable.lastHeartbeat })
      .from(mt5ConnectionTable);
    let latest: number | null = null;
    for (const r of rows) {
      const age = r.lastHeartbeat ? now - new Date(r.lastHeartbeat).getTime() : null;
      const health: "healthy" | "stale" | "down" =
        age == null ? "down" : age < 15_000 ? "healthy" : age < 60_000 ? "stale" : "down";
      bridge.total += 1;
      bridge[health] += 1;
      if (age != null && (latest == null || age < latest)) latest = age;
    }
    bridge.latestHeartbeatAgeSeconds = latest == null ? null : Math.floor(latest / 1000);
  } catch (e) {
    req.log?.error({ err: e }, "runtime-health MT5 aggregate failed");
  }

  res.json({
    ok: dbOk,
    checkedAt: new Date().toISOString(),
    apiServer: {
      listening: true,
      pid: process.pid,
      version: APP_VERSION,
      buildTimestamp: BUILD_TIMESTAMP,
      startedAt: new Date(PROCESS_STARTED_AT).toISOString(),
      uptimeSeconds: Math.floor((now - PROCESS_STARTED_AT) / 1000),
    },
    database: { ok: dbOk, latencyMs: dbLatencyMs },
    bridge,
    notes: [
      "Frontend-listening, served build hash, and orphaned/duplicate-process detection are reported by `pnpm run health:workflows` (run from the shell).",
      "Bridge values are aggregate heartbeat-health counts only — no account numbers, IPs, or tokens are exposed.",
    ],
    ...SAFETY_ENVELOPE,
  });
});

export default router;
