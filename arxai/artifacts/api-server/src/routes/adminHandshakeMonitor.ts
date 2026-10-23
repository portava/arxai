// Admin — System Handshake Monitor
//
// GET  /api/admin/handshake-monitor          — current verdicts (all types) + recent evidence
// POST /api/admin/handshake-monitor/refresh   — force re-evaluate all + persist a fresh check-in row set
//
// The ARX Handshake System is a cross-layer readiness backbone. This endpoint
// exposes its ADVISORY verdicts to operators. It is NOT a gate: nothing here
// blocks, slows, or alters any execution path, the 16-gate live pipeline, the
// scanner, Ruby, the chart, or the trade modal.
//
// SECURITY:
//   - requireAdmin (ADMIN or OWNER). Anonymous → 401, regular user → 403.
//   - Read-only verdicts + append-only evidence. No mutation of any subsystem.
//   - Reasons are operator-facing diagnostics; this surface is admin-only and is
//     additionally hidden behind the frontend AdminDiagnosticsGate.

import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetAdminHandshakeMonitorResponse,
  RefreshAdminHandshakeMonitorResponse,
} from "@workspace/api-zod";
import { runAllHandshakes } from "../lib/handshake/coordinator.js";
import { getRecentHandshakeCheckins, logHandshakeResults } from "../lib/handshake/handshakeLog.js";
import { HANDSHAKE_DEFINITIONS } from "@workspace/domain/handshake";

const router: IRouter = Router();

function requireAdmin(req: Request, res: Response): boolean {
  const sess = (req as Request & { authUser?: { id: number; role?: string } }).authUser;
  if (!sess?.id) {
    res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
    return false;
  }
  const role = sess.role ?? null;
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" });
    return false;
  }
  return true;
}

router.get("/admin/handshake-monitor", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  // System/admin monitor view: no investor context → investor-scoped handshakes
  // report SKIPPED rather than reading any single tenant's data.
  const [verdicts, recent] = await Promise.all([
    runAllHandshakes({ context: { isAdmin: true } }),
    getRecentHandshakeCheckins(50),
  ]);
  const verdictViews = verdicts.map((v) => ({
    type: v.type,
    label: HANDSHAKE_DEFINITIONS[v.type].label,
    overallStatus: v.overallStatus,
    aggregateStatus: v.aggregateStatus,
    safeToProceed: v.safeToProceed,
    implemented: v.implemented,
    checks: v.checks,
    layersChecked: v.layersChecked,
    blockers: v.blockers,
    warnings: v.warnings,
    recommendations: v.recommendations,
    permissions: v.permissions,
    freshness: v.freshness,
    userFacingMessage: v.userFacingMessage,
    adminDetails: v.adminDetails,
    evaluatedAt: v.evaluatedAt,
  }));
  const summary = {
    total: verdictViews.length,
    implemented: verdictViews.filter((v) => v.implemented).length,
    ready: verdictViews.filter((v) => v.overallStatus === "READY").length,
    warnings: verdictViews.filter(
      (v) => v.overallStatus === "READY_WITH_WARNINGS" || v.overallStatus === "DEGRADED",
    ).length,
    waiting: verdictViews.filter(
      (v) => v.overallStatus === "WAITING_FOR_DATA" || v.overallStatus === "STALE",
    ).length,
    blocked: verdictViews.filter((v) => v.overallStatus === "BLOCKED").length,
    errors: verdictViews.filter((v) => v.overallStatus === "ERROR").length,
  };
  const payload = {
    ok: true,
    verdicts: verdictViews,
    recent,
    summary,
  };
  // Validate the response against the generated (OpenAPI-derived) contract.
  // Advisory surface: on an unexpected shape we log and still serve so the
  // operator monitor never goes blank, but a green build proves shape parity.
  const parsed = GetAdminHandshakeMonitorResponse.safeParse(payload);
  if (!parsed.success) {
    req.log.warn({ issues: parsed.error.issues }, "handshake-monitor response failed contract validation");
  }
  res.json(payload);
});

router.post("/admin/handshake-monitor/refresh", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const verdicts = await runAllHandshakes({ force: true, context: { isAdmin: true } });
  // Persist evidence for the implemented handshakes (scaffolds stay UNKNOWN and
  // are not noise-logged). Evaluation already persists fail-open; this records a
  // deliberate operator-forced snapshot too.
  await logHandshakeResults(verdicts.filter((v) => v.implemented));
  const payload = { ok: true, refreshed: verdicts.length };
  const parsed = RefreshAdminHandshakeMonitorResponse.safeParse(payload);
  if (!parsed.success) {
    req.log.warn({ issues: parsed.error.issues }, "handshake-monitor refresh response failed contract validation");
  }
  res.json(payload);
});

export default router;
