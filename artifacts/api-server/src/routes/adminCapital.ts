// ARX Fund Book — admin-only capital movement operator endpoints (Task #132).
//
// SAFETY (inviolable):
// - Admin-only (role ∈ {ADMIN, OWNER}). Admin-previewing-as-user is downgraded
//   upstream and lands in the 403 branch here too.
// - Every mutation is FAIL-CLOSED audited inside the service's db.transaction:
//   the mutation and its admin_action_audit_log row commit together or not at
//   all. Every mutation requires a reason (≥3 chars).
// - These routes NEVER touch any execution path, lot sizing, the 16-gate live
//   pipeline, kill switch, or any broker dispatch surface. Settlement issues /
//   redeems UNITS via the Fund Book NAV engine at the official NAV only.
// - No guaranteed-return wording anywhere.

import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import {
  CapitalError,
  getCapitalSettings,
  listSpeedTiers,
  updateCapitalSettings,
  upsertSpeedTier,
  listAllRequests,
  approveRequest,
  rejectRequest,
  settleRequest,
  chargePeriodicFee,
  listFeeEntries,
  setAllocationLock,
  type Admin,
} from "../lib/fundbook/capitalMovements.js";
import { FundControlError } from "../lib/fundbook/fundControls.js";
import {
  FEE_MODES,
  FEE_TYPES,
  DISCLOSURE_TYPES,
  DEFAULT_WITHDRAWAL_PRIORITY,
} from "@workspace/db";

const router = Router();

function requireAdmin(req: Request, res: Response): Admin | null {
  const u = (req as Request & { authUser?: { id?: number; role?: string } }).authUser;
  if (!u?.id) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return null; }
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
  if (e instanceof CapitalError) {
    res.status(e.httpStatus).json({ ok: false, error: e.code });
    return;
  }
  const msg = e instanceof Error ? e.message : "CAPITAL_ERROR";
  res.status(400).json({ ok: false, error: msg });
}

const reasonSchema = z.string().trim().min(3, "reason must be at least 3 characters");

// ── GET /admin/capital/settings ─────────────────────────────────────────────
router.get("/admin/capital/settings", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const [settings, depositTiers, withdrawalTiers] = await Promise.all([
    getCapitalSettings(),
    listSpeedTiers("DEPOSIT"),
    listSpeedTiers("WITHDRAWAL"),
  ]);
  res.json({ ok: true, settings, depositTiers, withdrawalTiers });
});

const settingsPatchSchema = z.object({
  patch: z.object({
    navCutoffHour: z.number().int().min(0).max(23).optional(),
    navCutoffMinute: z.number().int().min(0).max(59).optional(),
    navCutoffTimezone: z.string().trim().min(1).optional(),
    depositLockDays: z.number().int().min(0).max(3650).optional(),
    withdrawalPriority: z.array(z.string().trim().min(1)).optional(),
    managementFeeAnnualPct: z.number().min(0).max(100).optional(),
    performanceFeePct: z.number().min(0).max(100).optional(),
    liquidityFeePct: z.number().min(0).max(100).optional(),
    minDepositAmount: z.number().min(0).optional(),
    minWithdrawalAmount: z.number().min(0).optional(),
    disclosureVersion: z.string().trim().min(1).optional(),
  }),
  reason: reasonSchema,
});

// ── PUT /admin/capital/settings ─────────────────────────────────────────────
router.put("/admin/capital/settings", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const parsed = settingsPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION", detail: parsed.error.issues });
    return;
  }
  try {
    const settings = await updateCapitalSettings(admin, parsed.data.patch, parsed.data.reason);
    res.json({ ok: true, settings });
  } catch (e) {
    handleError(res, e);
  }
});

const speedTierSchema = z.object({
  tier: z.object({
    movementType: z.enum(["DEPOSIT", "WITHDRAWAL"]),
    tierKey: z.string().trim().min(1),
    label: z.string().trim().min(1),
    description: z.string().trim().max(500).nullable().optional(),
    feeMode: z.enum(FEE_MODES),
    flatFee: z.number().min(0),
    percentageFee: z.number().min(0).max(100),
    minFee: z.number().min(0).nullable().optional(),
    maxFee: z.number().min(0).nullable().optional(),
    slaLabel: z.string().trim().max(120).nullable().optional(),
    estimatedHours: z.number().int().min(0).nullable().optional(),
    requiresDisclosure: z.boolean().optional(),
    disclosureType: z.enum(DISCLOSURE_TYPES).nullable().optional(),
    sortOrder: z.number().int().min(0).optional(),
    active: z.boolean().optional(),
  }),
  reason: reasonSchema,
});

// ── PUT /admin/capital/speed-tiers ──────────────────────────────────────────
router.put("/admin/capital/speed-tiers", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const parsed = speedTierSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION", detail: parsed.error.issues });
    return;
  }
  try {
    const tier = await upsertSpeedTier(admin, parsed.data.tier, parsed.data.reason);
    res.json({ ok: true, tier });
  } catch (e) {
    handleError(res, e);
  }
});

// ── GET /admin/capital/requests ─────────────────────────────────────────────
router.get("/admin/capital/requests", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const movementType =
    req.query.movementType === "DEPOSIT" || req.query.movementType === "WITHDRAWAL"
      ? req.query.movementType
      : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const userId =
    typeof req.query.userId === "string" && Number.isInteger(Number(req.query.userId))
      ? Number(req.query.userId)
      : undefined;
  const requests = await listAllRequests({ movementType, status, userId });
  res.json({ ok: true, requests });
});

const reviewSchema = z.object({
  reason: reasonSchema,
  reviewNote: z.string().trim().max(1000).nullable().optional(),
});

// ── POST /admin/capital/requests/:id/approve ────────────────────────────────
router.post("/admin/capital/requests/:id/approve", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ ok: false, error: "BAD_ID" }); return; }
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION", detail: parsed.error.issues });
    return;
  }
  try {
    const request = await approveRequest(admin, id, parsed.data.reason, parsed.data.reviewNote);
    res.json({ ok: true, request });
  } catch (e) {
    handleError(res, e);
  }
});

// ── POST /admin/capital/requests/:id/reject ─────────────────────────────────
router.post("/admin/capital/requests/:id/reject", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ ok: false, error: "BAD_ID" }); return; }
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION", detail: parsed.error.issues });
    return;
  }
  try {
    const request = await rejectRequest(admin, id, parsed.data.reason, parsed.data.reviewNote);
    res.json({ ok: true, request });
  } catch (e) {
    handleError(res, e);
  }
});

const settleSchema = z.object({ reason: reasonSchema });

// ── POST /admin/capital/requests/:id/settle ─────────────────────────────────
router.post("/admin/capital/requests/:id/settle", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ ok: false, error: "BAD_ID" }); return; }
  const parsed = settleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION", detail: parsed.error.issues });
    return;
  }
  try {
    const request = await settleRequest(admin, id, parsed.data.reason);
    res.json({ ok: true, request });
  } catch (e) {
    handleError(res, e);
  }
});

const periodicFeeSchema = z.object({
  userId: z.number().int().positive(),
  poolKey: z.string().trim().min(1),
  feeType: z.enum(["MANAGEMENT", "PERFORMANCE"]),
  annualPct: z.number().min(0).max(100).optional(),
  periodDays: z.number().int().min(0).max(3650).optional(),
  performancePct: z.number().min(0).max(100).optional(),
  reason: reasonSchema,
});

// ── POST /admin/capital/fees/charge ─────────────────────────────────────────
router.post("/admin/capital/fees/charge", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const parsed = periodicFeeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION", detail: parsed.error.issues });
    return;
  }
  try {
    const result = await chargePeriodicFee(admin, parsed.data);
    res.json({ ok: true, ...result });
  } catch (e) {
    handleError(res, e);
  }
});

// ── GET /admin/capital/fees ─────────────────────────────────────────────────
router.get("/admin/capital/fees", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const userId =
    typeof req.query.userId === "string" && Number.isInteger(Number(req.query.userId))
      ? Number(req.query.userId)
      : undefined;
  const feeType = FEE_TYPES.includes(req.query.feeType as (typeof FEE_TYPES)[number])
    ? (req.query.feeType as (typeof FEE_TYPES)[number])
    : undefined;
  const fees = await listFeeEntries({ userId, feeType });
  res.json({ ok: true, fees });
});

const allocationLockSchema = z.object({
  userId: z.number().int().positive(),
  locked: z.boolean(),
  reason: reasonSchema,
});

// ── POST /admin/capital/allocation-lock ─────────────────────────────────────
router.post("/admin/capital/allocation-lock", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const parsed = allocationLockSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION", detail: parsed.error.issues });
    return;
  }
  try {
    const preferences = await setAllocationLock(
      admin,
      parsed.data.userId,
      parsed.data.locked,
      parsed.data.reason,
    );
    res.json({ ok: true, preferences });
  } catch (e) {
    handleError(res, e);
  }
});

// ── GET /admin/capital/defaults ─────────────────────────────────────────────
// Surface the default withdrawal-priority order so the operator UI can offer a
// "reset to default" affordance without hardcoding it client-side.
router.get("/admin/capital/defaults", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  res.json({ ok: true, defaultWithdrawalPriority: [...DEFAULT_WITHDRAWAL_PRIORITY] });
});

export { router as adminCapitalRouter };
