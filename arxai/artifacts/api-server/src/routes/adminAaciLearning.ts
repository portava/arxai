// AACI Learning, Trust & Drift — admin HTTP routes (Task #232, Phase 6).
//
// GET  /admin/aaci/learning/summary             → AaciLearningSummary
// GET  /admin/aaci/learning/trust               → AaciTrustScore[]
// GET  /admin/aaci/learning/changes             → AaciLearningChange[]
// POST /admin/aaci/learning/changes/:id/approve → apply a recommend-only change
// POST /admin/aaci/learning/changes/:id/reject  → reject a recommend-only change
// POST /admin/aaci/learning/changes/:id/rollback→ revert an applied change
//
// READ-ONLY / ADVISORY learning surface. None of this is an execution gate; it
// shapes the AACI learnedTrust (L) + drift (D) sub-scores and queues
// recommendations. Every endpoint is ADMIN/OWNER only — an admin
// previewing-as-user is downgraded to USER by the view-mode middleware and
// lands in the 403 branch (see requireAdmin). Every mutation requires a reason
// (≥3 chars), is CAS-guarded, and is audited.

import { Router } from "express";
import { z } from "zod/v4";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  aaciTrustScoresTable,
  AACI_TRUST_ENTITY_TYPES,
} from "@workspace/db";
import type { AaciTrustEntityType, AaciLearningStatus } from "@workspace/db";
import { normalizeProductRole, isAdminProductRole } from "../lib/auth/productRole.js";
import { logger } from "../lib/logger.js";
import { rowToTrustState } from "../lib/aaci/learning/trustStore.js";
import {
  listLearningChanges,
  countLearningChanges,
} from "../lib/aaci/learning/learningAudit.js";
import {
  approveWeightChange,
  rejectWeightChange,
  rollbackWeightChange,
  type AdminActionResult,
} from "../lib/aaci/learning/weightService.js";
import { trustMean, effectiveLearnedTrust } from "@workspace/domain/aaci";

// DTO shapes mirror the OpenAPI contract (AaciTrustScore, AaciLearningChange,
// AaciLearningSummary, AaciLearningActionResult). Defined locally because the
// generated TS model interfaces live in @workspace/api-client-react (a frontend
// dep) and cross-module z.infer from @workspace/api-zod (built with the `zod`
// root import) widens to unknown under this package's `zod/v4`.
interface AaciTrustScore {
  id: number;
  entityType: string;
  entityKey: string;
  userId: number;
  alpha: number;
  beta: number;
  evidenceCount: number;
  trustMean: number;
  effectiveTrustScore: number;
  quarantined: boolean;
  quarantineReason: string | null;
  driftSeverity: "NONE" | "MINOR" | "MAJOR" | "SEVERE" | null;
  driftScore: number | null;
  regimeTag: string | null;
  version: number;
  lastOutcomeAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AaciLearningChange {
  id: number;
  entityType: string;
  entityKey: string;
  userId: number;
  changeType: string;
  permissionLevel: "AUTO" | "RECOMMEND_ONLY";
  status: "APPLIED" | "RECOMMENDED" | "APPROVED" | "REJECTED" | "ROLLED_BACK";
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  reason: string;
  evidenceCount: number;
  confidence: number;
  rollbackOfId: number | null;
  actorUserId: number | null;
  actorRole: string | null;
  approvedByUserId: number | null;
  approvedAt: string | null;
  createdAt: string;
}

interface AaciLearningSummary {
  trackedEntities: number;
  quarantinedEntities: number;
  driftedEntities: number;
  pendingChanges: number;
  appliedChanges: number;
}

interface AaciLearningActionResult {
  ok: boolean;
  changeId: number;
  status: "APPROVED" | "REJECTED" | "ROLLED_BACK";
  appliedValue: number | null;
}

const router = Router();

const entityTypeSchema = z.enum(AACI_TRUST_ENTITY_TYPES);
const statusSchema = z.enum([
  "APPLIED",
  "RECOMMENDED",
  "APPROVED",
  "REJECTED",
  "ROLLED_BACK",
]);
const limitSchema = z.coerce.number().int().min(1).max(500).default(200);
const idSchema = z.coerce.number().int().min(1);
const reasonSchema = z.string().trim().min(3).max(500);

/**
 * Gate: must be a genuine ADMIN/OWNER session. Returns the admin user id or
 * null. We resolve the EFFECTIVE request role (`req.authUser.role`) rather than
 * the real role: the view-mode middleware downgrades a previewing admin's
 * effective role to USER (stashing the real role on `realRole`), so checking the
 * effective role makes admin-previewing-as-user land in the 403 branch — these
 * are operator surfaces (incl. state-changing approve/reject/rollback) that must
 * not be reachable while previewing. Mirrors the adminRubyQuality / adminFundBook
 * pattern. (resolveProductRole reads the real role and is intentionally NOT used
 * here so preview cannot retain operator access.)
 */
function requireAdmin(
  req: Parameters<Parameters<typeof router.get>[1]>[0],
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): { userId: number; role: string } | null {
  const userId = req.authUser?.id ?? 0;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  const effectiveRole = normalizeProductRole(req.authUser?.role);
  if (!isAdminProductRole(effectiveRole)) {
    res.status(403).json({ error: "Admin or owner access required" });
    return null;
  }
  return { userId, role: effectiveRole };
}

function toTrustDto(row: typeof aaciTrustScoresTable.$inferSelect): AaciTrustScore {
  const state = rowToTrustState(row);
  const eff = effectiveLearnedTrust(state, row.quarantined);
  return {
    id: row.id,
    entityType: row.entityType,
    entityKey: row.entityKey,
    userId: row.userId,
    alpha: row.alpha,
    beta: row.beta,
    evidenceCount: row.evidenceCount,
    trustMean: trustMean(state),
    effectiveTrustScore: eff.score,
    quarantined: row.quarantined,
    quarantineReason: row.quarantineReason,
    driftSeverity: row.driftSeverity as AaciTrustScore["driftSeverity"],
    driftScore: row.driftScore,
    regimeTag: row.regimeTag,
    version: row.version,
    lastOutcomeAt: row.lastOutcomeAt ? row.lastOutcomeAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── GET /admin/aaci/learning/summary ─────────────────────────────────────────
router.get("/admin/aaci/learning/summary", async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;

    const [trustAgg] = await db
      .select({
        tracked: sql<number>`count(*)::int`,
        quarantined: sql<number>`count(*) filter (where ${aaciTrustScoresTable.quarantined})::int`,
        drifted: sql<number>`count(*) filter (where ${aaciTrustScoresTable.driftSeverity} in ('MAJOR','SEVERE'))::int`,
      })
      .from(aaciTrustScoresTable);

    const [pendingChanges, appliedChanges] = await Promise.all([
      countLearningChanges({ status: "RECOMMENDED" }),
      countLearningChanges({ status: "APPLIED" }),
    ]);

    const summary: AaciLearningSummary = {
      trackedEntities: trustAgg?.tracked ?? 0,
      quarantinedEntities: trustAgg?.quarantined ?? 0,
      driftedEntities: trustAgg?.drifted ?? 0,
      pendingChanges,
      appliedChanges,
    };
    res.json(summary);
  } catch (err) {
    logger.error({ err }, "aaci.learning.admin.summary_failed");
    next(err);
  }
});

// ── GET /admin/aaci/learning/trust ───────────────────────────────────────────
router.get("/admin/aaci/learning/trust", async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;

    const entityType = entityTypeSchema.safeParse(req.query["entityType"]);
    const quarantinedOnly = req.query["quarantinedOnly"] === "true";
    const limit = limitSchema.parse(req.query["limit"] ?? 200);

    const conds = [];
    if (entityType.success) {
      conds.push(eq(aaciTrustScoresTable.entityType, entityType.data as AaciTrustEntityType));
    }
    if (quarantinedOnly) conds.push(eq(aaciTrustScoresTable.quarantined, true));

    const rows = await db
      .select()
      .from(aaciTrustScoresTable)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(aaciTrustScoresTable.entityType, aaciTrustScoresTable.entityKey)
      .limit(limit);

    res.json({ scores: rows.map(toTrustDto) });
  } catch (err) {
    logger.error({ err }, "aaci.learning.admin.trust_failed");
    next(err);
  }
});

// ── GET /admin/aaci/learning/changes ─────────────────────────────────────────
router.get("/admin/aaci/learning/changes", async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;

    const status = statusSchema.safeParse(req.query["status"]);
    const entityType = entityTypeSchema.safeParse(req.query["entityType"]);
    const limit = limitSchema.parse(req.query["limit"] ?? 200);

    const rows = await listLearningChanges({
      status: status.success ? (status.data as AaciLearningStatus) : undefined,
      entityType: entityType.success ? entityType.data : undefined,
      limit,
    });

    const changes: AaciLearningChange[] = rows.map((r) => ({
      id: r.id,
      entityType: r.entityType,
      entityKey: r.entityKey,
      userId: r.userId,
      changeType: r.changeType,
      permissionLevel: r.permissionLevel as AaciLearningChange["permissionLevel"],
      status: r.status as AaciLearningChange["status"],
      oldValue: r.oldValue as Record<string, unknown>,
      newValue: r.newValue as Record<string, unknown>,
      reason: r.reason,
      evidenceCount: r.evidenceCount,
      confidence: r.confidence,
      rollbackOfId: r.rollbackOfId,
      actorUserId: r.actorUserId,
      actorRole: r.actorRole,
      approvedByUserId: r.approvedByUserId,
      approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    }));
    res.json({ changes });
  } catch (err) {
    logger.error({ err }, "aaci.learning.admin.changes_failed");
    next(err);
  }
});

// Map a service result onto the HTTP response.
function sendActionResult(
  res: Parameters<Parameters<typeof router.post>[1]>[1],
  changeId: number,
  result: AdminActionResult,
): void {
  if (result.ok) {
    const body: AaciLearningActionResult = {
      ok: true,
      changeId,
      status: result.status,
      appliedValue: result.appliedValue ?? null,
    };
    res.json(body);
    return;
  }
  switch (result.reason) {
    case "NOT_FOUND":
      res.status(404).json({ error: "Change not found" });
      return;
    case "NOT_PENDING":
      res.status(409).json({ error: "Change is not in a recommend-only state" });
      return;
    case "NOT_APPLIED":
      res.status(409).json({ error: "Change is not in an applied state" });
      return;
    case "NO_TARGET":
      res.status(409).json({ error: "Change has no recorded target value" });
      return;
    default:
      res.status(409).json({ error: "Change could not be actioned" });
  }
}

function parseAction(
  req: Parameters<Parameters<typeof router.post>[1]>[0],
  res: Parameters<Parameters<typeof router.post>[1]>[1],
): { changeId: number; reason: string; admin: { userId: number; role: string } } | null {
  const admin = requireAdmin(req, res);
  if (!admin) return null;
  const idParse = idSchema.safeParse(req.params["id"]);
  if (!idParse.success) {
    res.status(400).json({ error: "Invalid change id" });
    return null;
  }
  const reasonParse = reasonSchema.safeParse((req.body ?? {})["reason"]);
  if (!reasonParse.success) {
    res.status(400).json({ error: "A reason of at least 3 characters is required" });
    return null;
  }
  return { changeId: idParse.data, reason: reasonParse.data, admin };
}

// ── POST /admin/aaci/learning/changes/:id/approve ────────────────────────────
router.post("/admin/aaci/learning/changes/:id/approve", async (req, res, next) => {
  try {
    const parsed = parseAction(req, res);
    if (!parsed) return;
    const result = await approveWeightChange({
      changeId: parsed.changeId,
      adminUserId: parsed.admin.userId,
      adminRole: parsed.admin.role,
      reason: parsed.reason,
    });
    sendActionResult(res, parsed.changeId, result);
  } catch (err) {
    logger.error({ err }, "aaci.learning.admin.approve_failed");
    next(err);
  }
});

// ── POST /admin/aaci/learning/changes/:id/reject ─────────────────────────────
router.post("/admin/aaci/learning/changes/:id/reject", async (req, res, next) => {
  try {
    const parsed = parseAction(req, res);
    if (!parsed) return;
    const result = await rejectWeightChange({
      changeId: parsed.changeId,
      adminUserId: parsed.admin.userId,
      adminRole: parsed.admin.role,
      reason: parsed.reason,
    });
    sendActionResult(res, parsed.changeId, result);
  } catch (err) {
    logger.error({ err }, "aaci.learning.admin.reject_failed");
    next(err);
  }
});

// ── POST /admin/aaci/learning/changes/:id/rollback ───────────────────────────
router.post("/admin/aaci/learning/changes/:id/rollback", async (req, res, next) => {
  try {
    const parsed = parseAction(req, res);
    if (!parsed) return;
    const result = await rollbackWeightChange({
      changeId: parsed.changeId,
      adminUserId: parsed.admin.userId,
      adminRole: parsed.admin.role,
      reason: parsed.reason,
    });
    sendActionResult(res, parsed.changeId, result);
  } catch (err) {
    logger.error({ err }, "aaci.learning.admin.rollback_failed");
    next(err);
  }
});

export default router;
