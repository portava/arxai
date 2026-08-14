// Admin Reconciliation Center — aggregator + 4 audited actions.
//
// All routes are admin-gated. All actions require a non-empty trimmed reason
// and write an admin_action_audit_log row before responding (fail-CLOSED).
// No route ever writes to arx_live_commands or to any live execution table.

import { Router, type Request, type Response } from "express";
import { and, isNull } from "drizzle-orm";
import { db, arxLivePositionsTable } from "@workspace/db";
import { adminActionAuditLogTable } from "@workspace/db/schema";
import {
  aggregateReconciliationIssues,
  issueId,
  RECONCILIATION_ISSUE_TYPES,
  type ReconciliationIssueType,
} from "../lib/reconciliation/detect.js";
import { brokerAbsenceAutoReconcilePolicy } from "../lib/live/brokerAbsencePolicy.js";
import {
  runBrokerAbsenceReconcile,
  type BrokerAbsenceReconcileResult,
} from "../lib/live/brokerAbsenceReconcileRunner.js";

const router = Router();

function requireAdmin(req: Request, res: Response): "ADMIN" | "OWNER" | null {
  const u = (req as Request & { authUser?: { id?: number; role?: string } }).authUser;
  const role = String(u?.role ?? "").toUpperCase();
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_OR_OWNER_REQUIRED" });
    return null;
  }
  return role as "ADMIN" | "OWNER";
}

function getAdminId(req: Request): number | null {
  return (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;
}

function clientIp(req: Request): string | null {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) return xf.split(",")[0]!.trim();
  return req.ip ?? null;
}

interface AuditArgs {
  adminId: number | null;
  role: "ADMIN" | "OWNER";
  action: string;
  targetUserId: number | null;
  reason: string | null;
  beforeState?: Record<string, unknown>;
  afterState: Record<string, unknown>;
  ipAddress: string | null;
}

async function writeAudit(args: AuditArgs): Promise<void> {
  // Fail-CLOSED: any audit failure must bubble up so the caller refuses.
  await db.insert(adminActionAuditLogTable).values({
    adminId: args.adminId,
    adminRole: args.role,
    action: args.action,
    targetUserId: args.targetUserId,
    beforeState: args.beforeState ?? {},
    afterState: args.afterState,
    reason: args.reason,
    ipAddress: args.ipAddress,
  });
}

function isReconciliationType(t: unknown): t is ReconciliationIssueType {
  return typeof t === "string" && (RECONCILIATION_ISSUE_TYPES as readonly string[]).includes(t);
}

interface ActionBody {
  reason?: unknown;
  type?: unknown;
  naturalKey?: unknown;
  targetUserId?: unknown;
}

async function validateActionBody(
  req: Request,
  res: Response,
  paramId: string,
  actionCode: string,
  role: "ADMIN" | "OWNER",
): Promise<null | { reason: string; type: ReconciliationIssueType; naturalKey: string; targetUserId: number | null }> {
  const body = (req.body ?? {}) as ActionBody;
  const reasonRaw = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reasonRaw.length < 3) {
    // Audit the block itself, then 400. Fail-CLOSED on audit too.
    try {
      await writeAudit({
        adminId: getAdminId(req), role,
        action: "RECONCILIATION_ACTION_BLOCKED_REASON_REQUIRED",
        targetUserId: null, reason: null,
        afterState: { attemptedAction: actionCode, issueId: paramId },
        ipAddress: clientIp(req),
      });
    } catch {
      res.status(500).json({ ok: false, error: "AUDIT_WRITE_FAILED" });
      return null;
    }
    res.status(400).json({ ok: false, error: "REASON_REQUIRED" });
    return null;
  }
  if (!isReconciliationType(body.type)) {
    res.status(400).json({ ok: false, error: "INVALID_ISSUE_TYPE" });
    return null;
  }
  const naturalKey = typeof body.naturalKey === "string" ? body.naturalKey : "";
  if (naturalKey.length === 0) {
    res.status(400).json({ ok: false, error: "NATURAL_KEY_REQUIRED" });
    return null;
  }
  const expected = issueId(body.type, naturalKey);
  if (expected !== paramId) {
    res.status(400).json({ ok: false, error: "ISSUE_ID_MISMATCH" });
    return null;
  }
  const tuid = body.targetUserId == null ? null : Number(body.targetUserId);
  return { reason: reasonRaw, type: body.type, naturalKey, targetUserId: Number.isFinite(tuid) ? tuid : null };
}

// ─── GET /api/admin/reconciliation-center/issues ──────────────────────────
router.get("/admin/reconciliation-center/issues", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  try {
    const agg = await aggregateReconciliationIssues();
    await writeAudit({
      adminId: getAdminId(req), role,
      action: "ADMIN_VIEWED_RECONCILIATION_CENTER",
      targetUserId: null, reason: null,
      afterState: { total: agg.total, countsBySeverity: agg.countsBySeverity },
      ipAddress: clientIp(req),
    });
    res.json({ ok: true, ...agg, categories: RECONCILIATION_ISSUE_TYPES });
  } catch (e) {
    res.status(500).json({ ok: false, error: "reconciliation_failed", reason: (e as Error).message.slice(0, 200) });
  }
});

async function handleAction(
  req: Request, res: Response,
  actionCode:
    | "RECONCILIATION_ISSUE_DISMISSED"
    | "RECONCILIATION_ISSUE_REVIEWED"
    | "RECONCILIATION_ATTRIBUTION_LINKED"
    | "RECONCILIATION_MANUAL_RESOLUTION",
): Promise<void> {
  const role = requireAdmin(req, res); if (!role) return;
  const paramId = String(req.params.id ?? "");
  const v = await validateActionBody(req, res, paramId, actionCode, role);
  if (!v) return;
  try {
    await writeAudit({
      adminId: getAdminId(req), role,
      action: actionCode,
      targetUserId: v.targetUserId,
      reason: v.reason,
      afterState: { issueId: paramId, type: v.type, naturalKey: v.naturalKey },
      ipAddress: clientIp(req),
    });
  } catch {
    res.status(500).json({ ok: false, error: "AUDIT_WRITE_FAILED" });
    return;
  }
  res.json({ ok: true, action: actionCode, issueId: paramId });
}

// ─── Broker-Side Close Reconciliation Guardrail (admin-only) ──────────────
// Dry-run visibility (no writes) + manual trigger. The DB-WRITE path is still
// gated by brokerAbsenceAutoReconcilePolicy.enabled INSIDE the runner, so even a
// manual call with dryRun=false cannot stamp closed_at while the flag is OFF.

async function enumerateUsersWithOpenLivePositions(): Promise<number[]> {
  const rows = await db.selectDistinct({ userId: arxLivePositionsTable.userId })
    .from(arxLivePositionsTable)
    .where(and(
      isNull(arxLivePositionsTable.closedAt),
      isNull(arxLivePositionsTable.reconcileState),
    ));
  return rows.map((r) => r.userId).filter((n): n is number => typeof n === "number");
}

interface AbsenceSample {
  positionId: string;
  userId: string;
  symbol: string;
  brokerTicket?: string;
  /** Proposed absence streak — consecutive reliable-sweep absence count. */
  absentSnapshotCount: number;
  /** Proposed first-absent timestamp — earliest reliable-sweep absence evidence. */
  firstAbsentAt?: string;
  lastAbsentAt?: string;
  lastReliableSnapshotAt?: string;
  candidateState: string;
  safeToStampClosed: boolean;
  blockedReason?: string;
  /**
   * True when the position has no confirmed broker ticket, so broker-side
   * identity cannot be established. Close reconciliation is blocked until
   * the ticket is confirmed.
   */
  mappingUncertain: boolean;
}

function summarizeRuns(runs: BrokerAbsenceReconcileResult[]) {
  const blockedReasons: Record<string, number> = {};
  const candidateStates: Record<string, number> = {};
  let candidateCount = 0, safeToStampCount = 0, blockedCount = 0, stampedCount = 0;
  let oldestCandidateAgeMs: number | null = null;
  /** Absent in exactly one reliable sweep (still accumulating, not yet repeated). */
  let absentOnce = 0;
  /** Absent in ≥2 reliable sweeps but below the required threshold. */
  let repeatedlyAbsent = 0;
  /** Rows where broker-ticket mapping is uncertain (cannot confirm identity). */
  let uncertainCount = 0;
  /**
   * True when every eligible candidate meets BOTH the required consecutive-absence
   * threshold AND the minimum first-absence age. A false value means at least one
   * row was flagged eligible without sufficient evidence (safety regression signal).
   */
  let noActiveBrokerPositionMisflagged = true;
  const samples: AbsenceSample[] = [];
  for (const r of runs) {
    candidateCount += r.candidateCount;
    safeToStampCount += r.safeToStampCount;
    blockedCount += r.blockedCount;
    stampedCount += r.stampedCount;
    for (const [k, v] of Object.entries(r.blockedReasons)) blockedReasons[k] = (blockedReasons[k] ?? 0) + v;
    for (const [k, v] of Object.entries(r.candidateStates)) candidateStates[k] = (candidateStates[k] ?? 0) + v;
    if (r.oldestCandidateAgeMs != null && (oldestCandidateAgeMs == null || r.oldestCandidateAgeMs > oldestCandidateAgeMs)) {
      oldestCandidateAgeMs = r.oldestCandidateAgeMs;
    }
    for (const c of r.candidates) {
      // Aggregate absence counts.
      if (c.absentSnapshotCount === 1) absentOnce += 1;
      else if (c.absentSnapshotCount >= 2) repeatedlyAbsent += 1;
      // Mapping uncertainty.
      if (c.blockedReason === "MAPPING_UNCERTAIN_NO_TICKET") uncertainCount += 1;
      // Misflag check: a safe-to-stamp candidate MUST have a broker ticket and a
      // first-absent timestamp (the pure helper enforces this, but verify here too).
      if (c.safeToStampClosed && (!c.brokerTicket || !c.firstAbsentAt)) {
        noActiveBrokerPositionMisflagged = false;
      }
      if (samples.length >= 50) continue;
      samples.push({
        positionId: c.positionId,
        userId: c.userId,
        symbol: c.symbol,
        brokerTicket: c.brokerTicket,
        absentSnapshotCount: c.absentSnapshotCount,
        firstAbsentAt: c.firstAbsentAt,
        lastAbsentAt: c.lastAbsentAt,
        lastReliableSnapshotAt: c.lastReliableSnapshotAt,
        candidateState: c.candidateState,
        safeToStampClosed: c.safeToStampClosed,
        blockedReason: c.blockedReason,
        mappingUncertain: c.blockedReason === "MAPPING_UNCERTAIN_NO_TICKET",
      });
    }
  }
  return {
    candidateCount, safeToStampCount, blockedCount, stampedCount,
    absentOnce, repeatedlyAbsent, uncertainCount, noActiveBrokerPositionMisflagged,
    blockedReasons, candidateStates, oldestCandidateAgeMs, samples,
  };
}

function policySnapshot() {
  return {
    enabled: brokerAbsenceAutoReconcilePolicy.enabled,
    requiredReliableAbsences: brokerAbsenceAutoReconcilePolicy.requiredReliableAbsences,
    minimumAbsentAgeMs: brokerAbsenceAutoReconcilePolicy.minimumAbsentAgeMs,
    requireCompleteSnapshot: brokerAbsenceAutoReconcilePolicy.requireCompleteSnapshot,
    snapshotReliabilityWindowMs: brokerAbsenceAutoReconcilePolicy.snapshotReliabilityWindowMs,
  };
}

// Dry-run candidates report — never writes to live tables (only the view audit).
router.get("/admin/reconciliation-center/broker-absence-candidates", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  try {
    const uidRaw = req.query.userId;
    const reqUserId = typeof uidRaw === "string" && uidRaw.length > 0 ? Number(uidRaw) : null;
    const users = reqUserId != null && Number.isFinite(reqUserId)
      ? [reqUserId]
      : await enumerateUsersWithOpenLivePositions();
    const runs: BrokerAbsenceReconcileResult[] = [];
    for (const u of users) {
      runs.push(await runBrokerAbsenceReconcile({ userId: u, dryRun: true }));
    }
    const summary = summarizeRuns(runs);
    await writeAudit({
      adminId: getAdminId(req), role,
      action: "ADMIN_VIEWED_BROKER_ABSENCE_CANDIDATES",
      targetUserId: reqUserId != null && Number.isFinite(reqUserId) ? reqUserId : null,
      reason: null,
      afterState: { scopeUsers: users.length, candidateCount: summary.candidateCount, safeToStampCount: summary.safeToStampCount },
      ipAddress: clientIp(req),
    });
    res.json({ ok: true, dryRun: true, policy: policySnapshot(), scopeUsers: users.length, ...summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: "broker_absence_candidates_failed", reason: (e as Error).message.slice(0, 200) });
  }
});

// Manual trigger — audited. Defaults to dry-run; an explicit dryRun=false still
// cannot stamp while the feature flag is OFF (we 409 with FEATURE_DISABLED).
router.post("/admin/reconciliation-center/broker-absence-reconcile", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  const body = (req.body ?? {}) as { reason?: unknown; targetUserId?: unknown; dryRun?: unknown; bridgeConnectionId?: unknown };
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 3) {
    try {
      await writeAudit({
        adminId: getAdminId(req), role,
        action: "BROKER_ABSENCE_RECONCILE_BLOCKED_REASON_REQUIRED",
        targetUserId: null, reason: null,
        afterState: {}, ipAddress: clientIp(req),
      });
    } catch {
      res.status(500).json({ ok: false, error: "AUDIT_WRITE_FAILED" });
      return;
    }
    res.status(400).json({ ok: false, error: "REASON_REQUIRED" });
    return;
  }
  const uidRaw = body.targetUserId;
  const userId = uidRaw == null ? null : Number(uidRaw);
  if (userId == null || !Number.isFinite(userId)) {
    res.status(400).json({ ok: false, error: "TARGET_USER_ID_REQUIRED" });
    return;
  }
  const dryRun = body.dryRun !== false; // default dry-run; only explicit false attempts a write
  // Writes MUST be bridge-scoped — an unscoped run trusts the freshest marker
  // across ALL of the user's bridges, which could mark a stale bridge's row
  // reliable. Dry-run may run unscoped (read-only).
  const bridgeRaw = body.bridgeConnectionId;
  const bridgeConnectionId = bridgeRaw == null ? null : Number(bridgeRaw);
  if (!dryRun && (bridgeConnectionId == null || !Number.isFinite(bridgeConnectionId))) {
    res.status(400).json({ ok: false, error: "BRIDGE_CONNECTION_ID_REQUIRED" });
    return;
  }
  if (!dryRun && !brokerAbsenceAutoReconcilePolicy.enabled) {
    try {
      await writeAudit({
        adminId: getAdminId(req), role,
        action: "BROKER_ABSENCE_RECONCILE_BLOCKED_FEATURE_DISABLED",
        targetUserId: userId, reason,
        afterState: { requestedDryRun: false }, ipAddress: clientIp(req),
      });
    } catch {
      res.status(500).json({ ok: false, error: "AUDIT_WRITE_FAILED" });
      return;
    }
    res.status(409).json({
      ok: false, error: "FEATURE_DISABLED",
      message: "Broker-absence DB-write is disabled (BROKER_ABSENCE_AUTO_RECONCILE_ENABLED is off). Dry-run is available.",
    });
    return;
  }
  try {
    const result = await runBrokerAbsenceReconcile({ userId, dryRun, bridgeConnectionId });
    await writeAudit({
      adminId: getAdminId(req), role,
      action: "BROKER_ABSENCE_RECONCILE_RUN",
      targetUserId: userId, reason,
      afterState: {
        dryRun: result.dryRun, enabled: result.enabled,
        candidateCount: result.candidateCount, safeToStampCount: result.safeToStampCount,
        stampedCount: result.stampedCount,
      },
      ipAddress: clientIp(req),
    });
    res.json({ ok: true, policy: policySnapshot(), ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: "broker_absence_reconcile_failed", reason: (e as Error).message.slice(0, 200) });
  }
});

router.post("/admin/reconciliation-center/issues/:id/dismiss",
  (req, res) => { void handleAction(req, res, "RECONCILIATION_ISSUE_DISMISSED"); });
router.post("/admin/reconciliation-center/issues/:id/mark-reviewed",
  (req, res) => { void handleAction(req, res, "RECONCILIATION_ISSUE_REVIEWED"); });
router.post("/admin/reconciliation-center/issues/:id/link-attribution",
  (req, res) => { void handleAction(req, res, "RECONCILIATION_ATTRIBUTION_LINKED"); });
router.post("/admin/reconciliation-center/issues/:id/resolve-manually",
  (req, res) => { void handleAction(req, res, "RECONCILIATION_MANUAL_RESOLUTION"); });

export default router;
