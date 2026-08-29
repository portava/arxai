// Capability #52 — Admin compliance-eligibility review surface.
//
// broker_eligibility previously had NO write surface at all: rows could only
// exist by hand, so the fail-closed dispatch consult (gate #3 compliance
// check in liveCommandPipeline) would hold every user forever with no lawful
// way to record a review. This router is that owner-press machinery.
//
// Routes:
//   GET /api/admin/compliance/eligibility            — list reviews (+?userId=)
//   PUT /api/admin/compliance/eligibility            — record/update ONE review
//
// SAFETY:
//   * ADMIN/OWNER only (normalizeProductRole on the effective role, so an
//     admin previewing-as-user is refused).
//   * Status vocabulary is validated against BROKER_ELIGIBILITY_STATUSES —
//     an unknown status is a 400, never stored.
//   * INVIOLABLE (blueprint §70 ~L2817): relationshipToMaster=OUTSIDE_CLIENT
//     REFUSES any status other than COMPLIANCE_HOLD with a 422. Engineering
//     cannot decide whether outside-client management is lawful; this route
//     will not record a review that pretends otherwise.
//   * Every mutation writes admin_action_audit_log (before/after states).
//   * This router grants no live authority by itself: the review it records
//     is ONE input to gate #3; every other Phase B gate still applies.

import express, { type IRouter, Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  brokerEligibilityTable,
  adminActionAuditLogTable,
  BROKER_ELIGIBILITY_STATUSES,
} from "@workspace/db";
import { normalizeProductRole, isAdminProductRole } from "../lib/auth/productRole.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();
router.use(express.json());

function requireAdmin(req: Request, res: Response): { id: number; role: string } | null {
  const sess = (req as Request & { authUser?: { id: number; role?: string } }).authUser;
  if (!sess?.id) {
    res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
    return null;
  }
  const role = normalizeProductRole(sess.role);
  if (!isAdminProductRole(role)) {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" });
    return null;
  }
  return { id: sess.id, role };
}

async function tryAudit(args: {
  adminId: number; adminRole: string; action: string;
  targetUserId: number | null;
  before?: Record<string, unknown> | null; after?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await db.insert(adminActionAuditLogTable).values({
      adminId: args.adminId,
      adminRole: args.adminRole,
      action: args.action,
      targetUserId: args.targetUserId,
      beforeState: (args.before ?? {}) as Record<string, unknown>,
      afterState: (args.after ?? {}) as Record<string, unknown>,
    });
  } catch (err) {
    logger.warn({ err, action: args.action }, "admin_compliance_audit_write_failed");
  }
}

const RELATIONSHIPS = [
  "SELF",
  "SAME_ENTITY_OPERATOR",
  "EMPLOYEE_OF_OWNER",
  "OUTSIDE_CLIENT",
] as const;

const reviewSchema = z.object({
  userId: z.number().int().positive(),
  venueCode: z.string().min(1).max(32),
  eligibilityStatus: z.enum(BROKER_ELIGIBILITY_STATUSES),
  legalResidency: z.string().min(1).max(128).nullable().optional(),
  beneficialOwner: z.string().min(1).max(256).nullable().optional(),
  relationshipToMaster: z.enum(RELATIONSHIPS).nullable().optional(),
  reasons: z.array(z.string().min(1).max(128)).max(32).optional(),
});

// GET /api/admin/compliance/eligibility?userId=
router.get("/admin/compliance/eligibility", async (req: Request, res: Response): Promise<void> => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  try {
    const userIdRaw = req.query["userId"];
    const userId = typeof userIdRaw === "string" && /^\d+$/.test(userIdRaw)
      ? Number(userIdRaw)
      : null;
    const rows = userId != null
      ? await db.select().from(brokerEligibilityTable)
          .where(eq(brokerEligibilityTable.userId, userId))
      : await db.select().from(brokerEligibilityTable);
    res.json({ ok: true, reviews: rows, statuses: BROKER_ELIGIBILITY_STATUSES });
  } catch (err) {
    logger.warn({ err }, "admin_compliance_eligibility_list_failed");
    res.status(500).json({ ok: false, error: "ELIGIBILITY_READ_FAILED" });
  }
});

// PUT /api/admin/compliance/eligibility — record/update one user × venue review.
router.put("/admin/compliance/eligibility", async (req: Request, res: Response): Promise<void> => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_REVIEW", detail: parsed.error.issues });
    return;
  }
  const body = parsed.data;

  // INVIOLABLE — an outside-client relationship may only ever be recorded as
  // COMPLIANCE_HOLD (blueprint §70 ~L2817). Refuse loudly, never coerce.
  if (body.relationshipToMaster === "OUTSIDE_CLIENT" && body.eligibilityStatus !== "COMPLIANCE_HOLD") {
    res.status(422).json({
      ok: false,
      error: "OUTSIDE_CLIENT_REQUIRES_COMPLIANCE_HOLD",
      message:
        "OUTSIDE_CLIENT relationships remain COMPLIANCE_HOLD until jurisdiction-specific "
        + "counsel and broker approval are documented. This route will not record otherwise.",
    });
    return;
  }

  try {
    const [existing] = await db.select().from(brokerEligibilityTable)
      .where(and(
        eq(brokerEligibilityTable.userId, body.userId),
        eq(brokerEligibilityTable.venueCode, body.venueCode),
      )).limit(1);

    const patch = {
      eligibilityStatus: body.eligibilityStatus,
      legalResidency: body.legalResidency ?? existing?.legalResidency ?? null,
      beneficialOwner: body.beneficialOwner ?? existing?.beneficialOwner ?? null,
      relationshipToMaster: body.relationshipToMaster ?? existing?.relationshipToMaster ?? null,
      reasons: body.reasons ?? existing?.reasons ?? [],
      reviewedBy: admin.id,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    };

    const [row] = existing
      ? await db.update(brokerEligibilityTable).set(patch)
          .where(eq(brokerEligibilityTable.id, existing.id)).returning()
      : await db.insert(brokerEligibilityTable).values({
          userId: body.userId,
          venueCode: body.venueCode,
          ...patch,
        }).returning();

    await tryAudit({
      adminId: admin.id,
      adminRole: admin.role,
      action: "COMPLIANCE_ELIGIBILITY_REVIEW",
      targetUserId: body.userId,
      before: existing ? { eligibilityStatus: existing.eligibilityStatus, relationshipToMaster: existing.relationshipToMaster } : null,
      after: { eligibilityStatus: row.eligibilityStatus, venueCode: row.venueCode, relationshipToMaster: row.relationshipToMaster },
    });

    res.json({ ok: true, review: row });
  } catch (err) {
    logger.warn({ err, userId: body.userId, venueCode: body.venueCode },
      "admin_compliance_eligibility_write_failed");
    res.status(500).json({ ok: false, error: "ELIGIBILITY_WRITE_FAILED" });
  }
});

export default router;
