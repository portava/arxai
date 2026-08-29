// Admin — Resilience-front surfaces (#27 promotion gate, #35 as-of tool)
//
// SAFETY (inviolable):
//   - All handlers ADMIN/OWNER-gated.
//   - #35 handlers are READ-ONLY (SELECTs only; a debugger, not a control).
//   - The ONLY authority-widening handler is POST
//     /admin/execution-policy/enable — the OWNER-PRESS seam of the #27
//     promotion gate. It requires { confirm: true } + a reason, is refused
//     unless the evidence threshold has UNLOCKED the press AND still holds
//     when re-verified at press time, and writes a before/after audit row.
//     Automatic code paths can only move SHADOW ↔ PRESS_UNLOCKED (both
//     shadow-mode); nothing auto-enables.
//   - Reverting to SHADOW is always accepted (authority only shrinks).
//   - A missing table (docs/migrations-pending/build-resilience.sql not
//     applied) answers 503 with the exact remedy, never a fabricated status.
import express, { type IRouter, Router, type Request, type Response } from "express";
import { db, adminActionAuditLogTable } from "@workspace/db";
import {
  collectPromotionEvidence,
  pressEnableExecutionPolicy,
  pressRevertExecutionPolicyToShadow,
  readPromotionState,
  refreshPromotionEvidence,
  resolveExecutionPolicyMode,
} from "../lib/execution/executionPolicyPromotion.js";
import { reconstructSystemAsOf } from "../lib/timeTravel/asOfReconstruction.js";

const router: IRouter = Router();
router.use(express.json());

function requireAdmin(
  req: Request,
  res: Response,
): { id: number; role: "ADMIN" | "OWNER" } | null {
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
  return { id: sess.id, role };
}

function tableMissingResponse(res: Response): void {
  res.status(503).json({
    ok: false,
    error: "RESILIENCE_TABLES_MISSING",
    detail:
      "The execution_policy_promotions table does not exist in this database yet. Apply docs/migrations-pending/build-resilience.sql via raw psql (drizzle-kit push is broken against the dev DB).",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// #27 — GET /api/admin/execution-policy
// Promotion status + a FRESH evidence evaluation (refresh runs on read so the
// unlock state is never stale on the surface the owner looks at).
// ─────────────────────────────────────────────────────────────────────────────
router.get("/admin/execution-policy", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const refreshed = await refreshPromotionEvidence();
  const read = await readPromotionState();
  if (!read.ok) {
    if (read.missingTable) return tableMissingResponse(res);
    res.status(500).json({ ok: false, error: "READ_FAILED", detail: read.reason });
    return;
  }
  const mode = await resolveExecutionPolicyMode();
  res.json({
    ok: true,
    mode,
    promotion: read.row ?? null,
    evidence: refreshed.ok ? refreshed.evidence : null,
    evidenceError: refreshed.ok ? null : refreshed.reason,
    ladder: ["SHADOW", "PRESS_UNLOCKED (evidence threshold met — grants nothing, unlocks the press)", "ENABLED (owner press only)"],
    note: "The chooser journals shadow recommendations in every status except ENABLED-consumed — and no dispatch-path consumer of ENABLED exists yet; wiring one is a separate reviewed change. Nothing auto-enables.",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #27 — POST /api/admin/execution-policy/enable   (OWNER-PRESS seam)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/admin/execution-policy/enable", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.confirm !== true) {
    res.status(400).json({
      ok: false,
      error: "CONFIRMATION_REQUIRED",
      detail: "Send { confirm: true, reason: \"...\" } — enabling the execution-policy chooser is an owner press over accumulated shadow evidence.",
    });
    return;
  }
  const reason = typeof body.reason === "string" && body.reason.trim().length > 0
    ? body.reason.trim().slice(0, 500)
    : null;
  if (!reason) {
    res.status(400).json({ ok: false, error: "REASON_REQUIRED", detail: "A non-empty reason is required for the audit trail." });
    return;
  }
  try {
    // Keep the unlock state current before judging the press.
    await refreshPromotionEvidence();
    const before = await readPromotionState();
    const result = await pressEnableExecutionPolicy({
      actor: `admin:${admin.id}`,
      reason,
      confirm: true,
    });
    if (!result.ok) {
      res.status(409).json({ ok: false, error: "ENABLE_REFUSED", detail: result.reason, evidenceReasons: result.evidenceReasons ?? [] });
      return;
    }
    await db.insert(adminActionAuditLogTable).values({
      adminId: admin.id,
      adminRole: admin.role,
      action: "ADMIN_ENABLED_EXECUTION_POLICY",
      beforeState: { status: result.fromStatus, row: (before.ok ? before.row : null) ?? null },
      afterState: { status: result.toStatus, reason, pressReasons: result.reasons },
    });
    res.json({
      ok: true,
      fromStatus: result.fromStatus,
      toStatus: result.toStatus,
      reasons: result.reasons,
      note: "ENABLED recorded. No dispatch path consumes this yet — the first consumer is a separate reviewed change; until then the chooser remains observably shadow.",
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: "ENABLE_FAILED", detail: err instanceof Error ? err.message : String(err) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #27 — POST /api/admin/execution-policy/revert   (always allowed)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/admin/execution-policy/revert", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const reason = typeof body.reason === "string" && body.reason.trim().length > 0
    ? body.reason.trim().slice(0, 500)
    : "owner revert (no reason given)";
  try {
    const before = await readPromotionState();
    const result = await pressRevertExecutionPolicyToShadow({ actor: `admin:${admin.id}`, reason });
    if (!result.ok) {
      if (before.ok === false && before.missingTable) return tableMissingResponse(res);
      res.status(500).json({ ok: false, error: "REVERT_FAILED", detail: result.reason });
      return;
    }
    await db.insert(adminActionAuditLogTable).values({
      adminId: admin.id,
      adminRole: admin.role,
      action: "ADMIN_REVERTED_EXECUTION_POLICY",
      beforeState: { status: result.fromStatus },
      afterState: { status: result.toStatus, reason },
    });
    res.json({ ok: true, fromStatus: result.fromStatus, toStatus: result.toStatus, reasons: result.reasons });
  } catch (err) {
    res.status(500).json({ ok: false, error: "REVERT_FAILED", detail: err instanceof Error ? err.message : String(err) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #35 — GET /api/admin/as-of?timestamp=<ISO or ms>
// Read-only reconstruction of the system view at a historical instant.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/admin/as-of", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const rawTs = typeof req.query.timestamp === "string" ? req.query.timestamp : null;
  if (!rawTs) {
    res.status(400).json({ ok: false, error: "TIMESTAMP_REQUIRED", detail: "Pass ?timestamp=<ISO-8601 or epoch ms>." });
    return;
  }
  const asOfMs = /^\d+$/.test(rawTs) ? Number(rawTs) : Date.parse(rawTs);
  if (!Number.isFinite(asOfMs)) {
    res.status(400).json({ ok: false, error: "TIMESTAMP_UNPARSEABLE", detail: `Could not parse '${rawTs}' as ISO-8601 or epoch ms.` });
    return;
  }
  if (asOfMs > Date.now()) {
    res.status(400).json({ ok: false, error: "TIMESTAMP_IN_FUTURE", detail: "As-of reconstruction is historical only — the future is not reconstructible." });
    return;
  }
  try {
    const view = await reconstructSystemAsOf(asOfMs);
    res.json({ ok: true, readOnly: true, view });
  } catch (err) {
    res.status(500).json({ ok: false, error: "RECONSTRUCTION_FAILED", detail: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
