// Admin — Master Live User Access (per-user approval gate)
//
// Routes:
//   GET    /api/admin/master-live/users              — paginated list
//   GET    /api/admin/master-live/users/:userId      — single user
//   POST   /api/admin/master-live/users/:userId/approve   { reason? }
//   POST   /api/admin/master-live/users/:userId/disable   { reason? }
//   POST   /api/admin/master-live/users/:userId/suspend   { reason? }
//   POST   /api/admin/master-live/users/:userId/risk-lock { reason? }
//   POST   /api/admin/master-live/users/:userId/toggle    { enabled: bool, reason? }
//   POST   /api/admin/master-live/users/:userId/limits    { allowedSymbols?, maxLot?, dailyLossLimitUsd?, requireStopLoss?, scannerLiveEnabled?, reason? }
//   GET    /api/admin/master-live/users/:userId/audit     — last 200 audit rows
//
// SECURITY:
//   - Every handler is requireAdmin.
//   - Every mutation writes a master_live_access_audit row in the same
//     transaction-equivalent flow (insert + update happen sequentially;
//     audit insert MUST succeed before the response is returned).
//   - No raw token, apiKeyHash, password hash, or session secret is ever
//     surfaced. Email is shown to operators (they need to identify the
//     user); on the user-facing /me endpoint email is NOT exposed.
import express, { type IRouter, Router, type Request, type Response } from "express";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  isUserAcceptedBeta,
} from "../lib/live/operatorFundedPilotGate.js";
import {
  OPERATOR_FUNDED_PILOT_APPROVE_LOCK_KEY,
  OPERATOR_FUNDED_PILOT_MAX_USERS,
} from "../lib/live/operatorFundedPilotConfig.js";
import {
  db,
  usersTable,
  userMasterLiveAccessTable,
  masterLiveAccessAuditTable,
  arxLiveCommandsTable,
  arxLivePositionsTable,
  riskTemplatesTable,
  globalTradingSettingsTable,
  MASTER_LIVE_ACCESS_ACTIONS,
  type MasterLiveAccessAction,
  type MasterLiveStatus,
} from "@workspace/db";
import { mirrorCriticalEvent } from "../lib/security/events.js";
import {
  attachUserToSharedMasterInTxFlow,
  mirrorAllocationChange,
} from "./adminAllocations.js";
import { buildApprovedTraderLiveState } from "../lib/live/approvedTraderLiveState.js";
import { adminForceArmLiveForUser, LIVE_CONFIRMATION_PHRASE } from "../lib/live/liveArming.js";

// Phase 22V Part 3 — name of the seed shared-bridge default risk template
// applied automatically when an admin first approves a user. Idempotent
// via the `risk_templates_name_uq` unique index.
const APPROVED_SHARED_BRIDGE_DEFAULT_NAME = "Approved Shared Bridge Default";

async function findOrCreateApprovedSharedBridgeDefaultTemplate(
  tx: typeof db,
  createdBy: number,
): Promise<{ id: number; name: string }> {
  const existing = await tx.select({ id: riskTemplatesTable.id, name: riskTemplatesTable.name })
    .from(riskTemplatesTable)
    .where(eq(riskTemplatesTable.name, APPROVED_SHARED_BRIDGE_DEFAULT_NAME))
    .limit(1);
  if (existing[0]) return existing[0];
  const [inserted] = await tx.insert(riskTemplatesTable).values({
    name: APPROVED_SHARED_BRIDGE_DEFAULT_NAME,
    description:
      "Conservative default applied automatically when a user is approved for the shared live bridge: max lot 0.01, single open position, $10/day loss cap, EURUSD only, stop-loss and take-profit required.",
    payload: {
      maxLotSize: 0.01,
      maxDailyLossUsd: 10,
      maxOpenTrades: 1,
      allowedSymbols: ["EURUSD"],
      stopLossRequired: true,
      takeProfitRequired: true,
      scannerLiveEnabled: false,
      oneClickTradingEnabled: false,
      aiTradingEnabled: false,
      aiAutoCloseEnabled: false,
    },
    createdBy,
  }).returning({ id: riskTemplatesTable.id, name: riskTemplatesTable.name });
  return inserted!;
}

const router: IRouter = Router();
router.use(express.json());

function requireAdmin(req: Request, res: Response): { id: number; role: "ADMIN" | "OWNER" } | null {
  const sess = (req as Request & { authUser?: { id: number; role?: string } }).authUser;
  if (!sess?.id) {
    res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
    return null;
  }
  const role = sess.role ?? null;
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" });
    return null;
  }
  return { id: sess.id, role };
}

export async function getOrInsertAccess(userId: number) {
  const existing = await db.select().from(userMasterLiveAccessTable)
    .where(eq(userMasterLiveAccessTable.userId, userId)).limit(1);
  if (existing[0]) return existing[0];
  const [row] = await db.insert(userMasterLiveAccessTable).values({
    userId,
    approvedForMasterLive: false,
    masterLiveTradingEnabled: false,
    masterLiveStatus: "NOT_APPROVED",
  }).returning();
  return row!;
}

export async function writeAudit(args: {
  adminId: number;
  targetUserId: number;
  action: MasterLiveAccessAction;
  reason?: string;
  before: unknown;
  after: unknown;
  ip?: string | null;
}) {
  await db.insert(masterLiveAccessAuditTable).values({
    adminUserId: args.adminId,
    targetUserId: args.targetUserId,
    action: args.action,
    reason: args.reason ?? null,
    metadata: {
      before: args.before ?? null,
      after: args.after ?? null,
      adminSourceIp: args.ip ?? null,
    },
  });
  // Tamper-evident mirror for the master-live approval lifecycle — best-effort,
  // post-write. A denied/revoked decision is a DENIED status; approvals ALLOWED.
  const APPROVAL_LIFECYCLE = new Set([
    "APPROVED", "APPROVED_DEFAULTS_APPLIED", "DENIED", "REVOKED", "TOGGLE_ON", "TOGGLE_OFF",
  ]);
  if (APPROVAL_LIFECYCLE.has(args.action)) {
    const denied = args.action === "DENIED" || args.action === "REVOKED" || args.action === "TOGGLE_OFF";
    await mirrorCriticalEvent({
      eventType: "ADMIN_APPROVAL", severity: "HIGH", status: denied ? "DENIED" : "ALLOWED",
      actorUserId: args.adminId, actorType: "ADMIN",
      affectedObject: `user:${args.targetUserId}`,
      message: `Master-live access ${args.action}`,
      metadata: { action: args.action, targetUserId: args.targetUserId, reason: args.reason ?? null },
    });
  }
}

const reasonBody = z.object({ reason: z.string().max(500).optional() });

// ── LIST ─────────────────────────────────────────────────────────────────
router.get("/admin/master-live/users", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "100"), 10) || 100));
  const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);

  const users = await db.select({
    id: usersTable.id, email: usersTable.email, name: usersTable.name,
    role: usersTable.role, createdAt: usersTable.createdAt,
  }).from(usersTable).orderBy(desc(usersTable.id)).limit(limit).offset(offset);

  // Aggregate access rows + per-user exposure / daily P/L. Join in JS to
  // avoid a multi-table aggregate. Acceptable at limit≤200.
  const userIds = users.map((u) => u.id);
  const accessRows = userIds.length === 0 ? []
    : await db.select().from(userMasterLiveAccessTable);
  const accessByUser = new Map(accessRows.map((r) => [r.userId, r]));

  // Phase 22V Part 3 — resolve assigned risk-template names so the
  // admin queue shows the friendly label alongside the id.
  const templateIds = Array.from(new Set(
    accessRows.map((r) => r.assignedRiskTemplateId).filter((id): id is number => id != null),
  ));
  const templateRows = templateIds.length === 0 ? []
    : await db.select({ id: riskTemplatesTable.id, name: riskTemplatesTable.name })
        .from(riskTemplatesTable);
  const templateNameById = new Map(templateRows.map((t) => [t.id, t.name]));

  const result = await Promise.all(users.map(async (u) => {
    const a = accessByUser.get(u.id);
    const exposureRows = await db.select({
      open: sql<number>`COALESCE(SUM(${arxLivePositionsTable.volume}), 0)`,
      pnl: sql<number>`COALESCE(SUM(${arxLivePositionsTable.floatingPl}), 0)`,
    }).from(arxLivePositionsTable).where(and(
      eq(arxLivePositionsTable.userId, u.id),
      sql`${arxLivePositionsTable.closedAt} IS NULL`,
    ));
    const lastTradeRows = await db.select({ at: arxLiveCommandsTable.createdAt })
      .from(arxLiveCommandsTable).where(eq(arxLiveCommandsTable.userId, u.id))
      .orderBy(desc(arxLiveCommandsTable.createdAt)).limit(1);
    // Task #737 follow-up — surface the SHARED resolver's separated readiness
    // stages so the admin queue can show Live Approved / Shared Bridge Approved
    // / Full Live Activation / Live Execution Active as distinct statuses
    // (display-only; every value is still re-gated at dispatch). Skip the live
    // bridge heartbeat read for the list (per-user, kept cheap).
    const liveState = await buildApprovedTraderLiveState(u.id, { includeBridgeHeartbeat: false });
    return {
      userId: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      liveState: {
        approvedForLive: liveState.approvedForLive,
        liveBridgeAssigned: liveState.liveBridgeAssigned,
        executionActivated: liveState.executionActivated,
        executionReady: liveState.executionReady,
        blockingReasonCode: liveState.blockingReasonCode,
        blockingReason: liveState.blockingReason,
      },
      access: a ? {
        status: a.masterLiveStatus,
        approvedForMasterLive: a.approvedForMasterLive,
        masterLiveTradingEnabled: a.masterLiveTradingEnabled,
        approvedAt: a.masterLiveApprovedAt,
        approvedBy: a.masterLiveApprovedBy,
        disabledAt: a.masterLiveDisabledAt,
        disabledBy: a.masterLiveDisabledBy,
        allowedSymbols: a.allowedSymbols ?? [],
        maxLot: a.maxLot,
        dailyLossLimitUsd: a.dailyLossLimitUsd,
        maxOpenPositions: a.maxOpenPositions,
        maxExposurePerSymbolLots: a.maxExposurePerSymbolLots,
        requireStopLoss: a.requireStopLoss,
        requireTakeProfit: a.requireTakeProfit,
        scannerLiveEnabled: a.scannerLiveEnabled,
        defaultExecutionRoute: a.defaultExecutionRoute,
        riskDisclosureAcceptedAt: a.riskDisclosureAcceptedAt,
        riskSettingsConfiguredAt: a.riskSettingsConfiguredAt,
        // Phase 22V Part 2 — request-flow surfaces for admin queue.
        liveBridgeRequestedAt: a.liveBridgeRequestedAt,
        liveBridgeRequestNote: a.liveBridgeRequestNote,
        liveBridgeDeniedAt: a.liveBridgeDeniedAt,
        liveBridgeDeniedReason: a.liveBridgeDeniedReason,
        liveBridgeRevokedAt: a.liveBridgeRevokedAt,
        liveBridgeRevokedReason: a.liveBridgeRevokedReason,
        // Phase 22V Part 3 — assigned risk-template surfaced for admin
        // queue. Name is null when no template is assigned.
        assignedRiskTemplateId: a.assignedRiskTemplateId ?? null,
        assignedRiskTemplateName:
          a.assignedRiskTemplateId != null
            ? (templateNameById.get(a.assignedRiskTemplateId) ?? null)
            : null,
      } : {
        status: "NOT_APPROVED" as MasterLiveStatus,
        approvedForMasterLive: false,
        masterLiveTradingEnabled: false,
      },
      currentExposureLots: Number(exposureRows[0]?.open ?? 0),
      currentDailyPnlUsd: Number(exposureRows[0]?.pnl ?? 0),
      lastTradeAt: lastTradeRows[0]?.at ?? null,
    };
  }));

  return res.json({ ok: true, users: result, limit, offset });
});

// ── HELPER for status-change endpoints ──────────────────────────────────
// Operator identity passed to the extracted, route-free service cores below so
// the Admin Cockpit (Task #752) can delegate to the SAME canonical mutation +
// audit path as these routes without duplicating safety logic or bypassing the
// operator-funded pilot cap.
export interface MasterLiveAdminActor { id: number; role: "ADMIN" | "OWNER"; }

// Behaviour-preserving extraction of changeStatus's mutation+audit body. Pure
// of req/res so it can be reused by the cockpit. Performs the canonical
// userMasterLiveAccessTable status transition and the canonical
// master_live_access_audit write (via writeAudit, incl. mirrorCriticalEvent).
export async function changeMasterLiveStatusCore(
  admin: MasterLiveAdminActor,
  targetUserId: number,
  newStatus: MasterLiveStatus,
  action: MasterLiveAccessAction,
  reason: string | undefined,
  ip: string | null,
  mutator: (current: typeof userMasterLiveAccessTable.$inferSelect) => Partial<typeof userMasterLiveAccessTable.$inferInsert>,
): Promise<{ before: typeof userMasterLiveAccessTable.$inferSelect; after: typeof userMasterLiveAccessTable.$inferSelect }> {
  const before = await getOrInsertAccess(targetUserId);
  const patch = mutator(before);
  const [after] = await db.update(userMasterLiveAccessTable)
    .set({ ...patch, masterLiveStatus: newStatus, updatedAt: new Date() })
    .where(eq(userMasterLiveAccessTable.userId, targetUserId)).returning();
  await writeAudit({ adminId: admin.id, targetUserId, action, reason, before, after, ip });
  return { before, after: after! };
}

async function changeStatus(
  req: Request, res: Response,
  newStatus: MasterLiveStatus, action: MasterLiveAccessAction,
  mutator: (current: typeof userMasterLiveAccessTable.$inferSelect) => Partial<typeof userMasterLiveAccessTable.$inferInsert>,
) {
  const admin = requireAdmin(req, res); if (!admin) return;
  const targetUserId = parseInt(String(req.params.userId ?? ""), 10);
  if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ ok: false, error: "BAD_USER_ID" });
  }
  const parsed = reasonBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "BAD_BODY" });
  }
  const { after } = await changeMasterLiveStatusCore(
    admin, targetUserId, newStatus, action, parsed.data.reason, req.ip ?? null, mutator,
  );
  return res.json({ ok: true, access: after });
}

// ── APPROVE CORE (Task #752 cockpit delegation) ────────────────────────────
// Behaviour-preserving extraction of the /approve route body. Route-free so the
// Admin Cockpit delegates to the EXACT same atomic cap-enforced approval +
// canonical master_live_access_audit + best-effort shared-bridge attach. The
// operator-funded pilot cap is re-checked here (pg_advisory_xact_lock), so a
// cockpit-originated approval can never bypass it.
export type ApproveTraderForMasterLiveResult =
  | { kind: "not_in_beta" }
  | { kind: "cap"; approvedCount: number }
  | { kind: "ok"; before: unknown; after: typeof userMasterLiveAccessTable.$inferSelect; sharedBridgeAttached: boolean };

export async function approveTraderForMasterLiveCore(
  admin: MasterLiveAdminActor,
  targetUserId: number,
  reason: string | undefined,
  ip: string | null,
  log?: { warn?: (obj: unknown, msg?: string) => void; error?: (obj: unknown, msg?: string) => void },
): Promise<ApproveTraderForMasterLiveResult> {
  // Beta-cohort check runs outside the txn — read-only and cheap.
  if (!(await isUserAcceptedBeta(targetUserId))) {
    return { kind: "not_in_beta" };
  }

  // ── ATOMIC CAP ENFORCEMENT ───────────────────────────────────────────
  // pg_advisory_xact_lock serializes ALL concurrent /approve requests on
  // the same key. The cap re-check, the access-row upsert, and the audit
  // write all happen inside a single SERIALIZABLE-equivalent window. The
  // lock auto-releases at COMMIT/ROLLBACK.
  type ApproveOutcome =
    | { kind: "ok"; before: unknown; after: typeof userMasterLiveAccessTable.$inferSelect }
    | { kind: "cap"; approvedCount: number };
  const outcome: ApproveOutcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${OPERATOR_FUNDED_PILOT_APPROVE_LOCK_KEY})`);

    const existingRows = await tx.select()
      .from(userMasterLiveAccessTable)
      .where(eq(userMasterLiveAccessTable.userId, targetUserId))
      .limit(1);
    let before = existingRows[0] ?? null;
    if (!before) {
      const [inserted] = await tx.insert(userMasterLiveAccessTable).values({
        userId: targetUserId,
        approvedForMasterLive: false,
        masterLiveTradingEnabled: false,
        masterLiveStatus: "NOT_APPROVED",
      }).returning();
      before = inserted!;
    }

    const isReApproval = before.masterLiveStatus === "APPROVED";
    if (!isReApproval) {
      const countRows = await tx.select({ n: sql<number>`count(*)` })
        .from(userMasterLiveAccessTable)
        .where(and(
          eq(userMasterLiveAccessTable.masterLiveStatus, "APPROVED"),
          eq(userMasterLiveAccessTable.approvedForMasterLive, true),
        ));
      const approvedCount = Number(countRows[0]?.n ?? 0);
      if (approvedCount >= OPERATOR_FUNDED_PILOT_MAX_USERS) {
        return { kind: "cap", approvedCount };
      }
    }

    // ── APPROVED SHARED BRIDGE DEFAULT (Phase 22V Part 2) ──────────────
    // When a user transitions into APPROVED for the first time (i.e. not
    // a re-approval of an already-APPROVED row), apply safe shared-bridge
    // defaults so the operator does not have to set caps manually:
    //   maxLot = 0.01           — smallest broker-supported safe lot
    //   dailyLossLimitUsd = 10  — $10/day floor
    //   maxOpenPositions = 1    — single open live position
    //   allowedSymbols = [EURUSD]
    //   requireStopLoss = true  — already default; reaffirm
    //   requireTakeProfit = true
    //   scannerLiveEnabled = false  — manual-confirm only by default
    //   defaultExecutionRoute = SHARED_MASTER_MT5
    // Defaults are only applied when the column is currently NULL/unset
    // so a previously-tuned per-user cap is never silently overwritten.
    const applyDefaults = !isReApproval;

    // Phase 22V Part 3 — on first approval, find-or-create the
    // "Approved Shared Bridge Default" risk template and assign it to
    // this access row. Preserve any pre-existing assignment so a
    // re-approval (or admin override) is never silently overwritten.
    let templateAssignment: { id: number; name: string } | null = null;
    if (applyDefaults && before.assignedRiskTemplateId == null) {
      templateAssignment = await findOrCreateApprovedSharedBridgeDefaultTemplate(tx as unknown as typeof db, admin.id);
    }

    const safeDefaultsPatch: Partial<typeof userMasterLiveAccessTable.$inferInsert> = applyDefaults
      ? {
          maxLot: before.maxLot ?? 0.01,
          dailyLossLimitUsd: before.dailyLossLimitUsd ?? 10,
          maxOpenPositions: before.maxOpenPositions ?? 1,
          allowedSymbols:
            (before.allowedSymbols && before.allowedSymbols.length > 0)
              ? before.allowedSymbols
              : ["EURUSD"],
          requireStopLoss: true,
          requireTakeProfit: true,
          scannerLiveEnabled: false,
          defaultExecutionRoute: before.defaultExecutionRoute ?? "SHARED_MASTER_MT5",
          riskSettingsConfiguredAt: before.riskSettingsConfiguredAt ?? new Date(),
          // Preserve any pre-existing template assignment.
          assignedRiskTemplateId: before.assignedRiskTemplateId ?? templateAssignment?.id ?? null,
          // Clear prior denied/revoked metadata on a fresh approval.
          liveBridgeDeniedAt: null,
          liveBridgeDeniedBy: null,
          liveBridgeDeniedReason: null,
          liveBridgeRevokedAt: null,
          liveBridgeRevokedBy: null,
          liveBridgeRevokedReason: null,
        }
      : {};

    const [after] = await tx.update(userMasterLiveAccessTable)
      .set({
        approvedForMasterLive: true,
        masterLiveApprovedBy: admin.id,
        masterLiveApprovedAt: isReApproval ? before.masterLiveApprovedAt ?? new Date() : new Date(),
        masterLiveStatus: "APPROVED",
        updatedAt: new Date(),
        ...safeDefaultsPatch,
      })
      .where(eq(userMasterLiveAccessTable.userId, targetUserId))
      .returning();

    await tx.insert(masterLiveAccessAuditTable).values({
      adminUserId: admin.id,
      targetUserId,
      action: "APPROVED",
      reason: reason ?? null,
      metadata: {
        before, after: after ?? null, adminSourceIp: ip,
        appliedSharedBridgeDefaults: applyDefaults,
      },
    });
    if (applyDefaults) {
      await tx.insert(masterLiveAccessAuditTable).values({
        adminUserId: admin.id,
        targetUserId,
        action: "APPROVED_DEFAULTS_APPLIED",
        reason: "Approved Shared Bridge Default caps applied on first approval.",
        metadata: {
          maxLot: after?.maxLot,
          dailyLossLimitUsd: after?.dailyLossLimitUsd,
          maxOpenPositions: after?.maxOpenPositions,
          allowedSymbols: after?.allowedSymbols,
          requireStopLoss: after?.requireStopLoss,
          requireTakeProfit: after?.requireTakeProfit,
          defaultExecutionRoute: after?.defaultExecutionRoute,
          adminSourceIp: ip,
        },
      });

      // Phase 22V Part 3 — surface the template assignment and the
      // LIVE_SHARED_BRIDGE default mode as separate audit rows so the
      // admin queue/ops log shows exactly what was wired on approval.
      if (templateAssignment != null && before.assignedRiskTemplateId == null) {
        await tx.insert(masterLiveAccessAuditTable).values({
          adminUserId: admin.id,
          targetUserId,
          action: "RISK_TEMPLATE_ASSIGNED",
          reason: `Auto-assigned ${templateAssignment.name} on first approval.`,
          metadata: {
            previousTemplateId: before.assignedRiskTemplateId ?? null,
            newTemplateId: templateAssignment.id,
            newTemplateName: templateAssignment.name,
            adminSourceIp: ip,
          },
        });
      }
      await tx.insert(masterLiveAccessAuditTable).values({
        adminUserId: admin.id,
        targetUserId,
        action: "DEFAULT_LIVE_MODE_SET",
        reason: "Default trading mode set to LIVE_SHARED_BRIDGE on approval.",
        metadata: {
          defaultTradingMode: "LIVE_SHARED_BRIDGE",
          executionRoute: after?.defaultExecutionRoute ?? "SHARED_MASTER_MT5",
          adminSourceIp: ip,
        },
      });
    }

    return { kind: "ok", before, after: after! };
  });

  if (outcome.kind === "cap") {
    return { kind: "cap", approvedCount: outcome.approvedCount };
  }

  // ── Best-effort shared-bridge attach (visibility scaffolding) ──────────
  // After a successful approval, attach the user to the active shared/master
  // live bridge so their account shell flips out of "assignment pending" and
  // the live virtual_trading_accounts row + slot allocation exist. Gated on
  // the operator policy flag `autoSetApprovedUsersToLive` (default true).
  //
  // STRICTLY visibility/provisioning: it reuses the SAME audited attach flow
  // the admin attach route uses, so there is zero safety-code duplication. It
  // NEVER arms the user for live execution, NEVER inserts into
  // arx_live_commands, and NEVER bypasses any Phase B gate. Manual per-user
  // arming + all 23 gates still independently gate execution.
  //
  // Best-effort + fail-open: the approval transaction has already committed,
  // so an attach failure here must never roll it back or fail the response.
  let sharedBridgeAttached = false;
  try {
    const [settings] = await db
      .select({ auto: globalTradingSettingsTable.autoSetApprovedUsersToLive })
      .from(globalTradingSettingsTable)
      .orderBy(asc(globalTradingSettingsTable.id))
      .limit(1);
    if (settings?.auto) {
      const attach = await db.transaction(async (tx) =>
        attachUserToSharedMasterInTxFlow(
          tx,
          admin,
          targetUserId,
          "live",
          "Auto-attach on master-live approval",
          ip,
        ),
      );
      if ("ok" in attach) {
        sharedBridgeAttached = true;
        await mirrorAllocationChange(
          admin,
          "ALLOCATION_ATTACH_SHARED_MASTER",
          targetUserId,
          "Auto-attach on master-live approval",
        );
      } else {
        log?.warn?.(
          { targetUserId, status: attach.status, body: attach.body },
          "auto-attach on master-live approval skipped",
        );
      }
    }
  } catch (err) {
    log?.error?.(
      { err, targetUserId },
      "auto-attach on master-live approval failed (approval already committed)",
    );
  }

  return { kind: "ok", before: outcome.before, after: outcome.after, sharedBridgeAttached };
}

router.post("/admin/master-live/users/:userId/approve", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const targetUserId = parseInt(String(req.params.userId ?? ""), 10);
  if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ ok: false, error: "BAD_USER_ID" });
  }
  const parsed = reasonBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "BAD_BODY" });
  }
  const result = await approveTraderForMasterLiveCore(
    admin, targetUserId, parsed.data.reason, req.ip ?? null, req.log,
  );
  if (result.kind === "not_in_beta") {
    return res.status(403).json({
      ok: false,
      error: "OPERATOR_FUNDED_PILOT_USER_NOT_IN_BETA_COHORT",
      message: "User must be an accepted ARX_PRIVATE_BETA_10 invitee.",
    });
  }
  if (result.kind === "cap") {
    return res.status(409).json({
      ok: false,
      error: "OPERATOR_FUNDED_PILOT_COHORT_CAP_REACHED",
      message: `Operator-funded pilot cap reached (${OPERATOR_FUNDED_PILOT_MAX_USERS}/${OPERATOR_FUNDED_PILOT_MAX_USERS}).`,
      approvedCount: result.approvedCount,
      cap: OPERATOR_FUNDED_PILOT_MAX_USERS,
    });
  }
  return res.json({ ok: true, access: result.after, sharedBridgeAttached: result.sharedBridgeAttached });
});

// ── APPROVE-LIVE + FULL LIVE ACTIVATION (Task #737) ────────────────────────
// POST /api/admin/traders/:userId/approve-live
//
// Superset of /approve that ALSO supports the admin "Full Live Activation"
// toggle. Full activation stands in for the trader's personal live-confirmation
// and requires a typed phrase (`ENABLE LIVE TRADING`) plus an explicit
// real-money-execution acknowledgement.
//
// SAFETY: this NEVER opens a second execution path and NEVER weakens, skips, or
// ORs any of the 23 Phase B dispatch gates or the additive
// LIVE_EXECUTION_ACTIVATION_GATE. It only sets honest preconditions:
//   - approves the trader for the shared live bridge (status APPROVED + caps);
//   - on full activation, sets live_execution_enabled = true,
//     live_confirmation_required = false, source = `admin_full_activation`,
//     and records live_confirmation_bypassed_by_admin = admin.id;
//   - honestly provisions (shared-bridge attach) and force-arms the trader's
//     OWN arming row (audited operator bypass — caps from the trader's row,
//     fresh phrase hash, never copied from another user).
// Bots / agents / system and investor accounts are rejected outright.
const approveLiveBody = z.object({
  reason: z.string().max(500).optional(),
  fullLiveActivation: z.boolean().optional(),
  adminConfirmationPhrase: z.string().max(200).optional(),
  adminAcknowledgedRealMoneyExecution: z.boolean().optional(),
});

router.post("/admin/traders/:userId/approve-live", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const targetUserId = parseInt(String(req.params.userId ?? ""), 10);
  if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ ok: false, error: "BAD_USER_ID" });
  }
  const parsed = approveLiveBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "BAD_BODY" });
  }
  const wantsFull = parsed.data.fullLiveActivation === true;

  // ── Classification reject (additive default-deny) ──────────────────────
  // Use the SAME shared resolver as the gate + display surfaces so eligibility
  // is decided in exactly one place.
  const preState = await buildApprovedTraderLiveState(targetUserId, {
    includeBridgeHeartbeat: false,
  });
  if (preState.isBotAgentSystem) {
    return res.status(403).json({
      ok: false, error: "BOT_AGENT_NOT_ALLOWED",
      message: "Automated, agent, and system accounts are not eligible for live execution.",
    });
  }
  if (preState.isInvestor) {
    return res.status(403).json({
      ok: false, error: "INVESTOR_NOT_ALLOWED",
      message: "Investor accounts are view-only and cannot place or manage trades.",
    });
  }

  // ── Full-activation typed-phrase + real-money ack ──────────────────────
  if (wantsFull) {
    if ((parsed.data.adminConfirmationPhrase ?? "") !== LIVE_CONFIRMATION_PHRASE) {
      return res.status(400).json({
        ok: false, error: "CONFIRMATION_PHRASE_MISMATCH",
        message: `Type the exact phrase "${LIVE_CONFIRMATION_PHRASE}" to enable Full Live Activation.`,
      });
    }
    if (parsed.data.adminAcknowledgedRealMoneyExecution !== true) {
      return res.status(400).json({
        ok: false, error: "REAL_MONEY_ACK_REQUIRED",
        message: "You must acknowledge this enables real-money live execution for the trader.",
      });
    }
  }

  // Beta-cohort check (parity with /approve) — read-only and cheap.
  if (!(await isUserAcceptedBeta(targetUserId))) {
    return res.status(403).json({
      ok: false,
      error: "OPERATOR_FUNDED_PILOT_USER_NOT_IN_BETA_COHORT",
      message: "User must be an accepted ARX_PRIVATE_BETA_10 invitee.",
    });
  }

  type ApproveLiveOutcome =
    | { kind: "ok"; after: typeof userMasterLiveAccessTable.$inferSelect }
    | { kind: "cap"; approvedCount: number };
  const outcome: ApproveLiveOutcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${OPERATOR_FUNDED_PILOT_APPROVE_LOCK_KEY})`);

    const existingRows = await tx.select()
      .from(userMasterLiveAccessTable)
      .where(eq(userMasterLiveAccessTable.userId, targetUserId))
      .limit(1);
    let before = existingRows[0] ?? null;
    if (!before) {
      const [inserted] = await tx.insert(userMasterLiveAccessTable).values({
        userId: targetUserId,
        approvedForMasterLive: false,
        masterLiveTradingEnabled: false,
        masterLiveStatus: "NOT_APPROVED",
      }).returning();
      before = inserted!;
    }

    const isReApproval = before.masterLiveStatus === "APPROVED";
    if (!isReApproval) {
      const countRows = await tx.select({ n: sql<number>`count(*)` })
        .from(userMasterLiveAccessTable)
        .where(and(
          eq(userMasterLiveAccessTable.masterLiveStatus, "APPROVED"),
          eq(userMasterLiveAccessTable.approvedForMasterLive, true),
        ));
      const approvedCount = Number(countRows[0]?.n ?? 0);
      if (approvedCount >= OPERATOR_FUNDED_PILOT_MAX_USERS) {
        return { kind: "cap", approvedCount };
      }
    }

    const applyDefaults = !isReApproval;
    let templateAssignment: { id: number; name: string } | null = null;
    if (applyDefaults && before.assignedRiskTemplateId == null) {
      templateAssignment = await findOrCreateApprovedSharedBridgeDefaultTemplate(tx as unknown as typeof db, admin.id);
    }

    const safeDefaultsPatch: Partial<typeof userMasterLiveAccessTable.$inferInsert> = applyDefaults
      ? {
          maxLot: before.maxLot ?? 0.01,
          dailyLossLimitUsd: before.dailyLossLimitUsd ?? 10,
          maxOpenPositions: before.maxOpenPositions ?? 1,
          allowedSymbols:
            (before.allowedSymbols && before.allowedSymbols.length > 0)
              ? before.allowedSymbols
              : ["EURUSD"],
          requireStopLoss: true,
          requireTakeProfit: true,
          scannerLiveEnabled: false,
          defaultExecutionRoute: before.defaultExecutionRoute ?? "SHARED_MASTER_MT5",
          riskSettingsConfiguredAt: before.riskSettingsConfiguredAt ?? new Date(),
          assignedRiskTemplateId: before.assignedRiskTemplateId ?? templateAssignment?.id ?? null,
          liveBridgeDeniedAt: null,
          liveBridgeDeniedBy: null,
          liveBridgeDeniedReason: null,
          liveBridgeRevokedAt: null,
          liveBridgeRevokedBy: null,
          liveBridgeRevokedReason: null,
        }
      : {};

    // Full Live Activation patch — honest activation precondition fields.
    const activationPatch: Partial<typeof userMasterLiveAccessTable.$inferInsert> = wantsFull
      ? {
          liveExecutionEnabled: true,
          liveConfirmationRequired: false,
          liveExecutionActivationSource: "admin_full_activation",
          liveExecutionActivatedBy: admin.id,
          liveExecutionActivatedAt: new Date(),
          liveConfirmationBypassedByAdmin: admin.id,
        }
      : {};

    const [after] = await tx.update(userMasterLiveAccessTable)
      .set({
        approvedForMasterLive: true,
        masterLiveApprovedBy: admin.id,
        masterLiveApprovedAt: isReApproval ? before.masterLiveApprovedAt ?? new Date() : new Date(),
        masterLiveStatus: "APPROVED",
        updatedAt: new Date(),
        ...safeDefaultsPatch,
        ...activationPatch,
      })
      .where(eq(userMasterLiveAccessTable.userId, targetUserId))
      .returning();

    await tx.insert(masterLiveAccessAuditTable).values({
      adminUserId: admin.id,
      targetUserId,
      action: "LIVE_BRIDGE_APPROVED",
      reason: parsed.data.reason ?? null,
      metadata: {
        before, after: after ?? null, adminSourceIp: req.ip ?? null,
        appliedSharedBridgeDefaults: applyDefaults,
        fullLiveActivation: wantsFull,
      },
    });
    if (applyDefaults) {
      await tx.insert(masterLiveAccessAuditTable).values({
        adminUserId: admin.id,
        targetUserId,
        action: "APPROVED_DEFAULTS_APPLIED",
        reason: "Approved Shared Bridge Default caps applied on first approval.",
        metadata: {
          maxLot: after?.maxLot,
          dailyLossLimitUsd: after?.dailyLossLimitUsd,
          maxOpenPositions: after?.maxOpenPositions,
          allowedSymbols: after?.allowedSymbols,
          adminSourceIp: req.ip ?? null,
        },
      });
      if (templateAssignment != null && before.assignedRiskTemplateId == null) {
        await tx.insert(masterLiveAccessAuditTable).values({
          adminUserId: admin.id,
          targetUserId,
          action: "RISK_TEMPLATE_ASSIGNED",
          reason: `Auto-assigned ${templateAssignment.name} on first approval.`,
          metadata: {
            previousTemplateId: before.assignedRiskTemplateId ?? null,
            newTemplateId: templateAssignment.id,
            newTemplateName: templateAssignment.name,
            adminSourceIp: req.ip ?? null,
          },
        });
      }
    }
    if (wantsFull) {
      await tx.insert(masterLiveAccessAuditTable).values({
        adminUserId: admin.id,
        targetUserId,
        action: "FULL_LIVE_ACTIVATION_ENABLED",
        reason: parsed.data.reason ?? "Admin Full Live Activation (typed phrase + real-money ack).",
        metadata: {
          source: "admin_full_activation",
          confirmationPhraseAccepted: true,
          realMoneyAcknowledged: true,
          bypassedByAdmin: admin.id,
          adminSourceIp: req.ip ?? null,
        },
      });
    }

    return { kind: "ok", after: after! };
  });

  if (outcome.kind === "cap") {
    return res.status(409).json({
      ok: false,
      error: "OPERATOR_FUNDED_PILOT_COHORT_CAP_REACHED",
      message: `Operator-funded pilot cap reached (${OPERATOR_FUNDED_PILOT_MAX_USERS}/${OPERATOR_FUNDED_PILOT_MAX_USERS}).`,
      approvedCount: outcome.approvedCount,
      cap: OPERATOR_FUNDED_PILOT_MAX_USERS,
    });
  }

  // ── Best-effort honest shared-bridge attach (visibility/provisioning) ──
  let sharedBridgeAttached = false;
  try {
    const [settings] = await db
      .select({ auto: globalTradingSettingsTable.autoSetApprovedUsersToLive })
      .from(globalTradingSettingsTable)
      .orderBy(asc(globalTradingSettingsTable.id))
      .limit(1);
    if (settings?.auto || wantsFull) {
      const attach = await db.transaction(async (tx) =>
        attachUserToSharedMasterInTxFlow(
          tx,
          admin,
          targetUserId,
          "live",
          "Auto-attach on approve-live",
          req.ip ?? null,
        ),
      );
      if ("ok" in attach) {
        sharedBridgeAttached = true;
        await mirrorAllocationChange(
          admin,
          "ALLOCATION_ATTACH_SHARED_MASTER",
          targetUserId,
          "Auto-attach on approve-live",
        );
      } else {
        req.log?.warn(
          { targetUserId, status: attach.status, body: attach.body },
          "approve-live auto-attach skipped",
        );
      }
    }
  } catch (err) {
    req.log?.error(
      { err, targetUserId },
      "approve-live auto-attach failed (approval already committed)",
    );
  }

  // ── Honest force-arm on full activation (audited operator bypass) ──────
  let forceArmed = false;
  if (wantsFull) {
    try {
      await adminForceArmLiveForUser({
        userId: targetUserId,
        adminId: admin.id,
        maxLotConfirmed: outcome.after.maxLot ?? 0.01,
        dailyLossLimitConfirmed: outcome.after.dailyLossLimitUsd ?? 10,
        ip: req.ip ?? null,
      });
      forceArmed = true;
    } catch (err) {
      req.log?.error(
        { err, targetUserId },
        "approve-live force-arm failed (approval already committed)",
      );
    }
  }

  // Rebuild the resolver state so the caller gets fresh readiness + blocker.
  const state = await buildApprovedTraderLiveState(targetUserId);

  return res.json({
    ok: true,
    access: outcome.after,
    fullLiveActivation: wantsFull,
    sharedBridgeAttached,
    forceArmed,
    state,
  });
});

// ── BACKFILL / BULK REPAIR (Task #737) ─────────────────────────────────────
// POST /api/admin/traders/bulk-activate-approved-live
//
// Idempotent bulk-repair over every APPROVED human trader. For each eligible
// trader it: (1) fills any missing safe-default caps + risk template, (2)
// honestly attaches them to the active shared master live bridge so display
// flips to LIVE, and (3) — ONLY when fullLiveActivation is explicitly chosen and
// the typed phrase + real-money ack are supplied — enables live execution and
// force-arms their OWN arming row (audited operator bypass of the personal
// phrase only).
//
// SAFETY: never touches unapproved users, hard-skips bots/agents/system and
// investors, and skips DISABLED/SUSPENDED/REVOKED/RISK_LOCKED access rows. It
// NEVER weakens or ORs any of the 23 Phase B gates or the additive
// LIVE_EXECUTION_ACTIVATION_GATE — every order still re-gates at dispatch. Safe
// to run repeatedly.
const bulkActivateBody = z.object({
  reason: z.string().max(500).optional(),
  fullLiveActivation: z.boolean().optional(),
  adminConfirmationPhrase: z.string().max(200).optional(),
  adminAcknowledgedRealMoneyExecution: z.boolean().optional(),
});

router.post("/admin/traders/bulk-activate-approved-live", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const parsed = bulkActivateBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "BAD_BODY" });
  }
  const wantsFull = parsed.data.fullLiveActivation === true;
  if (wantsFull) {
    if ((parsed.data.adminConfirmationPhrase ?? "") !== LIVE_CONFIRMATION_PHRASE) {
      return res.status(400).json({
        ok: false, error: "CONFIRMATION_PHRASE_MISMATCH",
        message: `Type the exact phrase "${LIVE_CONFIRMATION_PHRASE}" to bulk-enable Full Live Activation.`,
      });
    }
    if (parsed.data.adminAcknowledgedRealMoneyExecution !== true) {
      return res.status(400).json({
        ok: false, error: "REAL_MONEY_ACK_REQUIRED",
        message: "You must acknowledge this enables real-money live execution for approved traders.",
      });
    }
  }

  // Candidate set: every access row currently APPROVED + approvedForMasterLive.
  // Unapproved / denied / disabled / suspended / revoked / risk-locked rows are
  // never touched.
  const approvedRows = await db.select({ userId: userMasterLiveAccessTable.userId })
    .from(userMasterLiveAccessTable)
    .where(and(
      eq(userMasterLiveAccessTable.masterLiveStatus, "APPROVED"),
      eq(userMasterLiveAccessTable.approvedForMasterLive, true),
    ));

  const summary = {
    candidates: approvedRows.length,
    repaired: 0,
    fullyActivated: 0,
    skippedBotAgent: 0,
    skippedInvestor: 0,
    skippedNotApproved: 0,
    attachFailed: 0,
    forceArmFailed: 0,
    errors: 0,
  };
  const results: Array<{ userId: number; outcome: string; blockingReasonCode: string | null }> = [];

  for (const { userId: targetUserId } of approvedRows) {
    try {
      // Re-resolve eligibility per user from the SAME shared resolver.
      const state = await buildApprovedTraderLiveState(targetUserId, {
        includeBridgeHeartbeat: false,
      });
      if (state.isBotAgentSystem) {
        summary.skippedBotAgent++;
        results.push({ userId: targetUserId, outcome: "SKIPPED_BOT_AGENT", blockingReasonCode: "BOT_AGENT_NOT_ALLOWED" });
        continue;
      }
      if (state.isInvestor) {
        summary.skippedInvestor++;
        results.push({ userId: targetUserId, outcome: "SKIPPED_INVESTOR", blockingReasonCode: "INVESTOR_NOT_ALLOWED" });
        continue;
      }
      if (!state.approvedForLive) {
        summary.skippedNotApproved++;
        results.push({ userId: targetUserId, outcome: "SKIPPED_NOT_APPROVED", blockingReasonCode: "NOT_APPROVED_FOR_LIVE" });
        continue;
      }

      // ── Per-user idempotent repair transaction ──────────────────────────
      await db.transaction(async (tx) => {
        const existingRows = await tx.select()
          .from(userMasterLiveAccessTable)
          .where(eq(userMasterLiveAccessTable.userId, targetUserId))
          .limit(1);
        const before = existingRows[0];
        if (!before) return; // raced away; never insert here.

        // Fill ONLY missing safe defaults — never lower an operator-set cap.
        let templateAssignment: { id: number; name: string } | null = null;
        if (before.assignedRiskTemplateId == null) {
          templateAssignment = await findOrCreateApprovedSharedBridgeDefaultTemplate(
            tx as unknown as typeof db, admin.id,
          );
        }
        const repairPatch: Partial<typeof userMasterLiveAccessTable.$inferInsert> = {
          maxLot: before.maxLot ?? 0.01,
          dailyLossLimitUsd: before.dailyLossLimitUsd ?? 10,
          maxOpenPositions: before.maxOpenPositions ?? 1,
          allowedSymbols:
            (before.allowedSymbols && before.allowedSymbols.length > 0)
              ? before.allowedSymbols
              : ["EURUSD"],
          requireStopLoss: before.requireStopLoss ?? true,
          requireTakeProfit: before.requireTakeProfit ?? true,
          defaultExecutionRoute: before.defaultExecutionRoute ?? "SHARED_MASTER_MT5",
          riskSettingsConfiguredAt: before.riskSettingsConfiguredAt ?? new Date(),
          assignedRiskTemplateId: before.assignedRiskTemplateId ?? templateAssignment?.id ?? null,
          updatedAt: new Date(),
        };
        const activationPatch: Partial<typeof userMasterLiveAccessTable.$inferInsert> = wantsFull
          ? {
              liveExecutionEnabled: true,
              liveConfirmationRequired: false,
              liveExecutionActivationSource: "admin_full_activation",
              liveExecutionActivatedBy: admin.id,
              liveExecutionActivatedAt: new Date(),
              liveConfirmationBypassedByAdmin: admin.id,
            }
          : {};

        const [after] = await tx.update(userMasterLiveAccessTable)
          .set({ ...repairPatch, ...activationPatch })
          .where(eq(userMasterLiveAccessTable.userId, targetUserId))
          .returning();

        await tx.insert(masterLiveAccessAuditTable).values({
          adminUserId: admin.id,
          targetUserId,
          action: "BULK_LIVE_BRIDGE_REPAIR",
          reason: parsed.data.reason ?? "Bulk repair of approved-trader live access.",
          metadata: {
            before, after: after ?? null, fullLiveActivation: wantsFull,
            adminSourceIp: req.ip ?? null,
          },
        });
        if (wantsFull) {
          await tx.insert(masterLiveAccessAuditTable).values({
            adminUserId: admin.id,
            targetUserId,
            action: "BULK_FULL_LIVE_ACTIVATION_ENABLED",
            reason: parsed.data.reason ?? "Bulk Full Live Activation (typed phrase + real-money ack).",
            metadata: {
              source: "admin_full_activation",
              confirmationPhraseAccepted: true,
              realMoneyAcknowledged: true,
              bypassedByAdmin: admin.id,
              adminSourceIp: req.ip ?? null,
            },
          });
        }
      });

      // ── Best-effort honest shared-bridge attach (idempotent) ────────────
      try {
        const attach = await db.transaction(async (tx) =>
          attachUserToSharedMasterInTxFlow(
            tx, admin, targetUserId, "live",
            "Bulk approved-trader live repair", req.ip ?? null,
          ),
        );
        if ("ok" in attach) {
          await mirrorAllocationChange(
            admin, "ALLOCATION_ATTACH_SHARED_MASTER", targetUserId,
            "Bulk approved-trader live repair",
          );
        } else {
          summary.attachFailed++;
          req.log?.warn({ targetUserId, status: attach.status }, "bulk repair attach skipped");
        }
      } catch (err) {
        summary.attachFailed++;
        req.log?.error({ err, targetUserId }, "bulk repair attach failed");
      }

      // ── Honest force-arm on full activation (audited) ───────────────────
      if (wantsFull) {
        try {
          const armState = await buildApprovedTraderLiveState(targetUserId, {
            includeBridgeHeartbeat: false,
          });
          await adminForceArmLiveForUser({
            userId: targetUserId,
            adminId: admin.id,
            maxLotConfirmed: armState.maxLot ?? 0.01,
            dailyLossLimitConfirmed: armState.dailyLossLimitUsd ?? 10,
            ip: req.ip ?? null,
          });
          summary.fullyActivated++;
        } catch (err) {
          summary.forceArmFailed++;
          req.log?.error({ err, targetUserId }, "bulk repair force-arm failed");
        }
      }

      summary.repaired++;
      const finalState = await buildApprovedTraderLiveState(targetUserId, {
        includeBridgeHeartbeat: false,
      });
      results.push({
        userId: targetUserId,
        outcome: wantsFull ? "FULLY_ACTIVATED" : "REPAIRED",
        blockingReasonCode: finalState.blockingReasonCode,
      });
    } catch (err) {
      summary.errors++;
      req.log?.error({ err, targetUserId }, "bulk repair per-user failed");
      results.push({ userId: targetUserId, outcome: "ERROR", blockingReasonCode: null });
    }
  }

  return res.json({ ok: true, fullLiveActivation: wantsFull, summary, results });
});

// ── DISCLOSURE WAIVER (honest operator override) ───────────────────────────
// An OWNER/ADMIN may waive the live-trading risk-disclosure requirement for a
// user. This is recorded TRUTHFULLY as an operator override on the access row
// (disclosure_waived_at / _by / _reason) and in the master_live_access audit —
// it is NEVER recorded as the user having accepted the disclosure. The
// acceptance column (risk_disclosure_accepted_at) is left untouched. Both the
// per-user access gate and Phase B gate #18 honor either acceptance OR waiver.
const waiverBody = z.object({ reason: z.string().min(1).max(500) });

router.post("/admin/master-live/users/:userId/waive-disclosure", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const targetUserId = parseInt(String(req.params.userId ?? ""), 10);
  if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ ok: false, error: "BAD_USER_ID" });
  }
  const parsed = waiverBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "BAD_BODY", message: "A non-empty reason is required to waive the disclosure." });
  }
  const after = await db.transaction(async (tx) => {
    const existing = await tx.select().from(userMasterLiveAccessTable)
      .where(eq(userMasterLiveAccessTable.userId, targetUserId)).limit(1);
    let before = existing[0] ?? null;
    if (!before) {
      const [inserted] = await tx.insert(userMasterLiveAccessTable).values({
        userId: targetUserId,
        approvedForMasterLive: false,
        masterLiveTradingEnabled: false,
        masterLiveStatus: "NOT_APPROVED",
      }).returning();
      before = inserted!;
    }
    const [updated] = await tx.update(userMasterLiveAccessTable)
      .set({
        disclosureWaivedAt: new Date(),
        disclosureWaivedBy: admin.id,
        disclosureWaiverReason: parsed.data.reason,
        updatedAt: new Date(),
      })
      .where(eq(userMasterLiveAccessTable.userId, targetUserId))
      .returning();
    await tx.insert(masterLiveAccessAuditTable).values({
      adminUserId: admin.id,
      targetUserId,
      action: "DISCLOSURE_WAIVED",
      reason: parsed.data.reason,
      metadata: { before, after: updated ?? null, adminSourceIp: req.ip ?? null },
    });
    return updated!;
  });
  return res.json({ ok: true, access: after });
});

router.post("/admin/master-live/users/:userId/revoke-disclosure-waiver", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const targetUserId = parseInt(String(req.params.userId ?? ""), 10);
  if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ ok: false, error: "BAD_USER_ID" });
  }
  const parsed = reasonBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "BAD_BODY" });
  }
  const after = await db.transaction(async (tx) => {
    const before = await getOrInsertAccess(targetUserId);
    const [updated] = await tx.update(userMasterLiveAccessTable)
      .set({
        disclosureWaivedAt: null,
        disclosureWaivedBy: null,
        disclosureWaiverReason: null,
        updatedAt: new Date(),
      })
      .where(eq(userMasterLiveAccessTable.userId, targetUserId))
      .returning();
    await tx.insert(masterLiveAccessAuditTable).values({
      adminUserId: admin.id,
      targetUserId,
      action: "DISCLOSURE_WAIVER_REVOKED",
      reason: parsed.data.reason ?? null,
      metadata: { before, after: updated ?? null, adminSourceIp: req.ip ?? null },
    });
    return updated!;
  });
  return res.json({ ok: true, access: after });
});

router.post("/admin/master-live/users/:userId/disable", (req, res) =>
  changeStatus(req, res, "DISABLED", "DISABLED", () => ({
    masterLiveTradingEnabled: false,
    approvedForMasterLive: false,
    masterLiveDisabledBy: (req as Request & { authUser?: { id: number } }).authUser!.id,
    masterLiveDisabledAt: new Date(),
  })),
);

// ── DENY a pending request (Phase 22V Part 2) ───────────────────────────
// Reason is required so the user sees a meaningful explanation.
router.post("/admin/master-live/users/:userId/deny", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const targetUserId = parseInt(String(req.params.userId ?? ""), 10);
  if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ ok: false, error: "BAD_USER_ID" });
  }
  const parsed = reasonBody.safeParse(req.body ?? {});
  if (!parsed.success || !parsed.data.reason || parsed.data.reason.trim().length === 0) {
    return res.status(400).json({
      ok: false,
      error: "REASON_REQUIRED",
      message: "A reason is required when denying a live bridge request.",
    });
  }
  const before = await getOrInsertAccess(targetUserId);
  // Transition guard: deny only applies to a pending request. If the user
  // is already APPROVED, use Revoke; for anything else there is nothing
  // to deny.
  if (before.masterLiveStatus !== "PENDING_REQUEST") {
    return res.status(409).json({
      ok: false,
      error: "INVALID_STATUS_TRANSITION",
      message: `Cannot deny: user is currently ${before.masterLiveStatus}. Deny only applies to PENDING_REQUEST.`,
      currentStatus: before.masterLiveStatus,
    });
  }
  const [after] = await db.update(userMasterLiveAccessTable)
    .set({
      masterLiveStatus: "DENIED",
      approvedForMasterLive: false,
      masterLiveTradingEnabled: false,
      liveBridgeDeniedBy: admin.id,
      liveBridgeDeniedAt: new Date(),
      liveBridgeDeniedReason: parsed.data.reason,
      updatedAt: new Date(),
    })
    .where(eq(userMasterLiveAccessTable.userId, targetUserId)).returning();
  await writeAudit({
    adminId: admin.id, targetUserId, action: "DENIED",
    reason: parsed.data.reason, before, after, ip: req.ip ?? null,
  });
  return res.json({ ok: true, access: after });
});

// ── REVOKE an existing approved user (Phase 22V Part 2) ─────────────────
// Hard revoke — clears approval + toggle, records who/when/why.
router.post("/admin/master-live/users/:userId/revoke", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const targetUserId = parseInt(String(req.params.userId ?? ""), 10);
  if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ ok: false, error: "BAD_USER_ID" });
  }
  const parsed = reasonBody.safeParse(req.body ?? {});
  if (!parsed.success || !parsed.data.reason || parsed.data.reason.trim().length === 0) {
    return res.status(400).json({
      ok: false,
      error: "REASON_REQUIRED",
      message: "A reason is required when revoking live bridge access.",
    });
  }
  const before = await getOrInsertAccess(targetUserId);
  // Transition guard: revoke only applies to a previously-approved
  // lineage (APPROVED / DISABLED / SUSPENDED). Refuse on NOT_APPROVED /
  // PENDING_REQUEST / DENIED / REVOKED / RISK_LOCKED.
  const revocable = new Set(["APPROVED", "DISABLED", "SUSPENDED"]);
  if (!revocable.has(before.masterLiveStatus)) {
    return res.status(409).json({
      ok: false,
      error: "INVALID_STATUS_TRANSITION",
      message: `Cannot revoke: user is currently ${before.masterLiveStatus}. Revoke applies to APPROVED / DISABLED / SUSPENDED.`,
      currentStatus: before.masterLiveStatus,
    });
  }
  const [after] = await db.update(userMasterLiveAccessTable)
    .set({
      masterLiveStatus: "REVOKED",
      approvedForMasterLive: false,
      masterLiveTradingEnabled: false,
      liveBridgeRevokedBy: admin.id,
      liveBridgeRevokedAt: new Date(),
      liveBridgeRevokedReason: parsed.data.reason,
      masterLiveDisabledBy: admin.id,
      masterLiveDisabledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(userMasterLiveAccessTable.userId, targetUserId)).returning();
  await writeAudit({
    adminId: admin.id, targetUserId, action: "REVOKED",
    reason: parsed.data.reason, before, after, ip: req.ip ?? null,
  });
  return res.json({ ok: true, access: after });
});

router.post("/admin/master-live/users/:userId/suspend", (req, res) =>
  changeStatus(req, res, "SUSPENDED", "SUSPENDED", () => ({
    masterLiveTradingEnabled: false,
    masterLiveDisabledBy: (req as Request & { authUser?: { id: number } }).authUser!.id,
    masterLiveDisabledAt: new Date(),
  })),
);

router.post("/admin/master-live/users/:userId/risk-lock", (req, res) =>
  changeStatus(req, res, "RISK_LOCKED", "RISK_LOCKED", () => ({
    masterLiveTradingEnabled: false,
    masterLiveDisabledBy: (req as Request & { authUser?: { id: number } }).authUser!.id,
    masterLiveDisabledAt: new Date(),
  })),
);

// ── TOGGLE on/off (separate from status; user must already be APPROVED) ──
const toggleBody = z.object({ enabled: z.boolean(), reason: z.string().max(500).optional() });
router.post("/admin/master-live/users/:userId/toggle", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const targetUserId = parseInt(String(req.params.userId ?? ""), 10);
  const parsed = toggleBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_BODY" });

  const before = await getOrInsertAccess(targetUserId);
  // Refuse turning toggle ON when not APPROVED — defence-in-depth so the
  // gate cannot be subverted by toggling a NOT_APPROVED/SUSPENDED row.
  if (parsed.data.enabled && before.masterLiveStatus !== "APPROVED") {
    return res.status(409).json({
      ok: false,
      error: "TOGGLE_REQUIRES_APPROVED_STATUS",
      currentStatus: before.masterLiveStatus,
    });
  }
  const [after] = await db.update(userMasterLiveAccessTable)
    .set({
      masterLiveTradingEnabled: parsed.data.enabled,
      updatedAt: new Date(),
      ...(parsed.data.enabled ? {} : {
        masterLiveDisabledBy: admin.id,
        masterLiveDisabledAt: new Date(),
      }),
    })
    .where(eq(userMasterLiveAccessTable.userId, targetUserId)).returning();
  await writeAudit({
    adminId: admin.id, targetUserId,
    action: parsed.data.enabled ? "TOGGLE_ON" : "TOGGLE_OFF",
    reason: parsed.data.reason, before, after, ip: req.ip ?? null,
  });
  return res.json({ ok: true, access: after });
});

// ── LIMITS — per-user caps (symbols, max lot, daily loss, etc.) ─────────
const limitsBody = z.object({
  allowedSymbols: z.array(z.string()).optional(),
  maxLot: z.number().positive().optional(),
  dailyLossLimitUsd: z.number().nonnegative().optional(),
  // New concurrency + exposure caps (per-user, enforced by dispatch pipeline).
  // Integer >= 1; null/omitted leaves the column unset (no per-user cap).
  maxOpenPositions: z.number().int().min(1).max(1000).nullable().optional(),
  // Positive lots; null/omitted leaves the column unset (no per-user cap).
  maxExposurePerSymbolLots: z.number().positive().nullable().optional(),
  requireStopLoss: z.boolean().optional(),
  scannerLiveEnabled: z.boolean().optional(),
  // Phase 22V Part 3 — admin may reassign the user's risk template later.
  // Pass an integer id (must reference an existing risk_templates row) or
  // null to clear. Omitted = unchanged.
  assignedRiskTemplateId: z.number().int().positive().nullable().optional(),
  reason: z.string().max(500).optional(),
});
router.post("/admin/master-live/users/:userId/limits", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const targetUserId = parseInt(String(req.params.userId ?? ""), 10);
  const parsed = limitsBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_BODY" });
  // Audit reason is required when caps are being changed — admins must
  // record WHY each per-user cap shift happened so the audit log is useful.
  const isCapChange =
    parsed.data.maxOpenPositions !== undefined ||
    parsed.data.maxExposurePerSymbolLots !== undefined ||
    parsed.data.maxLot != null ||
    parsed.data.dailyLossLimitUsd != null;
  if (isCapChange && (!parsed.data.reason || parsed.data.reason.trim().length === 0)) {
    return res.status(400).json({ ok: false, error: "REASON_REQUIRED" });
  }
  const before = await getOrInsertAccess(targetUserId);
  const patch: Partial<typeof userMasterLiveAccessTable.$inferInsert> = { updatedAt: new Date() };
  if (parsed.data.allowedSymbols != null) patch.allowedSymbols = parsed.data.allowedSymbols;
  if (parsed.data.maxLot != null) patch.maxLot = parsed.data.maxLot;
  if (parsed.data.dailyLossLimitUsd != null) patch.dailyLossLimitUsd = parsed.data.dailyLossLimitUsd;
  if (parsed.data.maxOpenPositions !== undefined) patch.maxOpenPositions = parsed.data.maxOpenPositions;
  if (parsed.data.maxExposurePerSymbolLots !== undefined) patch.maxExposurePerSymbolLots = parsed.data.maxExposurePerSymbolLots;
  if (parsed.data.requireStopLoss != null) patch.requireStopLoss = parsed.data.requireStopLoss;
  if (parsed.data.scannerLiveEnabled != null) patch.scannerLiveEnabled = parsed.data.scannerLiveEnabled;

  // Phase 22V Part 3 — template reassignment. Validate the template
  // exists before touching the access row, and emit a paired audit row
  // so the change is fully traceable.
  let templateChanged: { previous: number | null; next: number | null; nextName: string | null } | null = null;
  if (parsed.data.assignedRiskTemplateId !== undefined) {
    if (parsed.data.assignedRiskTemplateId != null) {
      const t = await db.select({ id: riskTemplatesTable.id, name: riskTemplatesTable.name })
        .from(riskTemplatesTable)
        .where(eq(riskTemplatesTable.id, parsed.data.assignedRiskTemplateId)).limit(1);
      if (!t[0]) return res.status(400).json({ ok: false, error: "TEMPLATE_NOT_FOUND" });
      templateChanged = {
        previous: before.assignedRiskTemplateId ?? null,
        next: t[0].id,
        nextName: t[0].name,
      };
    } else {
      templateChanged = { previous: before.assignedRiskTemplateId ?? null, next: null, nextName: null };
    }
    patch.assignedRiskTemplateId = templateChanged.next;
  }

  const [after] = await db.update(userMasterLiveAccessTable)
    .set(patch).where(eq(userMasterLiveAccessTable.userId, targetUserId)).returning();
  await writeAudit({
    adminId: admin.id, targetUserId, action: "LIMITS_UPDATED",
    reason: parsed.data.reason, before, after, ip: req.ip ?? null,
  });
  if (templateChanged != null) {
    await db.insert(masterLiveAccessAuditTable).values({
      adminUserId: admin.id,
      targetUserId,
      action: "RISK_TEMPLATE_ASSIGNED",
      reason: parsed.data.reason ?? `Admin reassigned risk template.`,
      metadata: {
        previousTemplateId: templateChanged.previous,
        newTemplateId: templateChanged.next,
        newTemplateName: templateChanged.nextName,
        adminSourceIp: req.ip ?? null,
      },
    });
  }
  return res.json({ ok: true, access: after });
});

// ── AUDIT LOG read ──────────────────────────────────────────────────────
router.get("/admin/master-live/users/:userId/audit", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const targetUserId = parseInt(String(req.params.userId ?? ""), 10);
  if (!Number.isFinite(targetUserId)) return res.status(400).json({ ok: false, error: "BAD_USER_ID" });
  const rows = await db.select().from(masterLiveAccessAuditTable)
    .where(eq(masterLiveAccessAuditTable.targetUserId, targetUserId))
    .orderBy(desc(masterLiveAccessAuditTable.createdAt)).limit(200);
  return res.json({ ok: true, audit: rows, validActions: MASTER_LIVE_ACCESS_ACTIONS });
});

// ── LIVE READINESS diagnostic (admin) ───────────────────────────────────
// Task #737 — admin-facing readiness for ANY target user, driven by the SAME
// shared resolver (buildApprovedTraderLiveState) so the admin diagnostic and
// the user's own /api/me/live-readiness never diverge. Admin diagnostics MAY
// include raw blocking codes + classification, but still NO bridge tokens,
// account numbers, EA hashes, or IPs.
router.get("/admin/users/:userId/live-readiness", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const targetUserId = parseInt(String(req.params.userId ?? ""), 10);
  if (!Number.isFinite(targetUserId)) return res.status(400).json({ ok: false, error: "BAD_USER_ID" });
  const state = await buildApprovedTraderLiveState(targetUserId);
  return res.json({
    ok: true,
    userId: state.userId,
    classification: {
      productRole: state.productRole,
      isHumanTrader: state.isHumanTrader,
      isInvestor: state.isInvestor,
      isBotAgentSystem: state.isBotAgentSystem,
    },
    accountMode: state.intendedLiveDisplay ? "LIVE" : "DEMO",
    displayMode:
      state.approvedTraderBridgeAssigned || state.armed ? "LIVE_SHARED" : "DEMO",
    approvedForLive: state.approvedForLive,
    masterLiveStatus: state.masterLiveStatus,
    liveBridgeAssigned: state.liveBridgeAssigned,
    assignedLiveBridgeId: state.assignedLiveBridgeId,
    liveExecutionEnabled: state.liveExecutionEnabled,
    liveConfirmationRequired: state.liveConfirmationRequired,
    liveConfirmationBypassedByAdmin: state.liveConfirmationBypassedByAdmin,
    activationSource: state.liveExecutionActivationSource,
    fullLiveActivation: state.executionActivated,
    armed: state.armed,
    killSwitchEngaged: state.killSwitchEngaged,
    serverLiveExecutionOn: state.serverLiveExecutionOn,
    emergencyKillSwitch: state.emergencyKillSwitch,
    riskProfileReady: state.riskProfileReady,
    approvedSymbols: state.approvedSymbols,
    maxLot: state.maxLot,
    dailyLossLimitUsd: state.dailyLossLimitUsd,
    bridgeConnected: state.bridgeConnected,
    bridgeHeartbeatFresh: state.bridgeHeartbeatFresh,
    bridgeHeartbeatAgeSeconds: state.bridgeHeartbeatAgeSeconds,
    canPlaceRealMoneyTrades: state.executionReady,
    blockingReasonCode: state.blockingReasonCode,
    blockingReason: state.blockingReason,
  });
});

export default router;
