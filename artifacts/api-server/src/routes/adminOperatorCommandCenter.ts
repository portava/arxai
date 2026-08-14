// Admin — ARX Operator Command Center
//
// SAFETY (inviolable):
//  - Single GET aggregator. READ-ONLY. No mutations. No live trade contact.
//  - Admin/owner only. Same gate pattern as adminLiveTestReadiness.
//  - Composes existing helpers (no new query logic, no schema):
//      detectCurrentConnectedBridge, aggregateReconciliationIssues,
//      getGlobalSettings, evaluateLivePhaseBDispatchGate inputs already
//      loaded by live-test-readiness (we reuse loadOperatorAccess shape).
//  - Never returns: raw bridge tokens, apiKeyHash, SESSION_SECRET,
//    MT5_BRIDGE_TOKEN, IP addresses or account numbers to non-admin
//    (gated above), safetyGateSnapshot blobs.
//  - Writes one audit row `ADMIN_VIEWED_OPERATOR_COMMAND_CENTER`.
//  - DOES NOT call /api/admin/live-test-readiness/preflight (that's a
//    separate explicit operator action — this page only links to it).
import express, { type IRouter, Router, type Request, type Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  mt5ConnectionTable,
  globalTradingSettingsTable,
  userMasterLiveAccessTable,
  arxLiveCommandsTable,
  arxLiveArmingTable,
  liveRiskDisclosureAcceptancesTable,
  mt5CommandsTable,
} from "@workspace/db";
import { detectCurrentConnectedBridge, maskBridgeEvidenceForUser }
  from "../lib/mt5/currentConnectedBridgeDetector.js";
import { aggregateReconciliationIssues } from "../lib/reconciliation/detect.js";
import { getGlobalSettings } from "../lib/adminTrading/safetyEnvelope.js";
import { adminActionAuditLogTable } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { isLiveBrokerExecutionEnabledEnv } from "@workspace/domain/safety-contracts/isLiveBrokerExecutionEnabled";

const router: IRouter = Router();

function requireAdmin(req: Request, res: Response): { id: number; role: "ADMIN" | "OWNER" } | null {
  // Canonical per-user auth accessor is `req.authUser` (attached by
  // attachAuthUser). Mirrors the proven gate in adminLiveTestReadiness.ts.
  // The previous `req.userId`/`req.session?.userId` accessors are never
  // populated, so they returned 401 AUTH_REQUIRED for every caller.
  const sess = (req as Request & { authUser?: { id: number; role?: string } }).authUser;
  if (!sess?.id) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return null; }
  const role = sess.role ?? null;
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" }); return null;
  }
  return { id: sess.id, role };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function liveBrokerExecutionEnabled(): boolean {
  return isLiveBrokerExecutionEnabledEnv();
}

router.get("/admin/operator-command-center", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const startedAt = Date.now();

  try {
    // A. System status (no secret reads). DB ping = COUNT a tiny tbl.
    const [usrTotal, dbPing, queueDepth, openLive] = await Promise.all([
      db.select({ n: sql<number>`COUNT(*)::int` }).from(usersTable),
      db.execute(sql`SELECT 1 AS ping`),
      db.select({ n: sql<number>`COUNT(*)::int` })
        .from(mt5CommandsTable).where(sql`${mt5CommandsTable.status} IN ('PENDING','SENT_TO_MT5','SENT_TO_MT5_DEMO','DEMO_APPROVED')`),
      db.select({ n: sql<number>`COUNT(*)::int` })
        .from(arxLiveCommandsTable).where(sql`${arxLiveCommandsTable.status} NOT IN ('FILLED','REJECTED','CANCELLED','LIVE_BLOCKED')`),
    ]);

    // B. Current bridge (masked).
    const det = await detectCurrentConnectedBridge();
    const bridge = det.ok
      ? maskBridgeEvidenceForUser(det.bridge)
      : det.latestHint ? maskBridgeEvidenceForUser(det.latestHint) : null;

    // C. Trading mode + master live wiring.
    const settings = await getGlobalSettings();
    const masterSwitch = liveBrokerExecutionEnabled();
    const platformBridgeId = (settings as { platformMasterBridgeConnectionId?: number | null })
      .platformMasterBridgeConnectionId ?? null;
    const sharedLiveEnabled = !!(settings as { sharedLiveTradingEnabled?: boolean }).sharedLiveTradingEnabled;

    let tradingModeLabel: string;
    if (masterSwitch && sharedLiveEnabled) tradingModeLabel = "MASTER_BRIDGE_LIVE_ENABLED";
    else if (platformBridgeId && !sharedLiveEnabled) tradingModeLabel = "MASTER_BRIDGE_LIVE_LOCKED";
    else if (platformBridgeId) tradingModeLabel = "MASTER_BRIDGE_DEMO";
    else tradingModeLabel = "PER_USER_BRIDGE";

    // D. Safety controls (read-only summary).
    // NOTE: schema field is `emergencyKillSwitch` (default TRUE = engaged).
    const killSwitchEngaged = !!(settings as { emergencyKillSwitch?: boolean }).emergencyKillSwitch;
    const safetyControls = {
      platformMode: (settings as { platformMode?: string }).platformMode ?? "OFF",
      killSwitchEngaged,
      killSwitchReason: (settings as { killSwitchReason?: string | null }).killSwitchReason ?? null,
      liveBrokerExecutionEnabled: masterSwitch,
      // Phase 10 canonical name + deprecated alias for back-compat.
      liveExecutionHardLockActive: !masterSwitch,
      paperOnlyHardLockActive: !masterSwitch,
      sharedLiveTradingEnabled: sharedLiveEnabled,
      oneClickPolicy: "TYPED_PHRASE_REQUIRED",
      stopLossRequiredDefault: true,
      maxLotDefault: 0.01,
      queueDepth: queueDepth[0]?.n ?? 0,
      openLiveCommandsNonTerminal: openLive[0]?.n ?? 0,
    };

    // E. User approval center counts (no PII beyond id+email visible to admin).
    const approvalRows = await db.select({
      userId: userMasterLiveAccessTable.userId,
      approvedForMasterLive: userMasterLiveAccessTable.approvedForMasterLive,
      masterLiveStatus: userMasterLiveAccessTable.masterLiveStatus,
      riskDisclosureAcceptedAt: userMasterLiveAccessTable.riskDisclosureAcceptedAt,
      maxLot: userMasterLiveAccessTable.maxLot,
      requireStopLoss: userMasterLiveAccessTable.requireStopLoss,
    }).from(userMasterLiveAccessTable);

    const userApprovals = {
      total: approvalRows.length,
      approvedForMasterLive: approvalRows.filter(r => r.approvedForMasterLive).length,
      pendingReview: approvalRows.filter(r => r.masterLiveStatus === "PENDING_REVIEW").length,
      disabled: approvalRows.filter(r => r.masterLiveStatus === "DISABLED").length,
      suspended: approvalRows.filter(r => r.masterLiveStatus === "SUSPENDED").length,
      riskLocked: approvalRows.filter(r => r.masterLiveStatus === "RISK_LOCKED").length,
      notApproved: approvalRows.filter(r => r.masterLiveStatus === "NOT_APPROVED").length,
      withDisclosureAccepted: approvalRows.filter(r => !!r.riskDisclosureAcceptedAt).length,
      // sample (first 10) — id+status only, no email/IP
      sample: approvalRows.slice(0, 10).map(r => ({
        userId: r.userId,
        approved: r.approvedForMasterLive,
        status: r.masterLiveStatus,
        disclosureAccepted: !!r.riskDisclosureAcceptedAt,
        maxLot: r.maxLot,
        requireStopLoss: r.requireStopLoss,
      })),
    };

    // F. Live test readiness (preview only — operator must click Preflight).
    const [adminDisclosure, adminArming] = await Promise.all([
      db.select({ id: liveRiskDisclosureAcceptancesTable.id })
        .from(liveRiskDisclosureAcceptancesTable)
        .where(eq(liveRiskDisclosureAcceptancesTable.userId, admin.id)).limit(1),
      db.select().from(arxLiveArmingTable)
        .where(eq(arxLiveArmingTable.userId, admin.id)).limit(1),
    ]);
    const liveTestReadiness = {
      currentLiveBridgeDetected: !!det.ok,
      currentLiveBridgePrimaryReason: det.ok ? null : det.primaryReason,
      operatorDisclosureAccepted: adminDisclosure.length > 0,
      operatorArmed: !!adminArming[0]?.isArmed,
      operatorKillSwitchEngaged: !!adminArming[0]?.killSwitchEngaged,
      preflightOnly: true,
      autoFireDisabled: true,
      preflightEndpoint: "/api/admin/live-test-readiness/preflight",
    };

    // G. Reconciliation summary (re-use existing aggregator).
    const recon = await aggregateReconciliationIssues();
    const reconciliationSummary = {
      total: recon.total,
      critical: recon.countsBySeverity?.critical ?? 0,
      high: recon.countsBySeverity?.high ?? 0,
      medium: recon.countsBySeverity?.medium ?? 0,
      low: recon.countsBySeverity?.low ?? 0,
      byType: recon.countsByType ?? {},
    };

    // Audit (one row per panel view).
    try {
      await db.insert(adminActionAuditLogTable).values({
        adminId: admin.id,
        adminRole: admin.role,
        action: "ADMIN_VIEWED_OPERATOR_COMMAND_CENTER",
        targetUserId: null,
        reason: null,
        afterState: { tradingModeLabel, masterSwitch, sharedLiveEnabled, reconTotal: recon.total },
      });
    } catch (e) {
      logger.warn({ err: e }, "operator-command-center audit insert failed (non-fatal)");
    }

    return res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - startedAt,
      systemStatus: {
        appOnline: true,
        apiOk: true,
        databaseOk: dbPing != null,
        cacheMode: "in_process",
        activeUserCount: usrTotal[0]?.n ?? 0,
        currentAppMode: safetyControls.platformMode,
        latestQaStatus: "ARX_AUDIT_FIX_BUILD_READY",
      },
      bridgeStatus: bridge,
      tradingMode: {
        modeLabel: tradingModeLabel,
        platformMasterBridgeConnectionId: platformBridgeId,
        sharedLiveTradingEnabled: sharedLiveEnabled,
        masterLiveUserApprovalRequired: true,
        liveBrokerExecutionEnabled: masterSwitch,
      },
      safetyControls,
      userApprovals,
      liveTestReadiness,
      reconciliationSummary,
      // Never include: raw tokens, hashes, env values, IPs, account numbers
      // beyond those allowed by maskBridgeEvidenceForUser (admin-only mask).
    });
  } catch (e) {
    logger.error({ err: e }, "operator-command-center aggregator failed");
    return res.status(500).json({
      ok: false,
      error: "AGGREGATOR_FAILED",
      reason: (e as Error).message.slice(0, 200),
    });
  }
});

export default router;
