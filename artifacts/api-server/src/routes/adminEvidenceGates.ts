// Admin — EVIDENCE-GATED FLAG REPORTS (read only).
//
// Two flags are held OFF not because code is missing but because nobody can
// SEE whether the arming bar is met. These two endpoints are the seeing:
//
//   GET /api/admin/evidence-gates/conformal-coverage
//       Capability #4  — empirical coverage of the advisory conformal
//       predictions vs the declared level, over a chronological evaluation
//       window, with an explicit verdict.
//   GET /api/admin/evidence-gates/execution-policy-promotion
//       Capability #27 — how much shadow evidence has accumulated, what
//       fill-quality advantage it measures, and whether the promotion
//       threshold is met.
//
// SAFETY (inviolable):
//   * ADMIN/OWNER-gated, and READ-ONLY: both handlers are GETs that SELECT.
//     Neither arms a flag, unlocks a press, refreshes the promotion ladder,
//     nor writes any row. Producing a report can never change the thing it
//     reports on — that is what makes it evidence rather than an action.
//   * The reports are honest about a zero sample: a verdict of
//     INSUFFICIENT_HISTORY (today's expected answer for both) is rendered as
//     such, and an unreadable source is `sampleSize: null`, never `0`.
//   * The single owner press for each gate is DESCRIBED, never taken.

import { Router, type IRouter, type Request, type Response } from "express";
import { buildConformalCoverageReportFromJournal } from "../lib/conformal/conformalCoverageSource.js";
import { buildPromotionReportFromJournal } from "../lib/execution/executionPolicyPromotionReport.js";

const router: IRouter = Router();

function requireAdmin(req: Request, res: Response): { id: number } | null {
  const sess = (req as Request & { authUser?: { id: number; role?: string } }).authUser;
  if (!sess?.id) {
    res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
    return null;
  }
  const role = sess.role ?? null;
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" });
    return null;
  }
  return { id: sess.id };
}

// ── #4 — conformal coverage report ──────────────────────────────────────────
router.get("/admin/evidence-gates/conformal-coverage", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const report = await buildConformalCoverageReportFromJournal();
    res.json({ ok: true, readOnly: true, report });
  } catch (err) {
    // A crash is reported as a crash — never as an empty report, which would
    // read as "measured, and there is nothing wrong".
    res.status(500).json({
      ok: false,
      error: "COVERAGE_REPORT_FAILED",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── #27 — execution-policy promotion report ─────────────────────────────────
router.get("/admin/evidence-gates/execution-policy-promotion", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const report = await buildPromotionReportFromJournal();
    res.json({ ok: true, readOnly: true, report });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "PROMOTION_REPORT_FAILED",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
