// Admin Intelligence — calibration roll-up (ADMIN/OWNER only).
//
// SAFETY / SCOPE:
//   - Every route requires an ADMIN/OWNER session. Admin-previewing-as-user is
//     auto-downgraded by requireAdmin and lands in the 403 branch (mirrors
//     adminRubyQuality).
//   - READ-ONLY over EXISTING resolved Ruby signal outcomes. ZERO new tables.
//     Nothing here places / modifies / closes a trade or touches the MT5 bridge
//     or the 16-gate live pipeline. OBSERVATION ONLY.
//   - Calibration is descriptive (confidence tier vs realized accuracy). It is
//     NEVER an execution gate and never feeds one.

import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import { computeCalibrationRollup, type CalibrationFilter } from "../lib/rubyQuality/index.js";

const router = Router();

function err(res: Response, status: number, message: string) {
  res.status(status).json({ ok: false, error: message });
}

type AdminRole = "ADMIN" | "OWNER";

/**
 * Resolve a true ADMIN/OWNER session. Admin-previewing-as-user is downgraded by
 * the upstream product-role gate and lands in the 403 branch here too (mirrors
 * the adminRubyQuality pattern — checks the EFFECTIVE req.authUser.role).
 */
function requireAdmin(req: Request, res: Response): { id: number; role: AdminRole } | null {
  const u = (req as Request & { authUser?: { id?: number; role?: string } }).authUser;
  if (u?.id == null || (u.role !== "ADMIN" && u.role !== "OWNER")) {
    err(res, 403, "ADMIN_REQUIRED");
    return null;
  }
  return { id: u.id, role: u.role };
}

const calibrationQuery = z.object({
  userId: z.coerce.number().int().positive().optional(),
  symbol: z.string().trim().min(1).max(64).optional(),
  fromMs: z.coerce.number().int().nonnegative().optional(),
  toMs: z.coerce.number().int().nonnegative().optional(),
  minSample: z.coerce.number().int().min(1).max(1000).optional(),
});

// ── GET /admin/intelligence/calibration ────────────────────────────────────
router.get("/admin/intelligence/calibration", requireUser, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const q = calibrationQuery.safeParse(req.query ?? {});
  if (!q.success) { err(res, 400, "invalid_query"); return; }

  const filter: CalibrationFilter = { ...q.data };
  try {
    const calibration = await computeCalibrationRollup(filter);
    res.json({ ok: true, calibration });
  } catch (e) {
    req.log?.error({ err: e }, "admin_intelligence_calibration_failed");
    err(res, 500, "calibration_failed");
  }
});

export { router as adminIntelligenceRouter };
