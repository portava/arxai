// Admin research surface — real-data validation evidence (READ-ONLY).
//
//   GET /api/admin/research/validation-evidence        — newest runs, verified manifests
//   GET /api/admin/research/validation-evidence/:id    — one run, payload VERIFIED
//                                                         (?full=1 adds every variant and fold)
//
// Runs are written only by the offline runner
// (scripts/src/research/runRealDataValidation.ts --store). There is no write,
// promote or delete route here: survivors are reported with ceiling SHADOW and
// liveAllowed=false, and promotion beyond that is the owner's, elsewhere.
// ADMIN/OWNER only. A missing/unmigrated table is an honest 503, never a 500.

import { Router } from "express";
import { pool } from "@workspace/db";
import { requireUser } from "../lib/auth/middleware.js";
import { operatorRoleFromSession } from "../lib/security/adminRoleGate.js";
import { ValidationEvidenceStore, ValidationEvidenceError } from "../lib/research/validationEvidence.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ component: "adminValidationEvidence" });
const router = Router();
const store = new ValidationEvidenceStore(pool);

const NOTE =
  "Real-data validation evidence: every strategyEngine family over hashed real history, walk-forward + purged/embargoed CPCV + " +
  "Deflated Sharpe + PBO + one family-wide Benjamini–Hochberg pass. A survivor is at most a SHADOW proposal; liveAllowed is never set here.";

function requireAdmin(req: any, res: any): boolean {
  const u = req.authUser;
  if (!u) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return false; }
  if (!operatorRoleFromSession(u.role)) { res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" }); return false; }
  return true;
}

function failure(res: any, e: unknown) {
  if (e instanceof ValidationEvidenceError && e.code === "VALIDATION_EVIDENCE_INTEGRITY") {
    return res.status(409).json({ ok: false, error: e.code, message: "Stored evidence failed hash verification and is not shown as evidence." });
  }
  if (e instanceof ValidationEvidenceError && e.code === "INVALID_VALIDATION_EVIDENCE") {
    return res.status(400).json({ ok: false, error: e.code });
  }
  log.warn({ err: e }, "validation_evidence_unavailable");
  return res.status(503).json({
    ok: false, error: "VALIDATION_EVIDENCE_UNAVAILABLE",
    message: "validation_evidence_v1 could not be read — if migration 2026-11-09_validation_evidence_v1.sql has not been applied yet, this is expected.",
  });
}

router.get("/admin/research/validation-evidence", requireUser, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const items = await store.list(20);
    return res.json({ ok: true, readOnly: true, note: NOTE, items, count: items.length });
  } catch (e) { return failure(res, e); }
});

router.get("/admin/research/validation-evidence/:id", requireUser, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const found = await store.read(String(req.params.id));
    if (!found) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    const run = found.run as Record<string, unknown>;
    const full = req.query.full === "1";
    const { variants, walkForward, ...rest } = run;
    return res.json({
      ok: true, readOnly: true, note: NOTE, manifest: found.manifest, manifestHash: found.manifestHash,
      payloadVerified: found.payloadVerified,
      run: full ? run : { ...rest, variantCount: Array.isArray(variants) ? variants.length : 0,
        walkForwardCount: Array.isArray(walkForward) ? walkForward.length : 0 },
    });
  } catch (e) { return failure(res, e); }
});

export default router;
