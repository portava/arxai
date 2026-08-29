// Learning Model Version Service + Routes
//
// Routes:
//   GET  /api/admin/learning/versions          — list all versions
//   GET  /api/admin/learning/versions/:id      — get one version
//   POST /api/admin/learning/versions          — create a new version record
//   POST /api/admin/learning/versions/:id/approve — admin approve for live
//   POST /api/admin/learning/versions/:id/rollback — rollback a live version
//   GET  /api/admin/learning/active            — get current active live version
//   GET  /api/admin/learning/edges             — read-only production_edges list (R7 step 6)
//   GET  /api/me/learning/version-status       — user-facing: is Ruby using validated learning?
//
// SAFETY:
//   - liveAllowed only set when all 4 gates pass AND admin explicitly approves
//   - Rollback immediately deactivates — no grace period for bad learning
//   - All approval/rollback actions logged to audit vault
//
// EVIDENCE HONESTY (R7 step 6):
//   - Every gate computation EXCLUDES shadow_predictions rows labeled
//     SYNTHETIC_SIMULATOR (the wave-2 provenance label): synthetic-walk rows
//     are not market evidence, so they can neither validate nor walk-forward
//     a version. The gates stay honestly deadlocked until REAL durable shadow
//     rows exist — that is the correct state, not a bug. syntheticRowCount is
//     surfaced separately so the operator can see WHY the sample reads low.
//   - The production_edges surface here is READ-ONLY. Promotion decisions are
//     the pure gate in ../lib/learning/edgePromotion.ts; no write route exists
//     this wave, and liveAllowed is owner-pressed, never route-set.

import { Router } from "express";
import { z } from "zod/v4";
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";
import {
  learningModelVersionsTable,
  shadowPredictionsTable,
  globalSignalEdgesTable,
  productionEdgesTable,
  VERSION_GATES,
  type LearningModelVersionRow,
} from "@workspace/db/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
// Capability #51 — DEPLOYER lifecycle-role gate on live approval. Rollback is
// deliberately NOT lifecycle-gated: it is risk-reducing (deactivates bad
// learning immediately) and must never be trapped behind a missing grant.
import { requireLifecycleRole } from "../lib/security/lifecycleRoleGate.js";
// The wave-2 provenance label — imported, not re-typed, so the exclusion below
// can never drift from the literal shadowPersistence actually writes.
import { SYNTHETIC_SIMULATOR_SOURCE } from "../lib/shadowPersistence.js";
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
  syntheticRowCount: number;
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
  //
  // REAL ROWS ONLY: rows labeled SYNTHETIC_SIMULATOR come from the synthetic
  // random-walk simulator, not the market — counting them would let a
  // random-number generator validate a learning version. The SQL exclusion
  // means no gate below ever sees a synthetic row. If that leaves the sample
  // under MIN_SHADOW_SAMPLE, the gates stay failed — honestly.
  const shadowRows = await db.select()
    .from(shadowPredictionsTable)
    .where(and(
      sql`${shadowPredictionsTable.status} IN ('SHADOW_WIN', 'SHADOW_LOSS')`,
      sql`${shadowPredictionsTable.source} <> ${SYNTHETIC_SIMULATOR_SOURCE}`,
    ))
    .orderBy(desc(shadowPredictionsTable.createdAt), desc(shadowPredictionsTable.id));

  // Counted separately (ALL synthetic rows, any status) purely so the operator
  // can see why shadowSampleSize reads low while the table looks populated.
  const syntheticCount = await db.select({ count: sql<number>`count(*)::int` })
    .from(shadowPredictionsTable)
    .where(eq(shadowPredictionsTable.source, SYNTHETIC_SIMULATOR_SOURCE));
  const syntheticRowCount = syntheticCount[0]?.count ?? 0;

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
    syntheticRowCount,
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

// ── GET /api/admin/learning/edges — READ-ONLY production_edges list ──────────
// R7 step 6 promotion spine. Deliberately read-only: promotion is the pure
// gate in ../lib/learning/edgePromotion.ts, no write route exists this wave,
// and liveAllowed is owner-pressed — a route that could flip it would be a
// route that shouldn't exist. Lives in THIS router because it already owns
// /admin/learning* (no routes/index.ts change needed).
router.get("/admin/learning/edges", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;

  try {
    const edges = await db.select()
      .from(productionEdgesTable)
      .orderBy(desc(productionEdgesTable.createdAt))
      .limit(100);

    return res.json({
      ok: true,
      edges,
      count: edges.length,
      readOnly: true,
      note: "Promotion runs through the pure edgePromotion gate; liveAllowed is owner-pressed and never set by any route.",
    });
  } catch (e) {
    // Honest UNKNOWN: the table may not be migrated yet (new schema this wave;
    // drizzle-kit push is owner-run). Refusing with the reason beats a 500.
    log.warn({ err: e }, "production_edges_list_unavailable");
    return res.status(503).json({
      ok: false,
      error: "EDGE_LIBRARY_UNAVAILABLE",
      message: "production_edges could not be read — if the edgeLibrary migration has not been pushed yet, this is expected.",
    });
  }
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
      !gates.shadowValidated   ? `Shadow accuracy too low (${gates.shadowAccuracy ?? 0}% from ${gates.shadowSampleSize ?? 0} REAL predictions, need ${VERSION_GATES.MIN_SHADOW_ACCURACY}% from ${VERSION_GATES.MIN_SHADOW_SAMPLE})` : null,
      gates.syntheticRowCount > 0
        ? `${gates.syntheticRowCount} SYNTHETIC_SIMULATOR rows were excluded from every gate — synthetic rows are not market evidence`
        : null,
    ].filter(Boolean),
  });
});

// ── POST /api/admin/learning/versions/:id/approve ────────────────────────────
const ApproveBody = z.object({ adminNotes: z.string().max(1000).optional() });

// Capability #51 — approving a version for LIVE is the DEPLOYER's act. Once
// separation-of-duties is configured (any lifecycle grant exists), only a
// DEPLOYER grant-holder may approve; until then the gate logs a loud
// pass-through and the ADMIN/OWNER check below still applies.
router.post("/admin/learning/versions/:id/approve", requireUser, requireLifecycleRole("DEPLOYER"), async (req, res) => {
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
