// Build MM — System Health, Audit, and Admin Control Center routes.
//
// SAFETY: All endpoints are READ-ONLY diagnostics or SAFE admin actions.
// Forbidden admin actions return REJECTED with CRITICAL audit. liveTradingStatus
// is always DISABLED. mode is always PAPER_ONLY.

import { Router, type Request, type Response } from "express";
import { runHealthCheck, runSubsystemCheck, listHealthChecks, exportHealthReport, type SubsystemBuild } from "../lib/systemHealth/health.js";
import { listAudit, getAuditById, exportAudit, seedAuditDemo, auditEvent } from "../lib/systemHealth/audit.js";
import { getConfig } from "../lib/systemHealth/config.js";
import { performAdminAction, listAdminActions, ALLOWED_ADMIN_ACTIONS, FORBIDDEN_ADMIN_ACTIONS, seedAdminDemo } from "../lib/systemHealth/admin.js";

const router: Router = Router();
const TAG = "Build MM — System Health, Audit, and Admin Control Center. Diagnostics + safe admin only. Never places trades, never enables live trading, never calls MT5, never modifies canPlaceTrades, never exposes secrets.";
function envelope(body: Record<string, unknown>) {
  return {
    system: "system-health",
    liveTradingStatus: "DISABLED" as const,
    mode: "PAPER_ONLY" as const,
    canPlaceLiveTrade: false as const,
    disclaimer: TAG,
    ...body,
  };
}

// ─── Admin gate — same canonical per-user-cookie pattern used by
// adminAuditCenter.ts. Reads role from the per-user authUser session populated
// by requireAuthOrPublic. Never reads x-security-role directly.
function requireAdmin(req: Request, res: Response): "ADMIN" | "OWNER" | null {
  const u = (req as Request & { authUser?: { role?: string } }).authUser;
  const role = String(u?.role ?? "").toUpperCase();
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json(envelope({ error: "ADMIN_OR_OWNER_REQUIRED" }));
    return null;
  }
  return role as "ADMIN" | "OWNER";
}

// ── System Health ───────────────────────────────────────────────────────────
router.get("/system-health/status", async (_req, res) => {
  try {
    const cfg = await getConfig();
    const recent = await listHealthChecks(1);
    res.json(envelope({ config: cfg, lastHealthCheck: recent[0] ?? null }));
  } catch (err) { res.status(500).json(envelope({ error: "status failed", detail: String(err).slice(0, 200) })); }
});

router.post("/system-health/check", async (_req, res) => {
  try { res.json(envelope({ report: await runHealthCheck() })); }
  catch (err) { res.status(500).json(envelope({ error: "health check failed", detail: String(err).slice(0, 200) })); }
});

router.get("/system-health/checks", async (req, res) => {
  try {
    const limit = req.query["limit"] ? Number(req.query["limit"]) : 20;
    const items = await listHealthChecks(limit);
    res.json(envelope({ count: items.length, checks: items }));
  } catch (err) { res.status(500).json(envelope({ error: "checks failed", detail: String(err).slice(0, 200) })); }
});

router.get("/system-health/subsystems", async (_req, res) => {
  try { res.json(envelope({ subsystems: (await runHealthCheck()).subsystemStatus })); }
  catch (err) { res.status(500).json(envelope({ error: "subsystems failed", detail: String(err).slice(0, 200) })); }
});

router.get("/system-health/subsystems/:build", async (req, res) => {
  try {
    const build = String(req.params["build"] ?? "").toUpperCase() as SubsystemBuild;
    if (!/^(AA|BB|CC|DD|EE|FF|GG|HH|II|JJ|KK|LL)$/.test(build)) {
      res.status(400).json(envelope({ error: "invalid build code (AA..LL)" })); return;
    }
    res.json(envelope({ build, status: await runSubsystemCheck(build) }));
  } catch (err) { res.status(500).json(envelope({ error: "subsystem failed", detail: String(err).slice(0, 200) })); }
});

router.get("/system-health/config", async (_req, res) => {
  try { res.json(envelope({ config: await getConfig() })); }
  catch (err) { res.status(500).json(envelope({ error: "config failed", detail: String(err).slice(0, 200) })); }
});

router.post("/system-health/demo", async (_req, res) => {
  try {
    const report = await runHealthCheck();
    const auditIds = await seedAuditDemo();
    res.json(envelope({ demo: true, healthCheckId: report.health_check_id, overallStatus: report.overallStatus, auditDemoIds: auditIds.length }));
  } catch (err) { res.status(500).json(envelope({ error: "demo failed", detail: String(err).slice(0, 200) })); }
});

// ── Audit ───────────────────────────────────────────────────────────────────
router.get("/audit/logs", async (req, res) => {
  try {
    const limit = req.query["limit"] ? Number(req.query["limit"]) : 50;
    const items = await listAudit({
      limit,
      severity: typeof req.query["severity"] === "string" ? (req.query["severity"] as string).toUpperCase() : undefined,
      sourceBuild: typeof req.query["sourceBuild"] === "string" ? (req.query["sourceBuild"] as string).toUpperCase() : undefined,
      action: typeof req.query["action"] === "string" ? (req.query["action"] as string) : undefined,
    });
    res.json(envelope({ count: items.length, audits: items }));
  } catch (err) { res.status(500).json(envelope({ error: "audit list failed", detail: String(err).slice(0, 200) })); }
});

router.get("/audit/logs/:id", async (req, res) => {
  try {
    const row = await getAuditById(String(req.params["id"]));
    if (!row) { res.status(404).json(envelope({ error: "not found" })); return; }
    res.json(envelope({ audit: row }));
  } catch (err) { res.status(500).json(envelope({ error: "audit get failed", detail: String(err).slice(0, 200) })); }
});

router.post("/audit/export", async (req, res) => {
  try {
    const limit = Number(req.body?.limit ?? 500);
    const exp = await exportAudit(limit);
    await auditEvent({ eventType: "AUDIT_EXPORT", severity: "INFO", sourceBuild: "MM", sourceService: "audit", actor: "ADMIN", action: "export-audit", metadata: { count: exp.count } });
    res.json(envelope({ export: exp }));
  } catch (err) { res.status(500).json(envelope({ error: "audit export failed", detail: String(err).slice(0, 200) })); }
});

router.post("/audit/demo", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json(envelope({ demo: true, ids: await seedAuditDemo() })); }
  catch (err) { res.status(500).json(envelope({ error: "audit demo failed", detail: String(err).slice(0, 200) })); }
});

// ── Admin Control ───────────────────────────────────────────────────────────
router.post("/admin-control/action", async (req, res) => {
  try {
    const r = await performAdminAction({
      action: String(req.body?.action ?? ""),
      reason: req.body?.reason ? String(req.body.reason).slice(0, 200) : undefined,
      requestedBy: req.body?.requestedBy ? String(req.body.requestedBy).slice(0, 80) : undefined,
      payload: (req.body?.payload ?? {}) as Record<string, unknown>,
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? undefined,
    });
    res.status(r.status === "REJECTED" ? 403 : (r.status === "FAILED" ? 500 : 200)).json(envelope({ result: r }));
  } catch (err) { res.status(500).json(envelope({ error: "admin action failed", detail: String(err).slice(0, 200) })); }
});

router.get("/admin-control/actions", async (req, res) => {
  try {
    const items = await listAdminActions(req.query["limit"] ? Number(req.query["limit"]) : 50);
    res.json(envelope({ count: items.length, actions: items, allowed: ALLOWED_ADMIN_ACTIONS, forbidden: FORBIDDEN_ADMIN_ACTIONS }));
  } catch (err) { res.status(500).json(envelope({ error: "actions list failed", detail: String(err).slice(0, 200) })); }
});

const shortcut = (action: string) => async (req: Parameters<typeof performAdminAction>[0] extends infer _ ? import("express").Request : never, res: import("express").Response) => {
  try {
    const r = await performAdminAction({
      action, reason: req.body?.reason, payload: (req.body?.payload ?? {}) as Record<string, unknown>,
      ipAddress: req.ip, userAgent: req.get("user-agent") ?? undefined,
    });
    res.status(r.status === "REJECTED" ? 403 : (r.status === "FAILED" ? 500 : 200)).json(envelope({ result: r }));
  } catch (err) { res.status(500).json(envelope({ error: "admin shortcut failed", detail: String(err).slice(0, 200) })); }
};

router.post("/admin-control/emergency-watch-only",        shortcut("EMERGENCY_WATCH_ONLY"));
router.post("/admin-control/stop-autopilot",              shortcut("STOP_PAPER_AUTOPILOT"));
router.post("/admin-control/rebuild-performance",         shortcut("REBUILD_PERFORMANCE"));
router.post("/admin-control/generate-coach-report",       shortcut("REGENERATE_TRADER_COACH_REPORT"));
router.post("/admin-control/generate-notification-digest", shortcut("GENERATE_NOTIFICATION_DIGEST"));
router.post("/admin-control/export-health-report",        shortcut("EXPORT_HEALTH_REPORT"));
router.post("/admin-control/export-audit-report",         shortcut("EXPORT_AUDIT_REPORT"));

router.post("/admin-control/demo", async (_req, res) => {
  try { res.json(envelope({ demo: true, ...(await seedAdminDemo()) })); }
  catch (err) { res.status(500).json(envelope({ error: "demo failed", detail: String(err).slice(0, 200) })); }
});

export default router;
