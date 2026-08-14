// User-facing — "Am I allowed to use Master Live?" status.
//
// GET  /api/me/master-live/access            — gate verdict + request status
// POST /api/me/master-live/request-access    — user-initiated request to join
//
// Returns the per-user access gate verdict the UI uses to hide/show the
// master live ticket and Market Scanner live button. Never reveals
// another user's data; never includes email or role. Phase 22V Part 2
// adds the request-to-join flow.
import express, { type IRouter, Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import { loadAndEvaluateUserMasterLiveAccessGate } from "../lib/mt5/userMasterLiveAccessGate.js";
import {
  db,
  userMasterLiveAccessTable,
  masterLiveAccessAuditTable,
  riskTemplatesTable,
} from "@workspace/db";
import { getUserAllocationView } from "../lib/live/masterBridgePool.js";
import { getEffectiveTradingGovernance } from "../lib/governance/effectiveGovernance.js";

// Phase 22V Part 3 — resolve the friendly risk-template name (if any)
// to surface alongside the approved-state labels. Returns null when the
// user has no template assigned or the assignment cannot be resolved.
async function resolveAssignedRiskTemplateName(templateId: number | null): Promise<string | null> {
  if (templateId == null) return null;
  const rows = await db.select({ name: riskTemplatesTable.name })
    .from(riskTemplatesTable)
    .where(eq(riskTemplatesTable.id, templateId))
    .limit(1);
  return rows[0]?.name ?? null;
}

const router: IRouter = Router();
router.use(express.json());

async function loadAccessRow(userId: number) {
  const rows = await db.select().from(userMasterLiveAccessTable)
    .where(eq(userMasterLiveAccessTable.userId, userId)).limit(1);
  return rows[0] ?? null;
}

function friendlyMessage(reason: string | null): string {
  switch (reason) {
    case "USER_LIVE_BRIDGE_REQUEST_PENDING":
      return "Your live bridge access request is pending review.";
    case "USER_LIVE_BRIDGE_REQUEST_DENIED":
      return "Your live bridge access request was not approved.";
    case "USER_MASTER_LIVE_REVOKED":
      return "Your live bridge access has been revoked.";
    case "USER_MASTER_LIVE_TOGGLE_OFF":
      return "Live bridge access is currently paused for your account.";
    case "USER_MASTER_LIVE_SUSPENDED":
      return "Your live bridge access is suspended.";
    case "USER_MASTER_LIVE_RISK_LOCKED":
      return "Your account is in a risk-protection lock. Contact support.";
    case "USER_MISSING_RISK_DISCLOSURE":
      return "Please accept the live risk disclosure to continue.";
    case "USER_MISSING_RISK_SETTINGS":
      return "Please complete your risk settings to continue.";
    case "USER_NOT_APPROVED_FOR_MASTER_LIVE":
      return "Live bridge access requires approval. Tap Request Live Bridge Access to apply.";
    default:
      return "Live bridge access requires approval.";
  }
}

function requestSummary(row: typeof userMasterLiveAccessTable.$inferSelect | null) {
  if (!row) {
    return {
      requestState: "NOT_REQUESTED" as const,
      requestedAt: null,
      requestNote: null,
      deniedReason: null,
      deniedAt: null,
      revokedAt: null,
      revokedReason: null,
    };
  }
  const s = row.masterLiveStatus;
  const state: "NOT_REQUESTED" | "PENDING" | "APPROVED" | "DENIED" | "REVOKED" =
    s === "PENDING_REQUEST" ? "PENDING"
    : s === "APPROVED" ? "APPROVED"
    : s === "DENIED" ? "DENIED"
    : s === "REVOKED" ? "REVOKED"
    : row.liveBridgeRequestedAt ? "PENDING" : "NOT_REQUESTED";
  return {
    requestState: state,
    requestedAt: row.liveBridgeRequestedAt,
    requestNote: row.liveBridgeRequestNote,
    deniedReason: row.liveBridgeDeniedReason,
    deniedAt: row.liveBridgeDeniedAt,
    revokedAt: row.liveBridgeRevokedAt,
    revokedReason: row.liveBridgeRevokedReason,
  };
}

router.get("/me/master-live/access", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const [v, row, allocView] = await Promise.all([
    loadAndEvaluateUserMasterLiveAccessGate(userId),
    loadAccessRow(userId),
    // Task #1 — pull this user's per-allocation view + bridge availability
    // from the master pool. Never returns other users' figures.
    getUserAllocationView(userId),
  ]);
  // Task #1 — shared bridge fields (per-user only; never deficit numbers).
  const bridgeFields = {
    assignedAllocation: allocView.assignedAllocation,
    availableAllocation: allocView.availableAllocation,
    reservedRisk: allocView.reservedRisk,
    bridgeAvailability: allocView.bridgeAvailability,
    bridgeMessage: allocView.bridgeMessage,
  };
  if (v.decision === "PASS") {
    const riskTemplateName = await resolveAssignedRiskTemplateName(v.access.assignedRiskTemplateId ?? null);
    // T019 — single source of truth. Owner/admin app-added restrictions are
    // governance-driven (default OFF); normal users keep protective defaults.
    // Role is resolved inside the resolver (from the DB) so this user-facing
    // route never references the role token — see the no-email/role guard.
    const gov = await getEffectiveTradingGovernance(
      userId, "LIVE_SHARED_BRIDGE",
    );
    // Task #1 — bridge-availability gate. Even with a full PASS on the
    // user-access gate, the user must NOT see canTrade=true while the
    // shared bridge is not HEALTHY. This is the user-facing affordance
    // disable path; the dispatch pre-gate enforces the same rule
    // server-side with typed LIVE_BLOCKED:* reasons.
    if (allocView.bridgeAvailability !== "HEALTHY") {
      return res.json({
        ok: true,
        canTrade: false,
        status: v.access.masterLiveStatus,
        masterLiveTradingEnabled: false,
        scannerLiveEnabled: false,
        defaultExecutionRoute: v.access.defaultExecutionRoute ?? "SHARED_MASTER_MT5",
        defaultTradingMode: "LIVE_SHARED_BRIDGE" as const,
        riskTemplateName,
        blockReason: "LIVE_BRIDGE_UNAVAILABLE",
        blockReasons: ["LIVE_BRIDGE_UNAVAILABLE"],
        message: allocView.bridgeMessage,
        request: requestSummary(row),
        ...bridgeFields,
      });
    }
    return res.json({
      ok: true,
      canTrade: true,
      status: v.access.masterLiveStatus,
      masterLiveTradingEnabled: v.access.masterLiveTradingEnabled,
      scannerLiveEnabled: !!v.access.scannerLiveEnabled,
      defaultExecutionRoute: v.access.defaultExecutionRoute ?? "SHARED_MASTER_MT5",
      // Phase 22V Part 3 — friendly surface for approved users. The
      // mode is server-authoritative (PASS ⇒ LIVE_SHARED_BRIDGE); the
      // template name is whatever was assigned (null if none).
      defaultTradingMode: "LIVE_SHARED_BRIDGE" as const,
      riskTemplateName,
      limits: {
        allowedSymbols: gov.allowedSymbols ?? [],
        maxLot: gov.maxLotPerTrade,
        dailyLossLimitUsd: gov.maxDailyLossUsd,
        requireStopLoss: gov.requireStopLoss,
        requireTakeProfit: gov.requireTakeProfit,
        maxOpenPositions: gov.maxOpenPositions,
      },
      governance: {
        isPrivileged: gov.isPrivileged,
        ownerLiveControlMode: gov.ownerLiveControlMode,
        requireSecondConfirm: gov.requireSecondConfirm,
      },
      blockReason: null,
      message: "Live Bridge Access: Approved",
      request: requestSummary(row),
      ...bridgeFields,
    });
  }
  // Phase 22V Part 3/4 — surface LIVE_SHARED_BRIDGE as the default
  // trading mode for any user who has been admin-approved, even if the
  // toggle is currently off or the risk disclosure hasn't been accepted
  // yet. The blockReasons list still tells the UI exactly what's
  // pending. Same for the friendly template name — show it whenever a
  // template is assigned, not just on full gate PASS.
  const isApproved = !!row?.approvedForMasterLive && row?.masterLiveStatus === "APPROVED";
  const riskTemplateName = isApproved
    ? await resolveAssignedRiskTemplateName(row?.assignedRiskTemplateId ?? null)
    : null;
  return res.json({
    ok: true,
    canTrade: false,
    status: v.status,
    masterLiveTradingEnabled: false,
    scannerLiveEnabled: false,
    defaultExecutionRoute: row?.defaultExecutionRoute ?? "SHARED_MASTER_MT5",
    defaultTradingMode: (isApproved ? "LIVE_SHARED_BRIDGE" : "PAPER") as
      "LIVE_SHARED_BRIDGE" | "PAPER",
    riskTemplateName,
    blockReason: v.primaryReason,
    blockReasons: v.blockReasons,
    message: friendlyMessage(v.primaryReason),
    request: requestSummary(row),
    ...bridgeFields,
  });
});

// ── REQUEST TO JOIN LIVE BRIDGE ──────────────────────────────────────────
// User-initiated request. Refuses duplicate Pending and refuses if already
// Approved. Writes audit log. Never modifies approval/toggle flags.
const requestBody = z.object({
  note: z.string().max(1000).optional(),
  riskDisclosureAccepted: z.literal(true),
});

router.post("/me/master-live/request-access", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const parsed = requestBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: "BAD_BODY",
      message: "You must accept the risk disclosure to request access.",
    });
  }

  const existing = await loadAccessRow(userId);
  if (existing && (existing.masterLiveStatus === "APPROVED")) {
    return res.status(409).json({
      ok: false,
      error: "ALREADY_APPROVED",
      message: "You already have live bridge access.",
    });
  }
  if (existing && existing.masterLiveStatus === "PENDING_REQUEST") {
    return res.status(409).json({
      ok: false,
      error: "ALREADY_PENDING",
      message: "Your request is already pending review.",
      requestedAt: existing.liveBridgeRequestedAt,
    });
  }

  const now = new Date();
  const patch = {
    masterLiveStatus: "PENDING_REQUEST" as const,
    liveBridgeRequestedAt: now,
    liveBridgeRequestNote: parsed.data.note ?? null,
    liveBridgeRequestRiskDisclosureAcceptedAt: now,
    riskDisclosureAcceptedAt: now,
    // Clear any prior denied/revoked metadata so the new request starts clean.
    liveBridgeDeniedAt: null,
    liveBridgeDeniedBy: null,
    liveBridgeDeniedReason: null,
    liveBridgeRevokedAt: null,
    liveBridgeRevokedBy: null,
    liveBridgeRevokedReason: null,
    updatedAt: now,
  };

  let after: typeof userMasterLiveAccessTable.$inferSelect;
  if (existing) {
    const [updated] = await db.update(userMasterLiveAccessTable)
      .set(patch)
      .where(eq(userMasterLiveAccessTable.userId, userId))
      .returning();
    after = updated!;
  } else {
    const [inserted] = await db.insert(userMasterLiveAccessTable).values({
      userId,
      approvedForMasterLive: false,
      masterLiveTradingEnabled: false,
      ...patch,
    }).returning();
    after = inserted!;
  }

  await db.insert(masterLiveAccessAuditTable).values({
    // Self-initiated: admin column carries the requesting user's id; the
    // action discriminator makes it clear this was user-initiated.
    adminUserId: userId,
    targetUserId: userId,
    action: "REQUEST_SUBMITTED",
    reason: parsed.data.note ?? null,
    metadata: {
      before: existing ?? null,
      after,
      adminSourceIp: req.ip ?? null,
      selfInitiated: true,
    },
  });

  return res.json({
    ok: true,
    message: "Your live bridge access request has been submitted for review.",
    request: requestSummary(after),
  });
});

export default router;
