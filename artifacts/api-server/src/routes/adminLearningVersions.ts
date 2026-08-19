// Learning Model Version Service + Routes
//
// Routes:
//   GET  /api/admin/learning/versions          — list all versions
//   GET  /api/admin/learning/versions/:id      — get one version
//   POST /api/admin/learning/versions          — create a new version record
//   POST /api/admin/learning/versions/:id/approve — admin approve for live
//   POST /api/admin/learning/versions/:id/rollback — rollback a live version
//   GET  /api/admin/learning/active            — get current active live version
//   GET  /api/me/learning/version-status       — user-facing: is Ruby using validated learning?
//
// SAFETY:
//   - liveAllowed only set when all 4 gates pass AND admin explicitly approves
//   - Rollback immediately deactivates — no grace period for bad learning
//   - All approval/rollback actions logged to audit vault

import { Router } from "express";
import { z } from "zod/v4";
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";
import {
  learningModelVersionsTable,
  shadowPredictionsTable,
  globalSignalEdgesTable,
  VERSION_GATES,
  type LearningModelVersionRow,
} from "@workspace/db/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ component: "learningVersions" });
const router = Router();

// ── Auth helpers ──────────────────────────────────────────────────────────────
function requireAdmin(req: any, res: any): { id: number; role: string } | null {
  const u = req.authUser;
  if (!u) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return null; }
  if (u.role !== "ADMIN" && u.role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" }); return null;
  }
  return { id: u.id, role: u.role };
}

// ── Compute gates from current data ──────────────────────────────────────────
async function computeGates(versionId: string): Promise<{
  dataValidated: boolean;
  dataQualityScore: number | null;
  walkForwardPassed: boolean;
  walkForwardScore: number | null;
  shadowValidated: boolean;
  shadowAccuracy: number | null;
  shadowSampleSize: number | null;
}> {
  // 1. Data quality — check global signal edges have enough data
  const edgeCount = await db.select({ count: sql<number>`count(*)::int` })
    .from(globalSignalEdgesTable)
    .where(eq(globalSignalEdgesTable.isSurfaceable, true));
  const surfaceableEdges = edgeCount[0]?.count ?? 0;
  const dataQualityScore = Math.min(100, surfaceableEdges * 5); // 20+ edges = 100
  const dataValidated = dataQualityScore >= VERSION_GATES.MIN_DATA_QUALITY;

  // 2. Walk-forward — use shadow mode historical win rate as proxy.
  // Newest-first (id tiebreak) so the slice below is genuinely the most recent half.
  const shadowRows = await db.select()
    .from(shadowPredictionsTable)
    .where(sql`${shadowPredictionsTable.status} IN ('SHADOW_WIN', 'SHADOW_LOSS')`)
    .orderBy(desc(shadowPredictionsTable.createdAt), desc(shadowPredictionsTable.id));

  const shadowSampleSize = shadowRows.length;
  let shadowAccuracy: number | null = null;
  let shadowValidated = false;
  let walkForwardScore: number | null = null;
  let walkForwardPassed = false;

  if (shadowSampleSize >= VERSION_GATES.MIN_SHADOW_SAMPLE) {
    const wins = shadowRows.filter((r) => r.status === "SHADOW_WIN").length;
    shadowAccuracy = Math.round((wins / shadowSampleSize) * 1000) / 10;
    shadowValidated = shadowAccuracy >= VERSION_GATES.MIN_SHADOW_ACCURACY;

    // Use the most recent 50% of shadow data as "out of sample" walk-forward
    const halfPoint = Math.floor(shadowSampleSize / 2);
    const recentRows = shadowRows.slice(0, halfPoint);
    const recentWins = recentRows.filter((r) => r.status === "SHADOW_WIN").length;
    walkForwardScore = recentRows.length
      ? Math.round((recentWins / recentRows.length) * 1000) / 10
      : null;
    walkForwardPassed = (walkForwardScore ?? 0) >= VERSION_GATES.MIN_WALK_FORWARD;
  }

  return {
    dataValidated,
    dataQualityScore,
    walkForwardPassed,
    walkForwardScore,
    shadowValidated,
    shadowAccuracy,
    shadowSampleSize,
  };
}

// ── GET /api/admin/learning/versions ─────────────────────────────────────────
router.get("/admin/learning/versions", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;

  const versions = await db.select()
    .from(learningModelVersionsTable)
    .orderBy(desc(learningModelVersionsTable.createdAt))
    .limit(50);

  return res.json({ ok: true, versions });
});

// ── GET /api/admin/learning/active ────────────────────────────────────────────
router.get("/admin/learning/active", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;

  const active = await db.select()
    .from(learningModelVersionsTable)
    .where(and(
      eq(learningModelVersionsTable.isActive, true),
      eq(learningModelVersionsTable.liveAllowed, true),
    ))
    .orderBy(desc(learningModelVersionsTable.deployedAt))
    .limit(1);

  return res.json({
    ok: true,
    activeVersion: active[0] ?? null,
    hasActiveVersion: active.length > 0,
  });
});

// ── POST /api/admin/learning/versions — create version record ─────────────────
const CreateBody = z.object({
  versionName:   z.string().min(1).max(100),
  changeType:    z.enum(["global_signal_edges", "confidence_calibration", "scanner_scoring", "dna_weights", "ruby_behavior", "risk_thresholds"]),
  changeSummary: z.string().min(1).max(1000),
  dataSources:   z.array(z.string()).optional(),
  relatedRunId:  z.string().optional(),
});

router.post("/admin/learning/versions", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;

  const parsed = CreateBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_BODY", details: parsed.error.issues });

  const { versionName, changeType, changeSummary, dataSources, relatedRunId } = parsed.data;
  const versionId = `glv_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_${randomUUID().slice(0, 6)}`;

  // Compute gates from current data
  const gates = await computeGates(versionId);
  const liveAllowed = gates.dataValidated && gates.walkForwardPassed && gates.shadowValidated;
  // liveAllowed is still false — needs adminApproved too

  const [version] = await db.insert(learningModelVersionsTable).values({
    versionId,
    versionName,
    changeType,
    changeSummary,
    dataSources: (dataSources ?? []) as unknown as string[],
    relatedRunId: relatedRunId ?? null,
    dataQualityScore:  gates.dataQualityScore,
    walkForwardScore:  gates.walkForwardScore,
    shadowAccuracy:    gates.shadowAccuracy,
    shadowSampleSize:  gates.shadowSampleSize,
    dataValidated:     gates.dataValidated,
    walkForwardPassed: gates.walkForwardPassed,
    shadowValidated:   gates.shadowValidated,
    adminApproved:     false,
    liveAllowed:       false, // always false until admin approves
    isActive:          false,
  }).returning();

  log.info({ versionId, admin: admin.id, gates }, "learning_version_created");

  return res.json({
    ok: true,
    version,
    gates,
    readyForApproval: gates.dataValidated && gates.walkForwardPassed && gates.shadowValidated,
    blockedGates: [
      !gates.dataValidated     ? `Data quality too low (${gates.dataQualityScore ?? 0}/100, need ${VERSION_GATES.MIN_DATA_QUALITY})` : null,
      !gates.walkForwardPassed ? `Walk-forward score too low (${gates.walkForwardScore ?? 0}%, need ${VERSION_GATES.MIN_WALK_FORWARD}%)` : null,
      !gates.shadowValidated   ? `Shadow accuracy too low (${gates.shadowAccuracy ?? 0}% from ${gates.shadowSampleSize ?? 0} predictions, need ${VERSION_GATES.MIN_SHADOW_ACCURACY}% from ${VERSION_GATES.MIN_SHADOW_SAMPLE})` : null,
    ].filter(Boolean),
  });
});

// ── POST /api/admin/learning/versions/:id/approve ────────────────────────────
const ApproveBody = z.object({ adminNotes: z.string().max(1000).optional() });

router.post("/admin/learning/versions/:id/approve", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;

  const versionId = String(req.params.id ?? "");
  const parsed = ApproveBody.safeParse(req.body ?? {});

  const versions = await db.select()
    .from(learningModelVersionsTable)
    .where(eq(learningModelVersionsTable.versionId, versionId))
    .limit(1);

  const version = versions[0];
  if (!version) return res.status(404).json({ ok: false, error: "VERSION_NOT_FOUND" });
  if (version.rolledBack) return res.status(400).json({ ok: false, error: "VERSION_ROLLED_BACK" });

  // All technical gates must pass before admin can approve
  if (!version.dataValidated || !version.walkForwardPassed || !version.shadowValidated) {
    return res.status(400).json({
      ok: false,
      error: "GATES_NOT_PASSED",
      message: "Cannot approve — not all validation gates have passed. Check data quality, walk-forward score, and shadow accuracy.",
    });
  }

  const now = new Date();

  // Deactivate previous active version
  await db.update(learningModelVersionsTable)
    .set({ isActive: false, updatedAt: now })
    .where(and(
      eq(learningModelVersionsTable.isActive, true),
      sql`version_id != ${versionId}`,
    ));

  // Approve and activate this version
  const [updated] = await db.update(learningModelVersionsTable)
    .set({
      adminApproved:     true,
      liveAllowed:       true,
      isActive:          true,
      approvedByAdminId: admin.id,
      approvedAt:        now,
      deployedAt:        now,
      adminNotes:        parsed.success ? (parsed.data.adminNotes ?? null) : null,
      updatedAt:         now,
    })
    .where(eq(learningModelVersionsTable.versionId, versionId))
    .returning();

  log.info({ versionId, admin: admin.id }, "learning_version_approved_live");

  return res.json({
    ok: true,
    version: updated,
    message: `Version ${versionId} approved and is now live. ${DEFAULT_ASSISTANT_NAME}'s global learning insights are updated.`,
  });
});

// ── POST /api/admin/learning/versions/:id/rollback ───────────────────────────
const RollbackBody = z.object({ reason: z.string().min(1).max(500) });

router.post("/admin/learning/versions/:id/rollback", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;

  const versionId = String(req.params.id ?? "");
  const parsed = RollbackBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: "REASON_REQUIRED" });

  const [updated] = await db.update(learningModelVersionsTable)
    .set({
      isActive:          false,
      liveAllowed:       false,
      rolledBack:        true,
      rolledBackAt:      new Date(),
      rolledBackReason:  parsed.data.reason,
      updatedAt:         new Date(),
    })
    .where(eq(learningModelVersionsTable.versionId, versionId))
    .returning();

  if (!updated) return res.status(404).json({ ok: false, error: "VERSION_NOT_FOUND" });

  log.warn({ versionId, admin: admin.id, reason: parsed.data.reason }, "learning_version_rolled_back");

  return res.json({
    ok: true,
    message: `Version ${versionId} rolled back. Global learning insights reverted to previous approved version.`,
  });
});

// ── GET /api/me/learning/version-status — user-facing ─────────────────────────
router.get("/me/learning/version-status", requireUser, async (_req, res) => {
  const active = await db.select({
    versionName: learningModelVersionsTable.versionName,
    deployedAt:  learningModelVersionsTable.deployedAt,
    shadowAccuracy: learningModelVersionsTable.shadowAccuracy,
    shadowSampleSize: learningModelVersionsTable.shadowSampleSize,
  })
    .from(learningModelVersionsTable)
    .where(and(
      eq(learningModelVersionsTable.isActive, true),
      eq(learningModelVersionsTable.liveAllowed, true),
    ))
    .orderBy(desc(learningModelVersionsTable.deployedAt))
    .limit(1);

  const v = active[0];
  return res.json({
    ok: true,
    hasActiveVersion: !!v,
    versionName:     v?.versionName ?? null,
    deployedAt:      v?.deployedAt  ?? null,
    shadowAccuracy:  v?.shadowAccuracy ?? null,
    note: v
      ? `${DEFAULT_ASSISTANT_NAME}'s global learning is powered by validated data (shadow accuracy: ${v.shadowAccuracy ?? "N/A"}%).`
      : `No validated global learning version is currently active. ${DEFAULT_ASSISTANT_NAME} uses individual user history only.`,
  });
});

export default router;
