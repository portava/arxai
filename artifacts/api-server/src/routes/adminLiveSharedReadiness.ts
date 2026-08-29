// Admin — Live Shared Account readiness + activation
//
// Unified surface that aggregates the existing scattered live/shared status
// endpoints into one consolidated panel the operator can consume.
//
// SAFETY (inviolable):
//   - All handlers are ADMIN/OWNER-gated.
//   - Zero side-effects from GET /readiness and POST /test-connection except
//     append-only audit rows. They MUST NOT insert into arx_live_commands,
//     MUST NOT contact the EA, and MUST NOT mutate any per-user state.
//   - POST /activate-step performs the explicit operator-confirmed DB writes
//     against global_trading_settings (mode/routing/flag toggles + kill-switch
//     release). It requires a typed confirmation phrase and writes a full
//     before/after audit row to admin_action_audit_log. It does NOT flip
//     the env-level master switch ARX_LIVE_BROKER_EXECUTION_ENABLED —
//     that remains a server-side operator-only env toggle.
//   - Account numbers are masked to the last 4 chars on every response.
//   - Raw bridge tokens / broker passwords / server URLs are never returned.
import express, { type IRouter, Router, type Request, type Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  globalTradingSettingsTable,
  adminActionAuditLogTable,
  mt5ConnectionTable,
  arxLiveCommandsTable,
  arxLivePositionsTable,
  arxLiveArmingTable,
  userMasterLiveAccessTable,
  liveRiskDisclosureAcceptancesTable,
} from "@workspace/db";
import {
  evaluateLivePhaseBDispatchGate,
  type LivePhaseBGateInput,
  MIN_LIVE_EA_VERSION,
  LIVE_HEARTBEAT_MAX_AGE_SEC,
} from "@workspace/domain/safety-contracts/livePhaseBDispatchGate";
import { liveBrokerExecutionEnabled, resolveLiveBrokerExecutionEnabled } from "../lib/live/phaseBConfig.js";
import {
  killSwitchReleaseViolations,
  postureFromSettingsRow,
} from "../lib/phase6/killSwitchReleasePolicy.js";
import { loadAndEvaluateMasterLiveBridgeGate } from "../lib/mt5/masterLiveBridgeGate.js";
import {
  detectCurrentConnectedBridge,
  maskBridgeEvidenceForUser,
} from "../lib/mt5/currentConnectedBridgeDetector.js";
import {
  ARX_LIVE_DEFAULT_ALLOWED_SYMBOLS,
  ARX_LIVE_DEFAULT_MAX_LOT_PER_MARKET,
} from "../lib/live/liveArming.js";
import {
  armRecoveryProbation,
  tightenRecoveryProbation,
  recoveryProbationEnabled,
} from "../lib/recoveryProbation.js";

const router: IRouter = Router();
router.use(express.json());

// Unified confirmation phrase used across all live-shared activation surfaces
// (admin wizard, LiveSharedAccountPanel, ControlledLiveTestButton, scanner
// micro-test, live unlock card). Keeping it identical to
// `LIVE_CONFIRMATION_PHRASE` in `liveArming.ts` so operators see the exact
// same phrase everywhere they're asked to confirm a live action.
const ACTIVATION_CONFIRM_PHRASE = "ENABLE LIVE TRADING" as const;
const KILL_SWITCH_CONFIRM_PHRASE = "ENGAGE KILL SWITCH" as const;

function requireAdmin(
  req: Request,
  res: Response,
): { id: number; role: "ADMIN" | "OWNER" } | null {
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

function maskAccount(num: string | null): string | null {
  if (!num) return null;
  const s = String(num);
  if (s.length <= 4) return `••${s}`;
  return `••••${s.slice(-4)}`;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function writeAuditOn(
  exec: typeof db | Tx,
  args: {
    adminId: number;
    adminRole: string;
    action: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  },
): Promise<void> {
  // before_state / after_state are NOT NULL in DB with default {}; passing
  // explicit null violates the constraint, so coalesce to {} not null.
  await exec.insert(adminActionAuditLogTable).values({
    adminId: args.adminId,
    adminRole: args.adminRole,
    action: args.action,
    beforeState: (args.before ?? {}) as Record<string, unknown>,
    afterState: (args.after ?? {}) as Record<string, unknown>,
  });
}
async function writeAudit(args: {
  adminId: number;
  adminRole: string;
  action: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}): Promise<void> {
  await writeAuditOn(db, args);
}
// Best-effort audit: never throw — readiness/test-connection must not 500
// because the audit insert hiccupped.
async function tryAudit(
  req: Request,
  args: Parameters<typeof writeAudit>[0],
): Promise<void> {
  try {
    await writeAudit(args);
  } catch (e) {
    (req as Request & { log?: { warn: (o: unknown, m?: string) => void } }).log?.warn(
      { err: (e as Error).message, action: args.action },
      "live_shared_readiness_audit_write_failed",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/live-shared/readiness
// Consolidated read-only panel data. Append-only audit row.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/admin/live-shared/readiness", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  try {
  const settingsRow = (await db.select().from(globalTradingSettingsTable).limit(1))[0] ?? null;
  const masterSwitchEnvOnly = liveBrokerExecutionEnabled();
  // Effective master switch = env OR DB-armed. The DB flag is the admin-
  // controllable arm switch; the env var remains a hard kill override.
  const masterSwitch = resolveLiveBrokerExecutionEnabled(settingsRow);
  const liveBrokerExecutionArmedDb = settingsRow?.liveBrokerExecutionArmed === true;

  // Master live bridge — detector + gate
  const detector = await detectCurrentConnectedBridge();
  const bridgeGate = await loadAndEvaluateMasterLiveBridgeGate();
  let pinnedBridge: typeof mt5ConnectionTable.$inferSelect | null = null;
  if (settingsRow?.platformMasterBridgeConnectionId != null) {
    pinnedBridge =
      (
        await db
          .select()
          .from(mt5ConnectionTable)
          .where(eq(mt5ConnectionTable.id, settingsRow.platformMasterBridgeConnectionId))
          .limit(1)
      )[0] ?? null;
  }
  const bridgeForUi = pinnedBridge
    ? {
        connectionId: pinnedBridge.id,
        mode: pinnedBridge.mode,
        accountType: pinnedBridge.accountType,
        accountNumberMasked: maskAccount(pinnedBridge.accountNumber),
        brokerName: pinnedBridge.brokerName,
        eaVersion: pinnedBridge.eaVersion,
        lastHeartbeatAt: pinnedBridge.lastHeartbeat?.toISOString() ?? null,
        heartbeatAgeSeconds: pinnedBridge.lastHeartbeat
          ? Math.max(
              0,
              Math.floor((Date.now() - new Date(pinnedBridge.lastHeartbeat).getTime()) / 1000),
            )
          : null,
        readOnlyMode: pinnedBridge.readOnlyMode,
        tokenRevokedAt: pinnedBridge.tokenRevokedAt?.toISOString() ?? null,
        // Task #30 — EA host clock drift surface (admin-only). SEVERE drift
        // additively blocks the Live Test cycle; WARN is informational.
        clockDriftSeconds: pinnedBridge.clockDriftSeconds ?? null,
        clockDriftSeverity: pinnedBridge.clockDriftSeverity ?? "OK",
      }
    : null;

  // Approved users
  const approvedUsersRaw = await db
    .select({
      userId: userMasterLiveAccessTable.userId,
      email: usersTable.email,
      approvedForMasterLive: userMasterLiveAccessTable.approvedForMasterLive,
      masterLiveTradingEnabled: userMasterLiveAccessTable.masterLiveTradingEnabled,
      status: userMasterLiveAccessTable.masterLiveStatus,
      maxLot: userMasterLiveAccessTable.maxLot,
      maxOpenPositions: userMasterLiveAccessTable.maxOpenPositions,
      maxExposurePerSymbolLots: userMasterLiveAccessTable.maxExposurePerSymbolLots,
      dailyLossLimitUsd: userMasterLiveAccessTable.dailyLossLimitUsd,
      allowedSymbols: userMasterLiveAccessTable.allowedSymbols,
      scannerLiveEnabled: userMasterLiveAccessTable.scannerLiveEnabled,
      approvedAt: userMasterLiveAccessTable.masterLiveApprovedAt,
    })
    .from(userMasterLiveAccessTable)
    .leftJoin(usersTable, eq(usersTable.id, userMasterLiveAccessTable.userId))
    .orderBy(desc(userMasterLiveAccessTable.masterLiveApprovedAt));
  const approvedUsersCount = approvedUsersRaw.filter(
    (u) => u.approvedForMasterLive === true,
  ).length;
  const activeUsersCount = approvedUsersRaw.filter(
    (u) => u.approvedForMasterLive === true && u.masterLiveTradingEnabled === true,
  ).length;

  // Open exposure across all users
  const openExposure = (
    await db
      .select({
        lots: sql<number>`COALESCE(SUM(${arxLivePositionsTable.volume}), 0)`,
        floatingPl: sql<number>`COALESCE(SUM(${arxLivePositionsTable.floatingPl}), 0)`,
        n: sql<number>`COUNT(*)::int`,
      })
      .from(arxLivePositionsTable)
      .where(sql`${arxLivePositionsTable.closedAt} IS NULL`)
  )[0] ?? { lots: 0, floatingPl: 0, n: 0 };

  // Recent commands (last 25)
  const recentCmds = await db
    .select({
      id: arxLiveCommandsTable.id,
      userId: arxLiveCommandsTable.userId,
      symbol: arxLiveCommandsTable.symbol,
      side: arxLiveCommandsTable.side,
      volume: arxLiveCommandsTable.requestedVolume,
      status: arxLiveCommandsTable.status,
      blockReason: arxLiveCommandsTable.rejectionReason,
      createdAt: arxLiveCommandsTable.createdAt,
    })
    .from(arxLiveCommandsTable)
    .orderBy(desc(arxLiveCommandsTable.createdAt))
    .limit(25);

  // Recent audit
  const recentAudit = await db
    .select({
      id: adminActionAuditLogTable.id,
      adminId: adminActionAuditLogTable.adminId,
      adminRole: adminActionAuditLogTable.adminRole,
      action: adminActionAuditLogTable.action,
      createdAt: adminActionAuditLogTable.createdAt,
    })
    .from(adminActionAuditLogTable)
    .orderBy(desc(adminActionAuditLogTable.createdAt))
    .limit(50);

  const liveCount = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(arxLiveCommandsTable);

  await tryAudit(req, {
    adminId: admin.id,
    adminRole: admin.role,
    action: "ADMIN_VIEWED_LIVE_SHARED_READINESS",
    after: {
      arxLiveCommandsCount: Number(liveCount[0]?.n ?? 0),
      masterSwitch,
      platformMode: settingsRow?.platformMode ?? "OFF",
      accountRoutingMode: settingsRow?.accountRoutingMode ?? "USER_OWNED_MT5",
    },
  });

  res.json({
    ok: true,
    architecture: {
      model: "EA_PULL",
      summary:
        "The operator runs MT5 with EA v1.27 on a Windows VPS. Broker credentials live only on that VPS. The API server never stores broker login/password. Trade commands are queued in arx_live_commands and pulled by the EA over HTTPS using a per-user bridge token.",
      brokerCredentialsOnServer: false,
    },
    globalSwitches: {
      // Effective master switch: env OR DB-armed. Treat THIS as the "is
      // live execution actually enabled?" signal for downstream logic.
      serverMasterSwitchEnabled: masterSwitch,
      // Source breakdown so the UI can distinguish "armed by admin via UI"
      // from "set via Replit Secret env var" (env is a hard-kill override).
      serverMasterSwitchEnvOnly: masterSwitchEnvOnly,
      liveBrokerExecutionArmedDb,
      liveBrokerExecutionArmedAt: settingsRow?.liveBrokerExecutionArmedAt ?? null,
      liveBrokerExecutionArmedBy: settingsRow?.liveBrokerExecutionArmedBy ?? null,
      liveBrokerExecutionArmedBridgeId: settingsRow?.liveBrokerExecutionArmedBridgeId ?? null,
      platformMode: settingsRow?.platformMode ?? "OFF",
      liveEnabled: settingsRow?.liveEnabled ?? false,
      accountRoutingMode: settingsRow?.accountRoutingMode ?? "USER_OWNED_MT5",
      sharedLiveTradingEnabled: settingsRow?.sharedLiveTradingEnabled ?? false,
      masterBridgeLiveEnabled: settingsRow?.masterBridgeLiveEnabled ?? false,
      complianceReviewFlag: settingsRow?.complianceReviewFlag ?? false,
      emergencyKillSwitch: settingsRow?.emergencyKillSwitch ?? true,
      killSwitchEngagedAt: settingsRow?.killSwitchEngagedAt ?? null,
      killSwitchReason: settingsRow?.killSwitchReason ?? null,
    },
    liveAccount: {
      pinnedBridge: bridgeForUi,
      detector: detector.ok
        ? { detected: true, bridge: maskBridgeEvidenceForUser(detector.bridge) }
        : {
            detected: false,
            primaryReason: detector.primaryReason,
            latestHint: detector.latestHint ? maskBridgeEvidenceForUser(detector.latestHint) : null,
          },
      // Raw detected bridge identity surfaced ONLY on this admin/owner-gated
      // endpoint so the operator can compare the typed account-confirmation
      // input against the actual EA-reported account number. Per the safety
      // notes, account numbers may be returned to OWNER/ADMIN sessions on
      // operator endpoints. Never returned to anonymous or user-scope routes.
      detectedAccountNumber: detector.ok ? detector.bridge.accountNumber : null,
      detectedBrokerName: detector.ok ? detector.bridge.brokerName : null,
      detectedServerName: detector.ok ? detector.bridge.serverName : null,
      gate: bridgeGate,
    },
    approvedUsers: {
      approvedCount: approvedUsersCount,
      activeCount: activeUsersCount,
      rows: approvedUsersRaw.map((u) => ({
        userId: u.userId,
        email: u.email,
        approved: u.approvedForMasterLive === true,
        tradingEnabled: u.masterLiveTradingEnabled === true,
        status: u.status,
        maxLot: u.maxLot,
        maxOpenPositions: u.maxOpenPositions,
        maxExposurePerSymbolLots: u.maxExposurePerSymbolLots,
        dailyLossLimitUsd: u.dailyLossLimitUsd,
        allowedSymbols: u.allowedSymbols,
        scannerLiveEnabled: u.scannerLiveEnabled,
        approvedAt: u.approvedAt,
      })),
    },
    openExposure: {
      totalOpenLots: Number(openExposure.lots ?? 0),
      totalFloatingPlUsd: Number(openExposure.floatingPl ?? 0),
      openPositionsCount: Number(openExposure.n ?? 0),
    },
    recentCommands: recentCmds.map((c) => ({
      id: c.id,
      userId: c.userId,
      symbol: c.symbol,
      side: c.side,
      volume: c.volume,
      status: c.status,
      blockReason: c.blockReason,
      createdAt: c.createdAt,
    })),
    recentAudit,
    arxLiveCommandsCount: Number(liveCount[0]?.n ?? 0),
    constants: {
      MIN_LIVE_EA_VERSION,
      LIVE_HEARTBEAT_MAX_AGE_SEC,
      DEFAULT_ALLOWED_SYMBOLS: ARX_LIVE_DEFAULT_ALLOWED_SYMBOLS,
      DEFAULT_MAX_LOT_PER_MARKET: ARX_LIVE_DEFAULT_MAX_LOT_PER_MARKET,
    },
    requiredConfirmationPhrases: {
      activate: ACTIVATION_CONFIRM_PHRASE,
      killSwitch: KILL_SWITCH_CONFIRM_PHRASE,
    },
    safetyEnvelope: {
      didCreateLiveCommand: false,
      didDispatchToMt5: false,
      didMutateAnyUserState: false,
    },
  });
  } catch (err) {
    // Never leak INTERNAL_ERROR / stack traces / DB errors to the page.
    // Return a safe structured shape so the UI can render "not_configured"
    // chips and a meaningful banner instead of a raw error string.
    (req as Request & { log?: { error: (o: unknown, m?: string) => void } }).log?.error(
      { err: (err as Error).message, stack: (err as Error).stack },
      "admin_live_shared_readiness_failed_safely",
    );
    const envOnly = (() => { try { return liveBrokerExecutionEnabled(); } catch { return false; } })();
    res.status(200).json({
      ok: true,
      degraded: true,
      degradedReason: "READINESS_QUERY_FAILED",
      message:
        "Live Shared readiness data is temporarily unavailable. Live dispatch remains blocked while readiness cannot be evaluated.",
      architecture: { model: "EA_PULL", brokerCredentialsOnServer: false },
      globalSwitches: {
        serverMasterSwitchEnabled: envOnly,
        serverMasterSwitchEnvOnly: envOnly,
        liveBrokerExecutionArmedDb: false,
        liveBrokerExecutionArmedAt: null,
        liveBrokerExecutionArmedBy: null,
        liveBrokerExecutionArmedBridgeId: null,
        platformMode: "UNKNOWN",
        liveEnabled: false,
        accountRoutingMode: "USER_OWNED_MT5",
        sharedLiveTradingEnabled: false,
        masterBridgeLiveEnabled: false,
        complianceReviewFlag: false,
        emergencyKillSwitch: true,
        killSwitchEngagedAt: null,
        killSwitchReason: null,
      },
      liveAccount: {
        pinnedBridge: null,
        detector: { detected: false, primaryReason: "READINESS_DEGRADED" },
        detectedAccountNumber: null,
        detectedBrokerName: null,
        detectedServerName: null,
        gate: { decision: "BLOCKED", primaryReason: "READINESS_DEGRADED" },
      },
      approvedUsers: { approvedCount: 0, activeCount: 0, rows: [] },
      openExposure: { totalOpenLots: 0, totalFloatingPlUsd: 0, openPositionsCount: 0 },
      recentCommands: [],
      recentAudit: [],
      arxLiveCommandsCount: 0,
      constants: {
        MIN_LIVE_EA_VERSION,
        LIVE_HEARTBEAT_MAX_AGE_SEC,
        DEFAULT_ALLOWED_SYMBOLS: ARX_LIVE_DEFAULT_ALLOWED_SYMBOLS,
        DEFAULT_MAX_LOT_PER_MARKET: ARX_LIVE_DEFAULT_MAX_LOT_PER_MARKET,
      },
      requiredConfirmationPhrases: {
        activate: ACTIVATION_CONFIRM_PHRASE,
        killSwitch: KILL_SWITCH_CONFIRM_PHRASE,
      },
      safetyEnvelope: {
        didCreateLiveCommand: false,
        didDispatchToMt5: false,
        didMutateAnyUserState: false,
      },
      canAttemptLiveTest: false,
      lastUpdated: new Date().toISOString(),
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/live-shared/test-connection
// Run the master-live bridge detector + master-live gate. Dry-run only.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/admin/live-shared/test-connection", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const detector = await detectCurrentConnectedBridge();
  const bridgeGate = await loadAndEvaluateMasterLiveBridgeGate();

  const settingsRow = (await db.select().from(globalTradingSettingsTable).limit(1))[0] ?? null;
  const masterSwitch = resolveLiveBrokerExecutionEnabled(settingsRow);

  // Run the 16-gate Phase B evaluator from the operator's own perspective so
  // the response shows exactly which gates would block a real dispatch right
  // now. This is a pure function — no DB writes to arx_live_commands.
  let preflight: ReturnType<typeof evaluateLivePhaseBDispatchGate> | null = null;
  if (detector.ok) {
    const access = (
      await db
        .select()
        .from(userMasterLiveAccessTable)
        .where(eq(userMasterLiveAccessTable.userId, admin.id))
        .limit(1)
    )[0] ?? null;
    const arming = (
      await db
        .select()
        .from(arxLiveArmingTable)
        .where(eq(arxLiveArmingTable.userId, admin.id))
        .limit(1)
    )[0] ?? null;
    const disclosure =
      (
        await db
          .select({ id: liveRiskDisclosureAcceptancesTable.id })
          .from(liveRiskDisclosureAcceptancesTable)
          .where(eq(liveRiskDisclosureAcceptancesTable.userId, admin.id))
          .limit(1)
      ).length > 0;
    const realisedToday = await db
      .select({
        pnl: sql<number>`COALESCE(SUM(${arxLivePositionsTable.floatingPl}), 0)`,
      })
      .from(arxLivePositionsTable)
      .where(
        and(
          eq(arxLivePositionsTable.userId, admin.id),
          sql`${arxLivePositionsTable.closedAt} >= NOW() - INTERVAL '24 hours'`,
        ),
      );
    const realisedDailyLossUsd = Math.max(0, -Number(realisedToday[0]?.pnl ?? 0));
    const input: LivePhaseBGateInput = {
      liveBrokerExecutionEnabled: masterSwitch,
      globalLiveEnabled: settingsRow?.liveEnabled ?? false,
      userLiveApproved: access?.approvedForMasterLive ?? false,
      userArmed: arming?.isArmed ?? false,
      killSwitchEngaged:
        (arming?.killSwitchEngaged ?? false) || (settingsRow?.emergencyKillSwitch ?? true) === true,
      bridgeAccountType: detector.bridge.accountType ?? null,
      bridgeHeartbeatAgeSec: detector.bridge.heartbeatAgeSec,
      bridgeEaVersion: detector.bridge.eaVersion,
      bridgeEnableLiveExecution: detector.bridge.eaInputs.enableLiveExecution,
      bridgeReadOnlyMode: detector.bridge.eaInputs.readOnlyMode,
      bridgeTerminalConnected: detector.bridge.eaInputs.terminalConnected,
      bridgeAlgoTradingAllowed: detector.bridge.eaInputs.algoTradingAllowed,
      commandSymbol: "EURUSD",
      commandVolume: 0.01,
      commandHasStopLoss: true,
      allowedSymbols:
        access?.allowedSymbols && access.allowedSymbols.length > 0
          ? access.allowedSymbols
          : ARX_LIVE_DEFAULT_ALLOWED_SYMBOLS,
      maxLotForSymbol:
        access?.maxLot ?? ARX_LIVE_DEFAULT_MAX_LOT_PER_MARKET["EURUSD"] ?? 0.01,
      dailyLossLimitUsd: access?.dailyLossLimitUsd ?? 0,
      realisedDailyLossUsd,
      requireStopLoss: access?.requireStopLoss ?? true,
      adminAllowNoStopLoss: false,
      requireTakeProfit: access?.requireTakeProfit ?? true,
      adminAllowNoTakeProfit: false,
      commandHasTakeProfit: true,
      disclosureAccepted: disclosure,
    };
    preflight = evaluateLivePhaseBDispatchGate(input);
  }

  const liveCountAfter = Number(
    (await db.select({ n: sql<number>`COUNT(*)::int` }).from(arxLiveCommandsTable))[0]?.n ?? 0,
  );

  await writeAudit({
    adminId: admin.id,
    adminRole: admin.role,
    action: "ADMIN_RAN_LIVE_SHARED_TEST_CONNECTION",
    after: {
      detectorOk: detector.ok,
      detectorPrimaryReason: detector.ok ? null : detector.primaryReason,
      bridgeGateDecision: bridgeGate.decision,
      bridgeGatePrimaryReason: bridgeGate.decision === "BLOCKED" ? bridgeGate.primaryReason : null,
      preflightDecision: preflight?.decision ?? null,
      preflightPrimaryReason: preflight?.primaryReason ?? null,
      arxLiveCommandsAfter: liveCountAfter,
    },
  });

  res.json({
    ok: true,
    isDryRun: true,
    detector: detector.ok
      ? { detected: true, bridge: maskBridgeEvidenceForUser(detector.bridge) }
      : { detected: false, primaryReason: detector.primaryReason },
    bridgeGate,
    preflight: preflight
      ? {
          decision: preflight.decision,
          primaryReason: preflight.primaryReason,
          blockReasons: preflight.blockReasons,
          gates: preflight.gates,
          evaluatedAt: preflight.evaluatedAt,
        }
      : null,
    arxLiveCommandsAfter: liveCountAfter,
    safetyEnvelope: {
      didCreateLiveCommand: false,
      didDispatchToMt5: false,
      didCallOrderSend: false,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/live-shared/activate-step
// Atomic operator-confirmed write to global_trading_settings. Requires
// typed confirmation phrase. Does NOT flip the env-level master switch.
//
// Body:
//   confirmationPhrase: "ENABLE LIVE TRADING"  // mandatory
//   accountRoutingMode?: "SHARED_MASTER_MT5"            // optional
//   sharedLiveTradingEnabled?: boolean                  // optional
//   masterBridgeLiveEnabled?: boolean                   // optional
//   platformMode?: "DEMO" | "LIVE"                      // optional
//   liveEnabled?: boolean                               // optional
//   releaseKillSwitch?: boolean                         // optional
// ─────────────────────────────────────────────────────────────────────────────
router.post("/admin/live-shared/activate-step", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  // Phase 22V: switch-based flow. Accept `{ confirm: true }` from the new
  // switch+modal UI; legacy typed phrase still accepted for back-compat
  // with CI tests until the next sweep.
  const confirmed = body.confirm === true || body.confirmationPhrase === ACTIVATION_CONFIRM_PHRASE;
  if (!confirmed) {
    res.status(400).json({
      ok: false,
      error: "CONFIRMATION_REQUIRED",
      detail: "Send { confirm: true } from the switch-based UI.",
    });
    return;
  }

  const settingsRow = (await db.select().from(globalTradingSettingsTable).limit(1))[0];
  if (!settingsRow) {
    res.status(500).json({ ok: false, error: "SETTINGS_ROW_MISSING" });
    return;
  }

  // Build the patch first so we can compute the post-write state and reject
  // dangerous combinations atomically BEFORE writing.
  const patch: Partial<typeof globalTradingSettingsTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.accountRoutingMode === "SHARED_MASTER_MT5" || body.accountRoutingMode === "USER_OWNED_MT5") {
    patch.accountRoutingMode = body.accountRoutingMode;
    patch.sharedLiveConnectionId =
      body.accountRoutingMode === "SHARED_MASTER_MT5"
        ? settingsRow.platformMasterBridgeConnectionId
        : null;
  }
  if (typeof body.sharedLiveTradingEnabled === "boolean") {
    patch.sharedLiveTradingEnabled = body.sharedLiveTradingEnabled;
  }
  if (typeof body.masterBridgeLiveEnabled === "boolean") {
    patch.masterBridgeLiveEnabled = body.masterBridgeLiveEnabled;
  }
  if (body.platformMode === "DEMO" || body.platformMode === "LIVE" || body.platformMode === "OFF" || body.platformMode === "SIMULATED") {
    patch.platformMode = body.platformMode;
  }
  if (typeof body.liveEnabled === "boolean") {
    patch.liveEnabled = body.liveEnabled;
  }
  if (body.releaseKillSwitch === true) {
    patch.emergencyKillSwitch = false;
    patch.killSwitchEngagedAt = null;
    patch.killSwitchReason = null;
  }

  // Compute the post-write state (current + patch) for precondition checks.
  const projected = {
    accountRoutingMode: patch.accountRoutingMode ?? settingsRow.accountRoutingMode,
    sharedLiveTradingEnabled: patch.sharedLiveTradingEnabled ?? settingsRow.sharedLiveTradingEnabled,
    masterBridgeLiveEnabled: patch.masterBridgeLiveEnabled ?? settingsRow.masterBridgeLiveEnabled,
    platformMode: patch.platformMode ?? settingsRow.platformMode,
    liveEnabled: patch.liveEnabled ?? settingsRow.liveEnabled,
    emergencyKillSwitch: patch.emergencyKillSwitch ?? settingsRow.emergencyKillSwitch,
    platformMasterBridgeConnectionId: settingsRow.platformMasterBridgeConnectionId,
  };

  // Refuse to activate shared-live unless a pinned master bridge exists.
  const wantsSharedOn =
    projected.accountRoutingMode === "SHARED_MASTER_MT5" ||
    projected.sharedLiveTradingEnabled === true ||
    projected.masterBridgeLiveEnabled === true;
  if (wantsSharedOn && projected.platformMasterBridgeConnectionId == null) {
    res.status(409).json({
      ok: false,
      error: "MASTER_BRIDGE_NOT_PINNED",
      detail:
        "Pin a master bridge first via POST /api/admin/master-bridge/snapshot (the operator must attach EA v1.27 to the LIVE master MT5 chart).",
    });
    return;
  }

  // FOOTGUN GUARD: any of (platformMode=LIVE, liveEnabled=true, kill-switch
  // release) MUST happen against a fully shared-mode posture — routing
  // SHARED_MASTER_MT5 + both shared flags on + bridge pinned. Otherwise the
  // legacy per-user Phase B dispatch surface could be reached unintentionally.
  const touchingLiveControls =
    body.platformMode === "LIVE" ||
    body.liveEnabled === true ||
    body.releaseKillSwitch === true;
  if (touchingLiveControls) {
    const sharedPostureOk =
      projected.accountRoutingMode === "SHARED_MASTER_MT5" &&
      projected.sharedLiveTradingEnabled === true &&
      projected.masterBridgeLiveEnabled === true &&
      projected.platformMasterBridgeConnectionId != null;
    if (!sharedPostureOk) {
      res.status(409).json({
        ok: false,
        error: "SHARED_POSTURE_REQUIRED_FOR_LIVE_CONTROLS",
        detail:
          "platformMode=LIVE, liveEnabled=true, and kill-switch release may only be applied while accountRoutingMode=SHARED_MASTER_MT5, sharedLiveTradingEnabled=true, masterBridgeLiveEnabled=true, and a master bridge is pinned. Switch shared posture on first in earlier steps.",
        projected,
      });
      return;
    }
  }

  const before = {
    accountRoutingMode: settingsRow.accountRoutingMode,
    sharedLiveTradingEnabled: settingsRow.sharedLiveTradingEnabled,
    masterBridgeLiveEnabled: settingsRow.masterBridgeLiveEnabled,
    platformMode: settingsRow.platformMode,
    liveEnabled: settingsRow.liveEnabled,
    emergencyKillSwitch: settingsRow.emergencyKillSwitch,
    sharedLiveConnectionId: settingsRow.sharedLiveConnectionId,
  };

  // ATOMIC: settings update + audit insert in a single DB transaction.
  // Either both happen or neither — no silent state mutation without trail.
  const after = await db.transaction(async (tx) => {
    await tx
      .update(globalTradingSettingsTable)
      .set(patch)
      .where(eq(globalTradingSettingsTable.id, settingsRow.id));
    // ── #34 Recovery probation — a HOT release (full activate-step ceremony)
    // re-opens the live path at REDUCED_SIZE first, never full authority.
    // Same-transaction: a failed arm rolls the release back (fail closed).
    // Advancement to full authority = owner presses on
    // POST /api/admin/recovery-probation/advance.
    if (
      body.releaseKillSwitch === true &&
      settingsRow.emergencyKillSwitch === true &&
      recoveryProbationEnabled(process.env["ARX_RECOVERY_PROBATION_ENABLED"])
    ) {
      await armRecoveryProbation(tx, {
        source: "activate_step_release",
        actor: `admin:${admin.id}`,
        reason: "kill switch released via the activate-step ceremony (shared-live posture)",
      });
    }
    const post = (await tx.select().from(globalTradingSettingsTable).limit(1))[0]!;
    await writeAuditOn(tx, {
      adminId: admin.id,
      adminRole: admin.role,
      action: "ADMIN_ACTIVATED_LIVE_SHARED_STEP",
      before,
      after: {
        accountRoutingMode: post.accountRoutingMode,
        sharedLiveTradingEnabled: post.sharedLiveTradingEnabled,
        masterBridgeLiveEnabled: post.masterBridgeLiveEnabled,
        platformMode: post.platformMode,
        liveEnabled: post.liveEnabled,
        emergencyKillSwitch: post.emergencyKillSwitch,
        sharedLiveConnectionId: post.sharedLiveConnectionId,
      },
    });
    return post;
  });

  res.json({
    ok: true,
    before,
    after: {
      accountRoutingMode: after.accountRoutingMode,
      sharedLiveTradingEnabled: after.sharedLiveTradingEnabled,
      masterBridgeLiveEnabled: after.masterBridgeLiveEnabled,
      platformMode: after.platformMode,
      liveEnabled: after.liveEnabled,
      emergencyKillSwitch: after.emergencyKillSwitch,
      sharedLiveConnectionId: after.sharedLiveConnectionId,
    },
    reminder:
      "Server-side env switch ARX_LIVE_BROKER_EXECUTION_ENABLED must also be set to 'true' for the Phase B 16-gate evaluator to consider PASS. The default remains deny.",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/live-shared/kill-switch
// Operator-confirmed kill switch engage.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/admin/live-shared/kill-switch", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.confirm !== true && body.confirmationPhrase !== KILL_SWITCH_CONFIRM_PHRASE) {
    res.status(400).json({
      ok: false,
      error: "CONFIRMATION_REQUIRED",
      detail: "Send { confirm: true } from the switch-based UI.",
    });
    return;
  }
  const reason = typeof body.reason === "string" && body.reason.length > 0 ? body.reason : "ADMIN_INITIATED";

  // ── RELEASE — the cold-platform doorway ─────────────────────────────────
  // The activate-step ceremony (full MT5 shared-live posture) remains the
  // ONLY hot release path. This branch permits release exclusively while the
  // platform is provably cold — see killSwitchReleasePolicy.ts for why a
  // cold release cannot enable live execution by itself.
  if (body.action === "RELEASE") {
    const envEnabled = liveBrokerExecutionEnabled();
    // Captured for the hoisted transaction closure (TS narrowing does not
    // cross function boundaries; requireAdmin already returned on null).
    const adminActor = { id: admin.id, role: admin.role };
    type ReleaseOutcome =
      | { released: true; violations: string[] }
      | { released: false; violations: string[] };
    let outcome: ReleaseOutcome;
    try {
      outcome = await releaseTx();
    } catch (err) {
      // A failed probation arm (or any other write) rolled the release back —
      // the switch is still engaged. Report honestly instead of a bare 500.
      res.status(409).json({
        ok: false,
        error: "RELEASE_ROLLED_BACK",
        detail:
          "The release transaction failed and was rolled back; the kill switch remains engaged. " +
          "If the error names recovery_probations, apply docs/migrations-pending/build-engine-drivers.sql first. " +
          `Cause: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    async function releaseTx(): Promise<ReleaseOutcome> {
      return db.transaction(async (tx) => {
      // The settings table is a by-convention singleton with no unique
      // constraint; serialize with any concurrent bootstrap so two callers
      // cannot create two rows. Namespace 0x41525807 = "ARX" + 07 (phase 6
      // uses 0x41525806 for guided dispatch; this is the settings singleton).
      await tx.execute(sql`select pg_advisory_xact_lock(${0x4152_5807}, ${1})`);
      let row = (await tx.select().from(globalTradingSettingsTable).limit(1))[0];
      if (!row) {
        // Create the fail-closed default row (kill switch ENGAGED) so the
        // release below is an explicit, audited transition — the row is
        // never BORN released.
        row = (await tx.insert(globalTradingSettingsTable)
          .values({ updatedAt: new Date() }).returning())[0]!;
      }
      const posture = postureFromSettingsRow(row, envEnabled);
      const violations = killSwitchReleaseViolations(posture);
      if (violations.length > 0) {
        return { released: false as const, violations };
      }
      await tx
        .update(globalTradingSettingsTable)
        .set({
          emergencyKillSwitch: false,
          killSwitchEngagedAt: null,
          killSwitchReason: null,
          updatedAt: new Date(),
        })
        .where(eq(globalTradingSettingsTable.id, row.id));
      // ── #34 Recovery probation — a release NEVER restores full authority ──
      // in one step. Arm (or tighten-merge into) the graduated probation on
      // the SAME transaction: if the probation row cannot be written (e.g.
      // docs/migrations-pending/build-engine-drivers.sql not applied yet) the
      // release itself rolls back and the switch stays engaged — fail closed.
      // Advancing stages toward full authority takes owner presses on
      // POST /api/admin/recovery-probation/advance, one stage per press.
      if (recoveryProbationEnabled(process.env["ARX_RECOVERY_PROBATION_ENABLED"])) {
        await armRecoveryProbation(tx, {
          source: "kill_switch_release",
          actor: `admin:${adminActor.id}`,
          reason: `kill switch released (cold posture): ${reason}`,
        });
      }
      await writeAuditOn(tx, {
        adminId: adminActor.id,
        adminRole: adminActor.role,
        action: "ADMIN_RELEASED_LIVE_SHARED_KILL_SWITCH",
        before: {
          emergencyKillSwitch: row.emergencyKillSwitch,
          killSwitchEngagedAt: row.killSwitchEngagedAt,
          killSwitchReason: row.killSwitchReason,
          posture,
        },
        after: {
          emergencyKillSwitch: false,
          releaseReason: reason,
          coldPostureVerified: true,
        },
      });
      return { released: true as const, violations: [] as string[] };
      });
    }
    if (!outcome.released) {
      res.status(409).json({
        ok: false,
        error: "COLD_POSTURE_REQUIRED_FOR_RELEASE",
        violations: outcome.violations,
        detail:
          "The kill switch may be released outside the activate-step ceremony only while every " +
          "live control is off. Releasing while any listed control is hot requires the full " +
          "shared-live activation flow (POST /api/admin/live-shared/activate-step).",
      });
      return;
    }
    res.json({ ok: true, killSwitchEngaged: false, reason });
    return;
  }

  const settingsRow = (await db.select().from(globalTradingSettingsTable).limit(1))[0];
  if (!settingsRow) {
    res.status(500).json({ ok: false, error: "SETTINGS_ROW_MISSING" });
    return;
  }
  // ATOMIC: kill-switch flip + audit insert in a single transaction.
  await db.transaction(async (tx) => {
    await tx
      .update(globalTradingSettingsTable)
      .set({
        emergencyKillSwitch: true,
        killSwitchEngagedAt: new Date(),
        killSwitchReason: reason,
        sharedLiveTradingEnabled: false,
        masterBridgeLiveEnabled: false,
        updatedAt: new Date(),
      })
      .where(eq(globalTradingSettingsTable.id, settingsRow.id));
    await writeAuditOn(tx, {
      adminId: admin.id,
      adminRole: admin.role,
      action: "ADMIN_ENGAGED_LIVE_SHARED_KILL_SWITCH",
      before: {
        emergencyKillSwitch: settingsRow.emergencyKillSwitch,
        sharedLiveTradingEnabled: settingsRow.sharedLiveTradingEnabled,
        masterBridgeLiveEnabled: settingsRow.masterBridgeLiveEnabled,
      },
      after: {
        emergencyKillSwitch: true,
        sharedLiveTradingEnabled: false,
        masterBridgeLiveEnabled: false,
        killSwitchReason: reason,
      },
    });
  });
  // #34 — an ENGAGE is an emergency: automatically tighten any active
  // probation to BLOCK_ALL (toward LESS authority — the only automatic
  // direction). Best-effort and non-fatal: the switch itself is already the
  // hard wall; a failed tighten is logged inside the service, never a 500.
  if (recoveryProbationEnabled(process.env["ARX_RECOVERY_PROBATION_ENABLED"])) {
    await tightenRecoveryProbation({
      toStage: "BLOCK_ALL",
      actor: `admin:${admin.id}`,
      reason: `kill switch engaged: ${reason}`,
    }).catch(() => undefined);
  }
  res.json({ ok: true, killSwitchEngaged: true, reason });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/live-shared/arm-live-execution
// Admin-only. Flips `liveBrokerExecutionArmed=true` ONLY when every pre-arm
// safety check passes (server-side re-validation) + typed confirmation phrase
// + exact account/broker/server confirmation. Writes a full before/after
// audit row capturing who/old/new/bridge/account/broker/server/reason.
// Emergency kill switch always blocks; if engaged, returns 409.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/admin/live-shared/arm-live-execution", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.confirm !== true && body.confirmationPhrase !== ACTIVATION_CONFIRM_PHRASE) {
    res.status(400).json({
      ok: false, error: "CONFIRMATION_REQUIRED",
      detail: "Send { confirm: true } from the switch-based UI.",
    });
    return;
  }

  const settingsRow = (await db.select().from(globalTradingSettingsTable).limit(1))[0] ?? null;
  if (!settingsRow) { res.status(500).json({ ok: false, error: "SETTINGS_ROW_MISSING" }); return; }

  // Kill switch trumps everything.
  if (settingsRow.emergencyKillSwitch === true) {
    res.status(409).json({
      ok: false, error: "KILL_SWITCH_ACTIVE",
      detail: "Emergency kill switch is engaged. Release it before arming live execution.",
    });
    return;
  }

  // Detect freshest live bridge and validate the confirmation triple.
  const detector = await detectCurrentConnectedBridge();
  if (!detector.ok) {
    res.status(409).json({
      ok: false, error: "NO_LIVE_BRIDGE_DETECTED",
      detail: detector.primaryReason,
    });
    return;
  }
  const detected = {
    account: String(detector.bridge.accountNumber ?? "").trim(),
    broker: String(detector.bridge.brokerName ?? "").trim(),
    server: String(detector.bridge.serverName ?? "").trim(),
  };
  const confirmed = {
    account: typeof body.accountConfirm === "string" ? body.accountConfirm.trim() : "",
    broker: typeof body.brokerConfirm === "string" ? body.brokerConfirm.trim() : "",
    server: typeof body.serverConfirm === "string" ? body.serverConfirm.trim() : "",
  };
  const mismatches: string[] = [];
  if (!detected.account || confirmed.account !== detected.account) mismatches.push(`account expected="${detected.account}" got="${confirmed.account}"`);
  if (!detected.broker || confirmed.broker !== detected.broker) mismatches.push(`broker expected="${detected.broker}" got="${confirmed.broker}"`);
  if (!detected.server || confirmed.server !== detected.server) mismatches.push(`server expected="${detected.server}" got="${confirmed.server}"`);
  if (mismatches.length > 0) {
    res.status(400).json({
      ok: false, error: "BRIDGE_IDENTITY_MISMATCH",
      detail: "All three identity fields must match the detected live bridge exactly (after trimming).",
      mismatches,
      expected: detected,
    });
    return;
  }

  // Pre-arm gate re-validation: every condition the UI checklist enforces
  // must also be true at the server before we flip the flag. This list MUST
  // stay in sync with `useChecklist()` in live-shared-activation.tsx — both
  // sides answer the same question, and divergence is the kind of bug that
  // gets people in trouble in live trading.
  const fresh =
    detector.bridge.heartbeatAgeSec != null &&
    detector.bridge.heartbeatAgeSec <= LIVE_HEARTBEAT_MAX_AGE_SEC;
  const eaOk =
    detector.bridge.eaVersion != null &&
    detector.bridge.eaVersion >= MIN_LIVE_EA_VERSION;
  const liveAcct = detector.bridge.accountType === "live" || detector.bridge.accountType === "real";
  const eaIn = detector.bridge.eaInputs ?? {};
  // Re-load the approved users so we can re-check approval + caps server-side.
  // Mirrors the checklist's `approved_users` + `user_limits` IDs.
  const approvedRows = await db
    .select({
      approved: userMasterLiveAccessTable.approvedForMasterLive,
      maxLot: userMasterLiveAccessTable.maxLot,
    })
    .from(userMasterLiveAccessTable);
  const approvedCount = approvedRows.filter((r) => r.approved === true).length;
  const approvedWithCaps = approvedRows.filter(
    (r) => r.approved === true && r.maxLot != null,
  ).length;
  const pinnedId = settingsRow.platformMasterBridgeConnectionId;
  const preArm: Array<{ id: string; ok: boolean }> = [
    {
      id: "bridge_pinned",
      ok: pinnedId != null && pinnedId === detector.bridge.bridgeId,
    },
    { id: "ea_on_live_chart", ok: liveAcct },
    { id: "heartbeat", ok: fresh },
    { id: "ea_version", ok: eaOk },
    { id: "read_only_off", ok: eaIn.readOnlyMode === false },
    { id: "enable_live_execution", ok: eaIn.enableLiveExecution === true },
    { id: "terminal_connected", ok: eaIn.terminalConnected === true },
    { id: "algo_trading_allowed", ok: eaIn.algoTradingAllowed === true },
    { id: "routing_shared", ok: settingsRow.accountRoutingMode === "SHARED_MASTER_MT5" },
    { id: "master_bridge_mode_live", ok: settingsRow.masterBridgeLiveEnabled === true },
    { id: "shared_live_enabled", ok: settingsRow.sharedLiveTradingEnabled === true },
    { id: "platform_mode_live", ok: settingsRow.platformMode === "LIVE" },
    { id: "live_enabled", ok: settingsRow.liveEnabled === true },
    { id: "kill_released", ok: settingsRow.emergencyKillSwitch === false },
    { id: "approved_users", ok: approvedCount > 0 },
    { id: "user_limits", ok: approvedWithCaps > 0 && approvedWithCaps === approvedCount },
  ];
  const failed = preArm.filter((c) => !c.ok).map((c) => c.id);
  if (failed.length > 0) {
    res.status(409).json({
      ok: false, error: "PRE_ARM_CHECKS_FAILED",
      failedChecks: failed,
    });
    return;
  }

  const reason = typeof body.reason === "string" && body.reason.length > 0 ? body.reason : "ADMIN_ARMED_VIA_COCKPIT";
  const before = {
    liveBrokerExecutionArmed: settingsRow.liveBrokerExecutionArmed,
    liveBrokerExecutionArmedAt: settingsRow.liveBrokerExecutionArmedAt,
    liveBrokerExecutionArmedBy: settingsRow.liveBrokerExecutionArmedBy,
    liveBrokerExecutionArmedBridgeId: settingsRow.liveBrokerExecutionArmedBridgeId,
  };
  const armedAt = new Date();
  await db.transaction(async (tx) => {
    await tx.update(globalTradingSettingsTable).set({
      liveBrokerExecutionArmed: true,
      liveBrokerExecutionArmedAt: armedAt,
      liveBrokerExecutionArmedBy: admin.id,
      liveBrokerExecutionArmedBridgeId: detector.bridge.bridgeId,
      updatedAt: armedAt,
    }).where(eq(globalTradingSettingsTable.id, settingsRow.id));
    await writeAuditOn(tx, {
      adminId: admin.id,
      adminRole: admin.role,
      action: "ADMIN_ARMED_LIVE_BROKER_EXECUTION",
      before,
      after: {
        liveBrokerExecutionArmed: true,
        liveBrokerExecutionArmedAt: armedAt.toISOString(),
        liveBrokerExecutionArmedBy: admin.id,
        liveBrokerExecutionArmedBridgeId: detector.bridge.bridgeId,
        bridgeAccountNumber: detected.account,
        bridgeBroker: detected.broker,
        bridgeServer: detected.server,
        reason,
      },
    });
  });
  res.json({
    ok: true, armed: true,
    armedAt: armedAt.toISOString(),
    armedBy: admin.id,
    armedBridgeId: detector.bridge.bridgeId,
    reason,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/live-shared/disarm-live-execution
// Admin-only. Immediately flips `liveBrokerExecutionArmed=false`. No
// pre-arm gates required — disarm always succeeds (it's a fail-closed
// action). Writes a full audit row.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/admin/live-shared/disarm-live-execution", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const reason = typeof body.reason === "string" && body.reason.length > 0 ? body.reason : "ADMIN_DISARMED";
  const settingsRow = (await db.select().from(globalTradingSettingsTable).limit(1))[0] ?? null;
  if (!settingsRow) { res.status(500).json({ ok: false, error: "SETTINGS_ROW_MISSING" }); return; }
  const before = {
    liveBrokerExecutionArmed: settingsRow.liveBrokerExecutionArmed,
    liveBrokerExecutionArmedAt: settingsRow.liveBrokerExecutionArmedAt,
    liveBrokerExecutionArmedBy: settingsRow.liveBrokerExecutionArmedBy,
    liveBrokerExecutionArmedBridgeId: settingsRow.liveBrokerExecutionArmedBridgeId,
  };
  await db.transaction(async (tx) => {
    await tx.update(globalTradingSettingsTable).set({
      liveBrokerExecutionArmed: false,
      liveBrokerExecutionArmedAt: null,
      liveBrokerExecutionArmedBy: null,
      liveBrokerExecutionArmedBridgeId: null,
      updatedAt: new Date(),
    }).where(eq(globalTradingSettingsTable.id, settingsRow.id));
    await writeAuditOn(tx, {
      adminId: admin.id,
      adminRole: admin.role,
      action: "ADMIN_DISARMED_LIVE_BROKER_EXECUTION",
      before,
      after: { liveBrokerExecutionArmed: false, reason },
    });
  });
  res.json({ ok: true, disarmed: true, reason });
});

export default router;
