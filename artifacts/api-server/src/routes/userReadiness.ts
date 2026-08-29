// Per-user Readiness & Onboarding routes.
//
// SAFETY:
// - All user routes require `requireUser` and scope every query by req.authUser.id.
// - Admin routes require role ADMIN or OWNER on the authenticated user.
// - No secrets are returned. No live execution is performed. No mutation of
//   safetyCore / live_trading_state / canPlaceTrades.

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod/v4";
import { db } from "@workspace/db";
import {
  userReadinessStateTable,
  userLiveDisclosureAcceptancesTable,
  userReadinessAuditTable,
  userOnboardingProgressTable,
  usersTable,
} from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import {
  evaluateUserReadiness, getOrCreateReadinessState, listUsersReadinessSummary,
} from "../lib/userReadiness/engine.js";

const router = Router();

function envelope(payload: Record<string, unknown>) {
  return {
    system: "userReadiness",
    appMode: "PAPER_ONLY" as const,
    liveTradingStatus: "DISABLED" as const,
    canPlaceLiveTrade: false,
    disclaimer:
      "Readiness is informational. Live execution authority is governed independently by the per-user activation gate and the 23-gate Phase B dispatch — this report never enables live trading. Live readiness is reported only for an admin-approved, armed, eligible trader; everyone else stays demo/paper.",
    ...payload,
  };
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const u = req.authUser;
  if (!u) { res.status(401).json(envelope({ error: "unauthenticated" })); return; }
  const role = (u as { role?: string }).role;
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json(envelope({ error: "forbidden", reason: "admin role required" }));
    return;
  }
  next();
}

function clientMeta(req: Request): { ipAddress: string | null; userAgent: string | null } {
  const ipAddress = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
    ?? req.socket?.remoteAddress
    ?? null;
  const userAgent = (req.headers["user-agent"] as string | undefined) ?? null;
  return { ipAddress: ipAddress ?? null, userAgent: userAgent ?? null };
}

// ── User: readiness ─────────────────────────────────────────────────────────
router.get("/readiness/me", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  try {
    await getOrCreateReadinessState(userId);
    const report = await evaluateUserReadiness(userId);
    res.json(envelope({ ok: true, report }));
  } catch (e) {
    res.status(500).json(envelope({ ok: false, error: "readiness_eval_failed", reason: (e as Error).message.slice(0, 200) }));
  }
});

router.get("/readiness/me/blockers", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  try {
    const report = await evaluateUserReadiness(userId);
    const failing = report.statuses.filter(s => s.status === "fail" || s.status === "blocked");
    res.json(envelope({
      ok: true,
      blockers: report.blockers,
      ready_for_paper: report.ready_for_paper,
      ready_for_demo: report.ready_for_demo,
      ready_for_live: report.ready_for_live,
      failing: failing.map(s => ({
        id: s.id, label: s.label, status: s.status,
        explanation: s.userFriendlyExplanation, nextStep: s.nextStep,
      })),
    }));
  } catch (e) {
    res.status(500).json(envelope({ ok: false, error: "blockers_failed", reason: (e as Error).message.slice(0, 200) }));
  }
});

// ── User: onboarding progress ────────────────────────────────────────────
router.get("/onboarding/me/progress", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  try {
    const [onb] = await db.select().from(userOnboardingProgressTable)
      .where(eq(userOnboardingProgressTable.userId, userId)).limit(1);
    const report = await evaluateUserReadiness(userId);
    const total = report.statuses.length;
    const passed = report.statuses.filter(s => s.status === "pass" || s.status === "not_required").length;
    const percent = total > 0 ? Math.round((passed / total) * 100) : 0;
    const nextItem = report.statuses.find(s => s.status === "fail" || s.status === "blocked");
    res.json(envelope({
      ok: true,
      progress: {
        percent,
        passed,
        total,
        currentStage: nextItem?.id ?? "complete",
        nextStep: nextItem?.nextStep ?? null,
        onboardingStatus: onb?.status ?? "NOT_STARTED",
        completedSteps: onb?.completedSteps ?? [],
        walkthroughCompleted: onb?.walkthroughCompleted ?? false,
      },
    }));
  } catch (e) {
    res.status(500).json(envelope({ ok: false, error: "progress_failed", reason: (e as Error).message.slice(0, 200) }));
  }
});

// ── User: accept disclosure ──────────────────────────────────────────────
const AcceptDisclosureBody = z.object({
  disclosureType: z.enum(["TRADING_RISK", "LIVE_TRADING", "SHARED_MASTER"]),
  version: z.string().min(1).max(64),
  contentHash: z.string().min(1).max(128).optional(),
});

router.post("/onboarding/me/accept-disclosure", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const p = AcceptDisclosureBody.safeParse(req.body);
  if (!p.success) { res.status(400).json(envelope({ ok: false, error: "invalid_body", details: p.error.issues })); return; }
  const { disclosureType, version, contentHash } = p.data;
  const meta = clientMeta(req);
  try {
    await getOrCreateReadinessState(userId);
    await db.insert(userLiveDisclosureAcceptancesTable).values({
      userId, disclosureType, version,
      contentHash: contentHash ?? null,
      ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    });
    const now = new Date();
    const patch: Partial<typeof userReadinessStateTable.$inferInsert> = { updatedAt: now };
    if (disclosureType === "TRADING_RISK") patch.tradingDisclaimerAcceptedAt = now;
    if (disclosureType === "LIVE_TRADING") { patch.liveDisclosureAcceptedAt = now; patch.liveDisclosureVersion = version; }
    if (disclosureType === "SHARED_MASTER") patch.sharedMasterDisclosureAcceptedAt = now;
    await db.update(userReadinessStateTable).set(patch).where(eq(userReadinessStateTable.userId, userId));
    await db.insert(userReadinessAuditTable).values({
      userId, actorUserId: userId, action: "ACCEPT_DISCLOSURE",
      newValue: { disclosureType, version }, ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    });
    res.json(envelope({ ok: true, disclosureType, version, acceptedAt: now.toISOString() }));
  } catch (e) {
    res.status(500).json(envelope({ ok: false, error: "accept_failed", reason: (e as Error).message.slice(0, 200) }));
  }
});

// ── User: set account routing mode ───────────────────────────────────────
const AccountModeBody = z.object({
  // "DEMO" = paper/system-default (no broker bridge required, no shared master).
  // "USER_OWNED_MT5" = user connects their own MT5 terminal via the bridge.
  // "SHARED_MASTER_MT5" = user routes through the admin-managed shared master
  //   account; starts as pending-approval and remains live-blocked until admin
  //   approval + allocation + risk profile + Phase B gates all PASS.
  accountMode: z.enum(["DEMO", "USER_OWNED_MT5", "SHARED_MASTER_MT5"]),
});

router.post("/onboarding/me/account-mode", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const p = AccountModeBody.safeParse(req.body);
  if (!p.success) { res.status(400).json(envelope({ ok: false, error: "invalid_body", details: p.error.issues })); return; }
  const meta = clientMeta(req);
  try {
    const prev = await getOrCreateReadinessState(userId);
    await db.update(userReadinessStateTable)
      .set({ accountMode: p.data.accountMode, updatedAt: new Date() })
      .where(eq(userReadinessStateTable.userId, userId));
    await db.insert(userReadinessAuditTable).values({
      userId, actorUserId: userId, action: "SET_ACCOUNT_MODE",
      oldValue: { accountMode: prev.accountMode }, newValue: { accountMode: p.data.accountMode },
      ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    });
    res.json(envelope({ ok: true, accountMode: p.data.accountMode }));
  } catch (e) {
    res.status(500).json(envelope({ ok: false, error: "mode_failed", reason: (e as Error).message.slice(0, 200) }));
  }
});

// ── Admin: list users readiness ──────────────────────────────────────────
router.get("/admin/readiness/users", requireUser, requireAdmin, async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 200)));
  try {
    const rows = await listUsersReadinessSummary(limit);
    res.json(envelope({ ok: true, count: rows.length, users: rows }));
  } catch (e) {
    res.status(500).json(envelope({ ok: false, error: "admin_list_failed", reason: (e as Error).message.slice(0, 200) }));
  }
});

// ── Admin: approve live (one gate of many) ───────────────────────────────
const TargetParam = z.object({ userId: z.coerce.number().int().positive() });

router.post("/admin/readiness/users/:userId/approve-live", requireUser, requireAdmin, async (req, res) => {
  const p = TargetParam.safeParse(req.params);
  if (!p.success) { res.status(400).json(envelope({ ok: false, error: "invalid_userId" })); return; }
  const targetId = p.data.userId;
  const actorId = req.authUser!.id;
  const meta = clientMeta(req);
  try {
    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, targetId)).limit(1);
    if (!target) { res.status(404).json(envelope({ ok: false, error: "user_not_found" })); return; }
    await getOrCreateReadinessState(targetId);
    // Pre-check: refuse approval if upstream live gates aren't satisfied.
    const report = await evaluateUserReadiness(targetId);
    const liveDisclosureOk = report.statuses.find(s => s.id === "trading_disclaimer_accepted")?.status === "pass";
    const liveAccountVerified = report.statuses.find(s => s.id === "live_account_verified")?.status === "pass";
    if (!liveDisclosureOk || !liveAccountVerified) {
      res.status(409).json(envelope({
        ok: false, error: "live_prereqs_missing",
        reason: "Admin approval cannot be granted until the user accepts the disclosure and a live account is verified.",
        liveDisclosureOk, liveAccountVerified,
      }));
      return;
    }
    const prev = await db.select().from(userReadinessStateTable)
      .where(eq(userReadinessStateTable.userId, targetId)).limit(1);
    await db.update(userReadinessStateTable).set({
      liveAdminApproved: true,
      liveAdminApprovedAt: new Date(),
      liveAdminApprovedBy: actorId,
      liveAdminRevokedAt: null,
      liveAdminRevokeReason: null,
      updatedAt: new Date(),
    }).where(eq(userReadinessStateTable.userId, targetId));
    await db.insert(userReadinessAuditTable).values({
      userId: targetId, actorUserId: actorId, action: "APPROVE_LIVE",
      oldValue: { liveAdminApproved: prev[0]?.liveAdminApproved ?? false },
      newValue: { liveAdminApproved: true },
      ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    });
    res.json(envelope({
      ok: true, targetUserId: targetId, liveAdminApproved: true,
      note: "Approval recorded. Live trading remains blocked by other gates (disclosure version, verified live routing, user confirm, Risk Governor, system-wide PAPER_ONLY hard-lock).",
    }));
  } catch (e) {
    res.status(500).json(envelope({ ok: false, error: "approve_failed", reason: (e as Error).message.slice(0, 200) }));
  }
  void and;
});

router.post("/admin/readiness/users/:userId/revoke-live", requireUser, requireAdmin, async (req, res) => {
  const p = TargetParam.safeParse(req.params);
  if (!p.success) { res.status(400).json(envelope({ ok: false, error: "invalid_userId" })); return; }
  const targetId = p.data.userId;
  const actorId = req.authUser!.id;
  const meta = clientMeta(req);
  const reason = typeof req.body?.reason === "string" ? String(req.body.reason).slice(0, 500) : null;
  try {
    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, targetId)).limit(1);
    if (!target) { res.status(404).json(envelope({ ok: false, error: "user_not_found" })); return; }
    await getOrCreateReadinessState(targetId);
    await db.update(userReadinessStateTable).set({
      liveAdminApproved: false,
      liveAdminRevokedAt: new Date(),
      liveAdminRevokeReason: reason,
      updatedAt: new Date(),
    }).where(eq(userReadinessStateTable.userId, targetId));
    await db.insert(userReadinessAuditTable).values({
      userId: targetId, actorUserId: actorId, action: "REVOKE_LIVE",
      newValue: { liveAdminApproved: false, reason },
      ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    });
    res.json(envelope({ ok: true, targetUserId: targetId, liveAdminApproved: false }));
  } catch (e) {
    res.status(500).json(envelope({ ok: false, error: "revoke_failed", reason: (e as Error).message.slice(0, 200) }));
  }
});

export default router;
