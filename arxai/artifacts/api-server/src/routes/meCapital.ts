// ARX Fund Book — investor-scoped capital movement endpoints (Task #132).
//
// SAFETY (inviolable):
// - STRICTLY per-user. Every request/fee/lock read is scoped by req.authUser.id.
//   No row from investor A is ever returned to investor B.
// - NEVER touches any execution path, lot sizing, the 16-gate live pipeline,
//   kill switch, or any broker dispatch surface. Units are issued/redeemed by
//   the Fund Book NAV engine at the official NAV only — never a discounted NAV.
// - Investors create requests; only admins approve/settle. No guaranteed-return
//   wording anywhere.

import { Router, type Request } from "express";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import {
  CapitalError,
  getCapitalSettings,
  listSpeedTiers,
  getInvestorValuation,
  previewDeposit,
  previewWithdrawal,
  createDepositRequest,
  createWithdrawalRequest,
  listInvestorRequests,
  getInvestorRequest,
  listInvestorFeeEntries,
  listInvestorLocks,
  cancelRequest,
  getPreferences,
  setPreferences,
  recordDisclosureAck,
  listDisclosureAcks,
} from "../lib/fundbook/capitalMovements.js";
import { FundControlError } from "../lib/fundbook/fundControls.js";
import { DISCLOSURE_TYPES } from "@workspace/db";

const router = Router();

function uid(req: Request): number | null {
  return (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;
}

function handleError(res: import("express").Response, e: unknown): void {
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

// ── GET /me/capital/settings ────────────────────────────────────────────────
// Public-to-investor view of the active policy: NAV cutoff, lock window,
// withdrawal priority, fee rates, and the active speed tiers.
router.get("/me/capital/settings", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }
  const settings = await getCapitalSettings();
  const [depositTiers, withdrawalTiers] = await Promise.all([
    listSpeedTiers("DEPOSIT"),
    listSpeedTiers("WITHDRAWAL"),
  ]);
  res.json({
    ok: true,
    settings: {
      navCutoffHour: settings.navCutoffHour,
      navCutoffMinute: settings.navCutoffMinute,
      navCutoffTimezone: settings.navCutoffTimezone,
      depositLockDays: settings.depositLockDays,
      withdrawalPriority: settings.withdrawalPriority,
      managementFeeAnnualPct: settings.managementFeeAnnualPct,
      performanceFeePct: settings.performanceFeePct,
      liquidityFeePct: settings.liquidityFeePct,
      minDepositAmount: settings.minDepositAmount,
      minWithdrawalAmount: settings.minWithdrawalAmount,
      disclosureVersion: settings.disclosureVersion,
    },
    depositTiers,
    withdrawalTiers,
  });
});

// ── GET /me/capital/available ───────────────────────────────────────────────
// The caller's valuation: total value, locked principal, withdrawable, reserved.
router.get("/me/capital/available", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }
  const valuation = await getInvestorValuation(userId);
  res.json({ ok: true, valuation });
});

const depositPreviewSchema = z.object({
  grossAmount: z.number().positive(),
  speedTierKey: z.string().trim().min(1),
});

// ── POST /me/capital/deposit/preview ────────────────────────────────────────
router.post("/me/capital/deposit/preview", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }
  const parsed = depositPreviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION", detail: parsed.error.issues });
    return;
  }
  try {
    const preview = await previewDeposit(parsed.data);
    res.json({
      ok: true,
      grossAmount: preview.grossAmount,
      speedFee: preview.speedFee,
      totalFee: preview.totalFee,
      netAmount: preview.netAmount,
      tierKey: preview.tier.tierKey,
      requiresDisclosure: preview.tier.requiresDisclosure,
      disclosureType: preview.tier.disclosureType,
    });
  } catch (e) {
    handleError(res, e);
  }
});

const depositSubmitSchema = depositPreviewSchema.extend({
  targetPoolKey: z.string().trim().min(1).optional(),
  requestNote: z.string().trim().max(1000).optional(),
  acknowledgeDisclosures: z.boolean().optional(),
});

// ── POST /me/capital/deposit ────────────────────────────────────────────────
router.post("/me/capital/deposit", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }
  const parsed = depositSubmitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION", detail: parsed.error.issues });
    return;
  }
  try {
    const request = await createDepositRequest({ userId, ...parsed.data });
    res.json({ ok: true, request });
  } catch (e) {
    handleError(res, e);
  }
});

const withdrawalPreviewSchema = z.object({
  grossAmount: z.number().nonnegative(),
  speedTierKey: z.string().trim().min(1),
  isFullExit: z.boolean().optional(),
});

// ── POST /me/capital/withdrawal/preview ─────────────────────────────────────
router.post("/me/capital/withdrawal/preview", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }
  const parsed = withdrawalPreviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION", detail: parsed.error.issues });
    return;
  }
  try {
    const preview = await previewWithdrawal({ userId, ...parsed.data });
    res.json({
      ok: true,
      grossAmount: preview.grossAmount,
      speedFee: preview.speedFee,
      liquidityFee: preview.liquidityFee,
      performanceFee: preview.performanceFee,
      totalFee: preview.totalFee,
      netAmount: preview.netAmount,
      availableForWithdrawal: preview.availableForWithdrawal,
      fullyCovered: preview.fullyCovered,
      tierKey: preview.tier.tierKey,
      requiresDisclosure: preview.tier.requiresDisclosure,
      disclosureType: preview.tier.disclosureType,
    });
  } catch (e) {
    handleError(res, e);
  }
});

const withdrawalSubmitSchema = z.object({
  grossAmount: z.number().nonnegative(),
  speedTierKey: z.string().trim().min(1),
  isFullExit: z.boolean().optional(),
  requestNote: z.string().trim().max(1000).optional(),
  acknowledgeDisclosures: z.boolean().optional(),
});

// ── POST /me/capital/withdrawal ─────────────────────────────────────────────
router.post("/me/capital/withdrawal", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }
  const parsed = withdrawalSubmitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION", detail: parsed.error.issues });
    return;
  }
  try {
    const request = await createWithdrawalRequest({ userId, ...parsed.data });
    res.json({ ok: true, request });
  } catch (e) {
    handleError(res, e);
  }
});

// ── GET /me/capital/requests ────────────────────────────────────────────────
router.get("/me/capital/requests", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }
  const movementType =
    req.query.movementType === "DEPOSIT" || req.query.movementType === "WITHDRAWAL"
      ? req.query.movementType
      : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const requests = await listInvestorRequests(userId, { movementType, status });
  res.json({ ok: true, requests });
});

// ── GET /me/capital/requests/:id ────────────────────────────────────────────
router.get("/me/capital/requests/:id", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ ok: false, error: "BAD_ID" }); return; }
  const request = await getInvestorRequest(userId, id);
  if (!request) { res.status(404).json({ ok: false, error: "REQUEST_NOT_FOUND" }); return; }
  res.json({ ok: true, request });
});

// ── POST /me/capital/requests/:id/cancel ────────────────────────────────────
router.post("/me/capital/requests/:id/cancel", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ ok: false, error: "BAD_ID" }); return; }
  try {
    const request = await cancelRequest(userId, id);
    res.json({ ok: true, request });
  } catch (e) {
    handleError(res, e);
  }
});

// ── GET /me/capital/fees ────────────────────────────────────────────────────
router.get("/me/capital/fees", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }
  const fees = await listInvestorFeeEntries(userId);
  res.json({ ok: true, fees });
});

// ── GET /me/capital/locks ───────────────────────────────────────────────────
router.get("/me/capital/locks", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }
  const locks = await listInvestorLocks(userId);
  res.json({ ok: true, locks });
});

// ── GET /me/capital/preferences ─────────────────────────────────────────────
router.get("/me/capital/preferences", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }
  const preferences = await getPreferences(userId);
  res.json({ ok: true, preferences });
});

const preferencesSchema = z.object({
  profitHandling: z.enum(["REINVEST", "PAYOUT", "SPLIT"]).optional(),
  profitPayoutPct: z.number().min(0).max(100).optional(),
  lossControl: z.enum(["NONE", "SOFT_ALERT", "PAUSE_ON_DRAWDOWN"]).optional(),
  maxDrawdownPct: z.number().min(0).max(100).optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});

// ── PUT /me/capital/preferences ─────────────────────────────────────────────
router.put("/me/capital/preferences", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }
  const parsed = preferencesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION", detail: parsed.error.issues });
    return;
  }
  const preferences = await setPreferences(userId, parsed.data);
  res.json({ ok: true, preferences });
});

const ackSchema = z.object({
  disclosureType: z.enum(DISCLOSURE_TYPES),
  version: z.string().trim().min(1),
  capitalMovementRequestId: z.number().int().optional(),
});

// ── POST /me/capital/disclosures/ack ────────────────────────────────────────
router.post("/me/capital/disclosures/ack", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }
  const parsed = ackSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION", detail: parsed.error.issues });
    return;
  }
  await recordDisclosureAck(
    userId,
    parsed.data.disclosureType,
    parsed.data.version,
    parsed.data.capitalMovementRequestId ?? null,
  );
  res.json({ ok: true });
});

// ── GET /me/capital/disclosures ─────────────────────────────────────────────
router.get("/me/capital/disclosures", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }
  const acknowledgments = await listDisclosureAcks(userId);
  res.json({ ok: true, acknowledgments });
});

export { router as meCapitalRouter };
