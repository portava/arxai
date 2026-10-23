// ── T019 — Admin Risk/Governance read + write ───────────────────────────────
//
//   GET  /api/admin/governance?userId=<id>
//     Returns the effective governance for the target user (defaults to the
//     calling admin's own id) including the flat effective values AND the
//     detailed policy list the Admin Governance UI renders.
//
//   PATCH /api/admin/governance?userId=<id>
//     Body: a subset of ownerGovernancePatchSchema. Upserts the per-user
//     owner_governance_settings row, writes an admin_action_audit_log row, and
//     returns the freshly-resolved effective governance. NEVER places a trade
//     and NEVER relaxes a permanent technical/security/broker-truth check —
//     this table only carries app-added policy toggles.
//
// SAFETY: ADMIN/OWNER session required. An admin previewing-as-user is
// auto-downgraded by attachAuthUser and lands in the 403 branch.

import express, { type IRouter, Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  ownerGovernanceSettingsTable,
  adminActionAuditLogTable,
  ownerGovernancePatchSchema,
} from "@workspace/db";
import {
  getEffectiveTradingGovernance,
  loadOwnerGovernanceRow,
} from "../lib/governance/effectiveGovernance.js";

const router: IRouter = Router();
router.use(express.json());

function requireAdmin(req: Request, res: Response): { id: number; role: "ADMIN" | "OWNER" } | null {
  const sess = (req as Request & { authUser?: { id: number; role?: string } }).authUser;
  if (!sess?.id) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return null; }
  const role = sess.role ?? null;
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" });
    return null;
  }
  return { id: sess.id, role: role as "ADMIN" | "OWNER" };
}

function resolveTargetUserId(req: Request, fallbackId: number): number {
  const raw = req.query.userId ?? (req.body as Record<string, unknown> | undefined)?.userId;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallbackId;
}

router.get("/admin/governance", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const targetUserId = resolveTargetUserId(req, admin.id);
  const effective = await getEffectiveTradingGovernance(targetUserId, "LIVE_SHARED_BRIDGE");
  const stored = await loadOwnerGovernanceRow(targetUserId);
  res.json({ ok: true, targetUserId, stored, effective });
});

router.patch("/admin/governance", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const targetUserId = resolveTargetUserId(req, admin.id);

  const body = (req.body ?? {}) as Record<string, unknown>;
  // Strip routing-only keys before validating the policy patch.
  delete body.userId;
  const parsed = ownerGovernancePatchSchema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_PATCH", issues: parsed.error.issues });
    return;
  }
  if (Object.keys(parsed.data).length === 0) {
    res.status(400).json({ ok: false, error: "EMPTY_PATCH", detail: "Send at least one governance field." });
    return;
  }

  const before = await loadOwnerGovernanceRow(targetUserId);

  await db.transaction(async (tx) => {
    if (before) {
      await tx.update(ownerGovernanceSettingsTable)
        .set({ ...parsed.data, updatedBy: admin.id, updatedAt: new Date() })
        .where(eq(ownerGovernanceSettingsTable.userId, targetUserId));
    } else {
      await tx.insert(ownerGovernanceSettingsTable)
        .values({ userId: targetUserId, ...parsed.data, updatedBy: admin.id });
    }
    await tx.insert(adminActionAuditLogTable).values({
      adminId: admin.id, adminRole: admin.role,
      action: "ADMIN_UPDATED_GOVERNANCE",
      beforeState: { targetUserId, stored: before ?? null },
      afterState: { targetUserId, patch: parsed.data, didPlaceTrade: false },
    });
  });

  const effective = await getEffectiveTradingGovernance(targetUserId, "LIVE_SHARED_BRIDGE");
  const stored = await loadOwnerGovernanceRow(targetUserId);
  res.json({
    ok: true, targetUserId, stored, effective,
    safety: {
      didPlaceTrade: false,
      sixteenGateStillEnforced: true,
      killSwitchStillEnforced: true,
      manualConfirmationStillRequired: true,
      brokerTruthStillEnforced: true,
    },
  });
});

export default router;
