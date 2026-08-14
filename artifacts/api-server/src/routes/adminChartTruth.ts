// Admin-only Chart Truth Health audit.
//
// GET /api/admin/chart-truth/audit
//   Runs (or returns the cached) per-symbol × per-timeframe candle-truth probe
//   matrix and returns the Phase 5 QA column set with a colour-codable status
//   per row. Cached for 5 minutes under a single-flight lock so the live
//   provider is never hit more often than a normal chart load.
//
// GET /api/admin/chart-truth/audit?force=1
//   Bypasses the cache (still single-flight) — for a manual refresh.
//
// Admin/Owner only. Mirrors the auth shape of adminMarketDataDiagnostics.ts:
// the effective role on req.authUser is used (admin-previewing-as-user is
// downgraded by effectiveViewMode middleware), and no secrets/keys are exposed.

import { type Request, type Response, Router } from "express";
import { getChartTruthAudit } from "../lib/data/chart/chartTruthAuditService.js";

const router: Router = Router();

function requireAdmin(req: Request, res: Response): { id: number; role: "ADMIN" | "OWNER" } | null {
  const u = (req as unknown as { authUser?: { id: number; role?: string } }).authUser;
  if (!u) { res.status(401).json({ error: "AUTH_REQUIRED" }); return null; }
  const role = String(u.role ?? "").toUpperCase();
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ error: "FORBIDDEN", message: "Admin or Owner role required." });
    return null;
  }
  return { id: u.id, role: role as "ADMIN" | "OWNER" };
}

router.get("/admin/chart-truth/audit", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const force = req.query.force === "1" || req.query.force === "true";
  try {
    const report = await getChartTruthAudit(force);
    res.json({ ok: true, report });
  } catch (err) {
    req.log.error({ err }, "chart-truth audit failed");
    res.status(500).json({ ok: false, error: "AUDIT_FAILED", message: "Could not build the chart-truth audit." });
  }
});

export default router;
