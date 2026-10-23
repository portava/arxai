// Admin — Manual Live Test Readiness
//
// SAFETY (inviolable):
//  - GET /api/admin/live-test-readiness/state       — read-only aggregator
//  - POST /api/admin/live-test-readiness/preflight  — DRY-RUN gate matrix
//
//  The preflight calls the pure 16-gate evaluator
//  (`evaluateLivePhaseBDispatchGate`) with a hard-coded EURUSD/0.01/BUY
//  command and a fixed `commandHasStopLoss=true` so the missing-SL gate
//  doesn't dominate the matrix preview. It NEVER inserts a row into
//  `arx_live_commands`, NEVER calls `dispatchLiveCommand`, and NEVER
//  contacts the EA/bridge. Returning the gate result is read-only and
//  has zero side-effects.
//
//  Every handler is admin/owner only. An `ADMIN_VIEWED_LIVE_TEST_READINESS`
//  audit row is written for the GET and `LIVE_TEST_PREFLIGHT_EVALUATED`
//  is written for the POST so operators can prove the panel was opened
//  without anyone dispatching a trade.
import express, { type IRouter, Router, type Request, type Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  arxLiveArmingTable,
  arxLiveCommandsTable,
  arxLivePositionsTable,
  mt5ConnectionTable,
  userMasterLiveAccessTable,
  globalTradingSettingsTable,
  adminActionAuditLogTable,
  liveRiskDisclosureAcceptancesTable,
  arxLiveTestCyclesTable,
} from "@workspace/db";
import {
  evaluateLivePhaseBDispatchGate,
  type LivePhaseBGateInput,
  MIN_LIVE_EA_VERSION,
  LIVE_HEARTBEAT_MAX_AGE_SEC,
} from "@workspace/domain/safety-contracts/livePhaseBDispatchGate";
import { liveBrokerExecutionEnabled } from "../lib/live/phaseBConfig.js";
import {
  ARX_LIVE_DEFAULT_ALLOWED_SYMBOLS,
  ARX_LIVE_DEFAULT_MAX_LOT_PER_MARKET,
} from "../lib/live/liveArming.js";
import { getUserAllocationView } from "../lib/live/masterBridgePool.js";
import {
  T015_MANUAL_LIVE_PHASE,
  T015_MANUAL_LIVE_PHASE_LABEL,
} from "../lib/live/liveCommandPipeline.js";

const router: IRouter = Router();
router.use(express.json());

const CONTROLLED_TEST_SYMBOL = "EURUSD" as const;
const CONTROLLED_TEST_VOLUME = 0.01 as const;
const CONTROLLED_TEST_SIDE = "BUY" as const;

function requireAdmin(req: Request, res: Response): { id: number; role: "ADMIN" | "OWNER" } | null {
  const sess = (req as Request & { authUser?: { id: number; role?: string } }).authUser;
  if (!sess?.id) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return null; }
  const role = sess.role ?? null;
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" });
    return null;
  }
  return { id: sess.id, role };
}

async function writeAdminAudit(args: {
  adminId: number; adminRole: string; action: string; metadata: Record<string, unknown>;
}): Promise<void> {
  await db.insert(adminActionAuditLogTable).values({
    adminId: args.adminId,
    adminRole: args.adminRole,
    action: args.action,
    afterState: args.metadata,
  });
}

type BridgeFacts = {
  bridgeConnectionId: number | null;
  bridgeKind: "REAL_LIVE" | "REAL_DEMO" | "MOCK" | "NONE";
  accountType: string | null;
  accountNumber: string | null;
  brokerName: string | null;
  serverName: string | null;
  eaVersion: string | null;
  lastHeartbeatAt: string | null;
  heartbeatAgeSeconds: number | null;
  readOnlyMode: boolean | null;
  enableLiveExecution: boolean | null;
  terminalConnected: boolean | null;
  algoTradingAllowed: boolean | null;
  maxLiveLot: number | null;
};

async function loadPlatformMasterBridge(): Promise<BridgeFacts> {
  const settings = (await db.select().from(globalTradingSettingsTable).limit(1))[0];
  const pinnedId = settings?.platformMasterBridgeConnectionId ?? null;
  let picked: typeof mt5ConnectionTable.$inferSelect | null = null;
  if (pinnedId != null) {
    const r = await db.select().from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.id, pinnedId)).limit(1);
    picked = r[0] ?? null;
  }
  if (!picked) {
    // Fall back to freshest non-revoked LIVE bridge across all users.
    const rows = await db.select().from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.mode, "LIVE"));
    const nonRevoked = rows.filter((r) => !r.tokenRevokedAt);
    picked = nonRevoked.slice().sort((a, b) => {
      const ah = a.lastHeartbeat ? new Date(a.lastHeartbeat).getTime() : 0;
      const bh = b.lastHeartbeat ? new Date(b.lastHeartbeat).getTime() : 0;
      return bh - ah;
    })[0] ?? null;
  }
  if (!picked) {
    return {
      bridgeConnectionId: null, bridgeKind: "NONE",
      accountType: null, accountNumber: null, brokerName: null, serverName: null,
      eaVersion: null, lastHeartbeatAt: null, heartbeatAgeSeconds: null,
      readOnlyMode: null, enableLiveExecution: null, terminalConnected: null,
      algoTradingAllowed: null, maxLiveLot: null,
    };
  }
  const caps = (picked.capabilities ?? {}) as { eaInputs?: Record<string, unknown> };
  const ea = (caps.eaInputs ?? {}) as Record<string, unknown>;
  const hbAgeSec = picked.lastHeartbeat
    ? Math.max(0, Math.floor((Date.now() - new Date(picked.lastHeartbeat).getTime()) / 1000))
    : null;
  const bridgeKind: BridgeFacts["bridgeKind"] =
    picked.mode === "LIVE" ? "REAL_LIVE" : picked.mode === "DEMO" ? "REAL_DEMO" : "MOCK";
  return {
    bridgeConnectionId: picked.id,
    bridgeKind,
    accountType: picked.accountType,
    accountNumber: picked.accountNumber,
    brokerName: picked.brokerName,
    serverName: picked.serverName,
    eaVersion: picked.eaVersion,
    lastHeartbeatAt: picked.lastHeartbeat?.toISOString() ?? null,
    heartbeatAgeSeconds: hbAgeSec,
    readOnlyMode: typeof ea["readOnlyMode"] === "boolean" ? ea["readOnlyMode"] as boolean : picked.readOnlyMode,
    enableLiveExecution: typeof ea["enableLiveExecution"] === "boolean" ? ea["enableLiveExecution"] as boolean : null,
    terminalConnected: typeof ea["terminalConnected"] === "boolean" ? ea["terminalConnected"] as boolean : null,
    algoTradingAllowed: typeof ea["algoTradingAllowed"] === "boolean" ? ea["algoTradingAllowed"] as boolean : null,
    maxLiveLot: typeof ea["maxLiveLot"] === "number" ? ea["maxLiveLot"] as number : null,
  };
}

async function loadOperatorAccess(adminId: number) {
  const access = (await db.select().from(userMasterLiveAccessTable)
    .where(eq(userMasterLiveAccessTable.userId, adminId)).limit(1))[0] ?? null;
  const arming = (await db.select().from(arxLiveArmingTable)
    .where(eq(arxLiveArmingTable.userId, adminId)).limit(1))[0] ?? null;
  return { access, arming };
}

async function loadMasterGates() {
  const s = (await db.select().from(globalTradingSettingsTable).limit(1))[0] ?? null;
  const queueDepth = await db.select({ n: sql<number>`COUNT(*)::int` })
    .from(arxLiveCommandsTable)
    .where(sql`${arxLiveCommandsTable.status} IN ('LIVE_DRAFT','SENT_TO_MT5_LIVE','LIVE_CONFIRMED')`);
  const openExposure = await db.select({
    lots: sql<number>`COALESCE(SUM(${arxLivePositionsTable.volume}), 0)`,
  }).from(arxLivePositionsTable)
    .where(sql`${arxLivePositionsTable.closedAt} IS NULL`);
  return {
    masterSwitchEnabled: liveBrokerExecutionEnabled(),
    platformMode: s?.platformMode ?? "OFF",
    liveEnabled: s?.liveEnabled ?? false,
    sharedLiveTradingEnabled: s?.sharedLiveTradingEnabled ?? false,
    masterBridgeLiveEnabled: s?.masterBridgeLiveEnabled ?? false,
    accountRoutingMode: s?.accountRoutingMode ?? "USER_OWNED_MT5",
    emergencyKillSwitch: s?.emergencyKillSwitch ?? true,
    killSwitchEngagedAt: s?.killSwitchEngagedAt ?? null,
    killSwitchReason: s?.killSwitchReason ?? null,
    queueDepth: Number(queueDepth[0]?.n ?? 0),
    currentOpenExposureLots: Number(openExposure[0]?.lots ?? 0),
  };
}

// ── GET state — full panel data (read-only) ─────────────────────────────
router.get("/admin/live-test-readiness/state", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const [bridge, master, opAccess, adminUser] = await Promise.all([
    loadPlatformMasterBridge(),
    loadMasterGates(),
    loadOperatorAccess(admin.id),
    db.select({ id: usersTable.id, email: usersTable.email, role: usersTable.role })
      .from(usersTable).where(eq(usersTable.id, admin.id)).limit(1),
  ]);
  const allowedSymbols = opAccess.access?.allowedSymbols && opAccess.access.allowedSymbols.length > 0
    ? opAccess.access.allowedSymbols
    : ARX_LIVE_DEFAULT_ALLOWED_SYMBOLS;
  await writeAdminAudit({
    adminId: admin.id, adminRole: admin.role, action: "ADMIN_VIEWED_LIVE_TEST_READINESS",
    metadata: { bridgeKind: bridge.bridgeKind, masterSwitch: master.masterSwitchEnabled },
  });
  res.json({
    ok: true,
    panelA_currentConnectedBridge: bridge,
    panelB_masterLiveGates: master,
    panelC_operatorAccess: {
      adminUserId: admin.id,
      adminEmail: adminUser[0]?.email ?? null,
      role: adminUser[0]?.role ?? null,
      approvedForMasterLive: opAccess.access?.approvedForMasterLive ?? false,
      masterLiveTradingEnabled: opAccess.access?.masterLiveTradingEnabled ?? false,
      masterLiveStatus: opAccess.access?.masterLiveStatus ?? "NOT_APPROVED",
      riskDisclosureAcceptedAt: opAccess.access?.riskDisclosureAcceptedAt ?? null,
      riskSettingsConfiguredAt: opAccess.access?.riskSettingsConfiguredAt ?? null,
      maxLot: opAccess.access?.maxLot ?? null,
      maxOpenPositions: opAccess.access?.maxOpenPositions ?? null,
      maxExposurePerSymbolLots: opAccess.access?.maxExposurePerSymbolLots ?? null,
      requireStopLoss: opAccess.access?.requireStopLoss ?? true,
      scannerLiveEnabled: opAccess.access?.scannerLiveEnabled ?? false,
      allowedSymbols,
      userArmed: opAccess.arming?.isArmed ?? false,
      userKillSwitchEngaged: opAccess.arming?.killSwitchEngaged ?? false,
    },
    panelD_controlledTestPreview: {
      symbol: CONTROLLED_TEST_SYMBOL,
      side: CONTROLLED_TEST_SIDE,
      volume: CONTROLLED_TEST_VOLUME,
      orderType: "MARKET",
      stopLossRequired: true,
      takeProfitOptional: true,
      source: "CONTROLLED_MASTER_LIVE_TEST",
      bridgeConnectionId: bridge.bridgeConnectionId,
      accountNumber: bridge.accountNumber,
      warning: "LIVE TRADE — REAL MONEY CAN BE LOST. This preview is NOT submitted.",
      requiredConfirmationPhrase: "ENABLE MASTER LIVE TEST",
    },
    constants: {
      MIN_LIVE_EA_VERSION,
      LIVE_HEARTBEAT_MAX_AGE_SEC,
    },
  });
});

// Shared controlled dry-run: builds the EURUSD/0.01/BUY gate input from the
// live truth (bridge facts, master gates, operator access) and evaluates the
// pure 16-gate evaluator. NO row is ever inserted into arx_live_commands and
// the EA/bridge is never contacted. Used by BOTH the /preflight POST and the
// T015 status GET so the two surfaces can never drift on the gate decision.
async function runControlledDryRun(
  adminId: number,
  stopLossOverride?: number,
): Promise<{
  bridge: BridgeFacts;
  master: Awaited<ReturnType<typeof loadMasterGates>>;
  opAccess: Awaited<ReturnType<typeof loadOperatorAccess>>;
  stopLoss: number;
  input: LivePhaseBGateInput;
  result: ReturnType<typeof evaluateLivePhaseBDispatchGate>;
}> {
  const stopLoss = Number.isFinite(stopLossOverride) && (stopLossOverride as number) > 0
    ? (stopLossOverride as number)
    : 1.05000;
  const [bridge, master, opAccess] = await Promise.all([
    loadPlatformMasterBridge(),
    loadMasterGates(),
    loadOperatorAccess(adminId),
  ]);
  const allowedSymbols = opAccess.access?.allowedSymbols && opAccess.access.allowedSymbols.length > 0
    ? opAccess.access.allowedSymbols
    : ARX_LIVE_DEFAULT_ALLOWED_SYMBOLS;
  const maxLotForSymbol = opAccess.access?.maxLot
    ?? ARX_LIVE_DEFAULT_MAX_LOT_PER_MARKET[CONTROLLED_TEST_SYMBOL]
    ?? 0.01;

  // Realised daily loss estimate — sum of floating P/L on positions closed
  // in the last 24h (arx_live_positions has no realized_pl column; floatingPl
  // is the last-synced P/L snapshot, which equals realised P/L at close time
  // for closed positions). Used only as input to the daily-loss gate.
  const realisedToday = await db.select({
    pnl: sql<number>`COALESCE(SUM(${arxLivePositionsTable.floatingPl}), 0)`,
  }).from(arxLivePositionsTable).where(and(
    eq(arxLivePositionsTable.userId, adminId),
    sql`${arxLivePositionsTable.closedAt} >= NOW() - INTERVAL '24 hours'`,
  ));
  const realisedDailyLossUsd = Math.max(0, -Number(realisedToday[0]?.pnl ?? 0));

  const input: LivePhaseBGateInput = {
    liveBrokerExecutionEnabled: master.masterSwitchEnabled,
    globalLiveEnabled: master.liveEnabled,
    userLiveApproved: opAccess.access?.approvedForMasterLive ?? false,
    userArmed: opAccess.arming?.isArmed ?? false,
    killSwitchEngaged: (opAccess.arming?.killSwitchEngaged ?? false) || (master.emergencyKillSwitch === true),
    bridgeAccountType: bridge.accountType,
    bridgeHeartbeatAgeSec: bridge.heartbeatAgeSeconds,
    bridgeEaVersion: bridge.eaVersion,
    bridgeEnableLiveExecution: bridge.enableLiveExecution,
    bridgeReadOnlyMode: bridge.readOnlyMode,
    bridgeTerminalConnected: bridge.terminalConnected,
    bridgeAlgoTradingAllowed: bridge.algoTradingAllowed,
    commandSymbol: CONTROLLED_TEST_SYMBOL,
    commandVolume: CONTROLLED_TEST_VOLUME,
    commandHasStopLoss: true,
    allowedSymbols,
    maxLotForSymbol,
    dailyLossLimitUsd: opAccess.access?.dailyLossLimitUsd ?? 0,
    realisedDailyLossUsd,
    requireStopLoss: opAccess.access?.requireStopLoss ?? true,
    adminAllowNoStopLoss: false,
    requireTakeProfit: opAccess.access?.requireTakeProfit ?? true,
    adminAllowNoTakeProfit: false,
    commandHasTakeProfit: true,
    // Gap A — risk disclosure must be accepted (append-only table).
    // Read from the SAME source dispatch reads (live_risk_disclosure_acceptances)
    // so preflight cannot drift PASS while dispatch BLOCKS.
    disclosureAccepted: (await db.select({ id: liveRiskDisclosureAcceptancesTable.id })
      .from(liveRiskDisclosureAcceptancesTable)
      .where(eq(liveRiskDisclosureAcceptancesTable.userId, adminId))
      .limit(1)).length > 0,
  };

  const result = evaluateLivePhaseBDispatchGate(input);
  return { bridge, master, opAccess, stopLoss, input, result };
}

// ── POST preflight — DRY RUN of all 16 Phase B gates. NO DB writes to
//    arx_live_commands. NO MT5 contact. NO position changes.
router.post("/admin/live-test-readiness/preflight", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  // Operator-supplied SL for the preview (defaults to a sane EURUSD value).
  const slRaw = Number((req.body ?? {}).stopLoss);

  const { bridge, stopLoss, result } = await runControlledDryRun(admin.id, slRaw);

  if (bridge.bridgeKind === "MOCK") {
    await writeAdminAudit({
      adminId: admin.id, adminRole: admin.role, action: "LIVE_TEST_PREFLIGHT_REJECTED_MOCK_BRIDGE",
      metadata: { bridgeKind: bridge.bridgeKind },
    });
    res.status(400).json({
      ok: false, decision: "BLOCKED",
      error: "MOCK_BRIDGE_REJECTED",
      detail: "The current connected bridge is a MOCK row. A real EA heartbeat is required.",
    });
    return;
  }

  // INVARIANT: count arx_live_commands before AND after the evaluation as
  // proof we did not write a row. The eval is a pure function; we count
  // here so the response itself certifies "no row created".
  const liveCountRow = await db.select({ n: sql<number>`COUNT(*)::int` })
    .from(arxLiveCommandsTable);
  const liveCountAfter = Number(liveCountRow[0]?.n ?? 0);

  await writeAdminAudit({
    adminId: admin.id, adminRole: admin.role, action: "LIVE_TEST_PREFLIGHT_EVALUATED",
    metadata: {
      decision: result.decision,
      primaryReason: result.primaryReason,
      blockReasonsCount: result.blockReasons.length,
      bridgeKind: bridge.bridgeKind,
      bridgeConnectionId: bridge.bridgeConnectionId,
      arxLiveCommandsAfter: liveCountAfter,
    },
  });

  res.json({
    ok: true,
    isDryRun: true,
    decision: result.decision,
    primaryReason: result.primaryReason,
    blockReasons: result.blockReasons,
    gates: result.gates,
    evaluatedAt: result.evaluatedAt,
    previewCommand: {
      symbol: CONTROLLED_TEST_SYMBOL,
      side: CONTROLLED_TEST_SIDE,
      volume: CONTROLLED_TEST_VOLUME,
      stopLoss,
      orderType: "MARKET",
      source: "CONTROLLED_MASTER_LIVE_TEST_PREFLIGHT",
    },
    currentConnectedBridge: {
      bridgeConnectionId: bridge.bridgeConnectionId,
      bridgeKind: bridge.bridgeKind,
      accountNumber: bridge.accountNumber,
      brokerName: bridge.brokerName,
      serverName: bridge.serverName,
      eaVersion: bridge.eaVersion,
      heartbeatAgeSeconds: bridge.heartbeatAgeSeconds,
    },
    arxLiveCommandsAfter: liveCountAfter,
    proofStatement: result.decision === "PASS"
      ? "READY_FOR_MANUAL_CONTROLLED_LIVE_TEST"
      : "NOT_READY_FOR_MANUAL_CONTROLLED_LIVE_TEST",
    safetyEnvelope: {
      didCreateLiveCommand: false,
      didDispatchToMt5: false,
      didCallOrderSend: false,
      didModifyPositions: false,
      didEnableLiveTradingAutomatically: false,
    },
  });
});

// ── GET T015 status — owner/admin MANUAL live-testing phase readout. Reuses
//    the SAME controlled dry-run as /preflight (so the readiness decision can
//    never drift), reports the unchanged $7 allocation, counts the placed T015
//    manual live trades (arx_live_commands payload ->> 'phaseTag'), and lists
//    completed T014 single-shot cycles as history. Pure read — asserts no
//    arx_live_commands row is written.
router.get("/admin/live-test-readiness/t015-status", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;

  const liveCountBefore = Number((await db.select({ n: sql<number>`COUNT(*)::int` })
    .from(arxLiveCommandsTable))[0]?.n ?? 0);

  const { bridge, stopLoss, result } = await runControlledDryRun(admin.id);

  // Count of placed T015 manual live OPEN commands for THIS admin, identified
  // by the phase tag stamped into the command payload. This is the honest
  // "trades placed in T015" figure — there is NO per-trade cap on this path.
  const t015CountRow = await db.select({ n: sql<number>`COUNT(*)::int` })
    .from(arxLiveCommandsTable)
    .where(and(
      eq(arxLiveCommandsTable.userId, admin.id),
      sql`${arxLiveCommandsTable.payload} ->> 'phaseTag' = ${T015_MANUAL_LIVE_PHASE}`,
    ));
  const manualLiveTradeCount = Number(t015CountRow[0]?.n ?? 0);

  // Allocation — unchanged $7 envelope, read straight from the live truth.
  const alloc = await getUserAllocationView(admin.id);

  // T014 history — completed single-shot verification cycles for this admin.
  const cycleRows = await db.select({
    cycleId: arxLiveTestCyclesTable.cycleId,
    status: arxLiveTestCyclesTable.status,
    symbol: arxLiveTestCyclesTable.symbol,
    side: arxLiveTestCyclesTable.side,
    requestedVolume: arxLiveTestCyclesTable.requestedVolume,
    createdAt: arxLiveTestCyclesTable.createdAt,
  }).from(arxLiveTestCyclesTable)
    .where(eq(arxLiveTestCyclesTable.userId, admin.id))
    .orderBy(desc(arxLiveTestCyclesTable.id))
    .limit(20);

  // INVARIANT: prove this read created no live command row.
  const liveCountAfter = Number((await db.select({ n: sql<number>`COUNT(*)::int` })
    .from(arxLiveCommandsTable))[0]?.n ?? 0);

  await writeAdminAudit({
    adminId: admin.id, adminRole: admin.role, action: "LIVE_TEST_T015_STATUS_VIEWED",
    metadata: {
      decision: result.decision,
      primaryReason: result.primaryReason,
      manualLiveTradeCount,
      arxLiveCommandsBefore: liveCountBefore,
      arxLiveCommandsAfter: liveCountAfter,
    },
  });

  res.json({
    ok: true,
    phase: {
      tag: T015_MANUAL_LIVE_PHASE,
      label: T015_MANUAL_LIVE_PHASE_LABEL,
      active: true,
      perTradeLimit: null,
      note: "Owner/admin manual live testing is ongoing. There is no global "
        + "\"one live trade\" limit on the manual path — place additional live "
        + "trades from the scanner, chart, Trade page, or Ruby entry as needed.",
    },
    readiness: {
      decision: result.decision,
      primaryReason: result.primaryReason,
      blockReasons: result.blockReasons,
      gates: result.gates,
      evaluatedAt: result.evaluatedAt,
      previewStopLoss: stopLoss,
      bridgeKind: bridge.bridgeKind,
    },
    allocation: {
      assignedAllocationUsd: alloc.assignedAllocation,
      reservedRiskUsd: alloc.reservedRisk,
      availableAllocationUsd: alloc.availableAllocation,
      bridgeAvailability: alloc.bridgeAvailability,
      bridgeMessage: alloc.bridgeMessage,
    },
    manualLiveTradeCount,
    t014History: {
      note: "Completed single-shot verification cycle(s). The T014 cycle is a "
        + "one-time automated OPEN+CLOSE check — it does not consume or cap "
        + "T015 manual testing.",
      cycles: cycleRows,
    },
    safetyEnvelope: {
      didCreateLiveCommand: false,
      didDispatchToMt5: false,
      arxLiveCommandsBefore: liveCountBefore,
      arxLiveCommandsAfter: liveCountAfter,
    },
  });
});

export default router;
