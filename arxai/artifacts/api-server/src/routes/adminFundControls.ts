// ARX Fund Book — admin Discrepancy & controls center endpoints (Task #133).
//
// SAFETY (inviolable):
// - Admin-only (role ∈ {ADMIN, OWNER}). Admin-previewing-as-user is downgraded
//   by the upstream product-role gate and lands in the 403 branch here too.
// - DETECTION ONLY. These routes FLAG mismatches and LOCK sensitive accounting
//   actions; they NEVER auto-edit an investor balance, NEVER close a position,
//   and NEVER touch any execution path, lot sizing, the 16-gate live pipeline,
//   kill switch, or any broker dispatch surface.
// - Every mutation is FAIL-CLOSED audited inside the service layer: the mutation
//   and its admin_action_audit_log row are written inside ONE db.transaction.
// - No paper/sim/mock/fake/guaranteed-return wording anywhere.

import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import {
  FundControlError,
  type AdminActor,
  type DiscrepancyAction,
  getReconciliationSettings,
  updateReconciliationSettings,
  runReconciliation,
  listDiscrepancies,
  actOnDiscrepancy,
  applyFreeze,
  liftFreeze,
  listActiveFreezes,
  listCapacityLimits,
  upsertCapacityLimit,
} from "../lib/fundbook/fundControls.js";
import {
  DISCREPANCY_STATUSES,
  DISCREPANCY_SEVERITIES,
  FREEZE_SCOPES,
  CAPACITY_SCOPES,
  type DiscrepancyStatus,
} from "@workspace/db";

const router = Router();

function requireAdmin(req: Request, res: Response): AdminActor | null {
  const u = (req as Request & { authUser?: { id?: number; role?: string } }).authUser;
  if (!u?.id) {
    res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
    return null;
  }
  if (u.role !== "ADMIN" && u.role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" });
    return null;
  }
  return { id: u.id, role: u.role };
}

function handleError(res: Response, e: unknown): void {
  if (e instanceof FundControlError) {
    res.status(e.httpStatus).json({ ok: false, error: e.code, message: e.investorMessage });
    return;
  }
  const msg = e instanceof Error ? e.message : "FUND_CONTROL_ERROR";
  res.status(400).json({ ok: false, error: msg });
}

const reasonSchema = z.string().trim().min(3, "reason must be at least 3 characters");

// ── GET /admin/fundbook/reconciliation/settings ─────────────────────────────
router.get("/admin/fundbook/reconciliation/settings", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const settings = await getReconciliationSettings();
  res.json({ ok: true, settings });
});

// ── PATCH /admin/fundbook/reconciliation/settings ───────────────────────────
const updateSettingsSchema = z.object({
  reason: reasonSchema,
  lowUsd: z.number().nonnegative().optional(),
  mediumUsd: z.number().nonnegative().optional(),
  highUsd: z.number().nonnegative().optional(),
  criticalUsd: z.number().nonnegative().optional(),
  lowPct: z.number().nonnegative().optional(),
  mediumPct: z.number().nonnegative().optional(),
  highPct: z.number().nonnegative().optional(),
  criticalPct: z.number().nonnegative().optional(),
  staleSyncMs: z.number().int().positive().optional(),
  autoLockOnCritical: z.boolean().optional(),
});
router.patch("/admin/fundbook/reconciliation/settings", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const parsed = updateSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_BODY" });
    return;
  }
  try {
    const { reason, ...patch } = parsed.data;
    const settings = await updateReconciliationSettings(admin, patch, reason);
    res.json({ ok: true, settings });
  } catch (e) {
    handleError(res, e);
  }
});

// ── POST /admin/fundbook/reconciliation/run ─────────────────────────────────
const runSchema = z.object({ reason: reasonSchema });
router.post("/admin/fundbook/reconciliation/run", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_BODY" });
    return;
  }
  try {
    const result = await runReconciliation(admin, parsed.data.reason);
    res.json({ ok: true, ...result });
  } catch (e) {
    handleError(res, e);
  }
});

// ── GET /admin/fundbook/reconciliation/overview ─────────────────────────────
router.get("/admin/fundbook/reconciliation/overview", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const [all, activeFreezes, capacity] = await Promise.all([
    listDiscrepancies({}),
    listActiveFreezes(),
    listCapacityLimits(),
  ]);

  const bySeverity: Record<string, number> = {};
  let openCount = 0;
  let investigatingCount = 0;
  let criticalOpenCount = 0;
  let lastRunAt: string | null = null;

  for (const d of all) {
    const ts = d.lastDetectedAt instanceof Date ? d.lastDetectedAt.toISOString() : String(d.lastDetectedAt);
    if (lastRunAt == null || ts > lastRunAt) lastRunAt = ts;
    const isOpen = d.status === "OPEN" || d.status === "INVESTIGATING";
    if (!isOpen) continue;
    if (d.status === "OPEN") openCount += 1;
    if (d.status === "INVESTIGATING") investigatingCount += 1;
    bySeverity[d.severity] = (bySeverity[d.severity] ?? 0) + 1;
    if (d.severity === "CRITICAL") criticalOpenCount += 1;
  }

  res.json({
    ok: true,
    openCount,
    investigatingCount,
    criticalOpenCount,
    bySeverity,
    lastRunAt,
    activeFreezes,
    capacity,
  });
});

// ── GET /admin/fundbook/discrepancies ───────────────────────────────────────
router.get("/admin/fundbook/discrepancies", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const severity = typeof req.query.severity === "string" ? req.query.severity : undefined;
  const userIdRaw = typeof req.query.userId === "string" ? Number(req.query.userId) : undefined;
  const poolIdRaw =
    typeof req.query.strategyPoolId === "string" ? Number(req.query.strategyPoolId) : undefined;

  const validStatus =
    status && (DISCREPANCY_STATUSES as readonly string[]).includes(status)
      ? (status as DiscrepancyStatus)
      : undefined;
  const validSeverity =
    severity && (DISCREPANCY_SEVERITIES as readonly string[]).includes(severity)
      ? severity
      : undefined;

  const discrepancies = await listDiscrepancies({
    status: validStatus,
    severity: validSeverity,
    userId: userIdRaw != null && Number.isFinite(userIdRaw) ? userIdRaw : undefined,
    strategyPoolId: poolIdRaw != null && Number.isFinite(poolIdRaw) ? poolIdRaw : undefined,
  });
  res.json({ ok: true, discrepancies });
});

// ── POST /admin/fundbook/discrepancies/:id/action ───────────────────────────
const actionSchema = z.object({
  action: z.enum(["ASSIGN", "NOTE", "INVESTIGATE", "RESOLVE", "DISMISS"]),
  reason: z.string().trim().min(3).optional(),
  note: z.string().trim().min(1).optional(),
  assigneeId: z.number().int().positive().optional(),
});
router.post("/admin/fundbook/discrepancies/:id/action", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_ID" });
    return;
  }
  const parsed = actionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_BODY" });
    return;
  }
  try {
    const { action, reason, note, assigneeId } = parsed.data;
    const discrepancy = await actOnDiscrepancy(admin, id, action as DiscrepancyAction, {
      reason,
      note,
      assigneeId,
    });
    res.json({ ok: true, discrepancy });
  } catch (e) {
    handleError(res, e);
  }
});

// ── GET /admin/fundbook/freezes ─────────────────────────────────────────────
router.get("/admin/fundbook/freezes", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const freezes = await listActiveFreezes();
  res.json({ ok: true, freezes });
});

// ── POST /admin/fundbook/freezes ────────────────────────────────────────────
const applyFreezeSchema = z.object({
  scope: z.enum(FREEZE_SCOPES),
  scopeKey: z.string().trim().min(1).optional(),
  reason: reasonSchema,
  relatedDiscrepancyId: z.number().int().positive().optional(),
});
router.post("/admin/fundbook/freezes", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const parsed = applyFreezeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_BODY" });
    return;
  }
  try {
    const { scope, scopeKey, reason, relatedDiscrepancyId } = parsed.data;
    const freeze = await applyFreeze(admin, {
      scope,
      scopeKey,
      reason,
      source: "MANUAL",
      relatedDiscrepancyId,
    });
    res.json({ ok: true, freeze });
  } catch (e) {
    handleError(res, e);
  }
});

// ── POST /admin/fundbook/freezes/:id/lift ───────────────────────────────────
const liftSchema = z.object({ note: reasonSchema });
router.post("/admin/fundbook/freezes/:id/lift", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_ID" });
    return;
  }
  const parsed = liftSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_BODY" });
    return;
  }
  try {
    const freeze = await liftFreeze(admin, id, parsed.data.note);
    res.json({ ok: true, freeze });
  } catch (e) {
    handleError(res, e);
  }
});

// ── GET /admin/fundbook/capacity ────────────────────────────────────────────
router.get("/admin/fundbook/capacity", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const limits = await listCapacityLimits();
  res.json({ ok: true, limits });
});

// ── POST /admin/fundbook/capacity ───────────────────────────────────────────
const upsertCapacitySchema = z.object({
  scope: z.enum(CAPACITY_SCOPES),
  scopeKey: z.string().trim().min(1).optional(),
  maxFundCapital: z.number().nonnegative().optional(),
  maxPoolCapital: z.number().nonnegative().optional(),
  maxInvestorCapital: z.number().nonnegative().optional(),
  exposureCapPct: z.number().nonnegative().optional(),
  liquidityReservePct: z.number().nonnegative().optional(),
  nearCapacityThresholdPct: z.number().nonnegative().optional(),
  adminStatusOverride: z.union([z.enum(["PAUSED", "CLOSED"]), z.null()]).optional(),
  waitlistEnabled: z.boolean().optional(),
  reason: reasonSchema,
});
router.post("/admin/fundbook/capacity", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const parsed = upsertCapacitySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_BODY" });
    return;
  }
  try {
    const { reason, ...args } = parsed.data;
    const limit = await upsertCapacityLimit(admin, args, reason);
    res.json({ ok: true, limit });
  } catch (e) {
    handleError(res, e);
  }
});

export { router as adminFundControlsRouter };
