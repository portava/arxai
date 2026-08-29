// Phase A — Per-user live arming.
//
// Implements the 15-check gate from the Live Trading Enablement spec.
// Even when all 15 pass, the live command pipeline still blocks at
// `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` (see liveDispatchGate.ts).

import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  arxLiveArmingTable,
  liveTradingAuditTable,
  mt5ConnectionTable,
  userMasterLiveAccessTable,
} from "@workspace/db";
import { resolveLiveBrokerExecutionEnabledAsync } from "./phaseBConfig.js";

export const LIVE_CONFIRMATION_PHRASE = "ENABLE LIVE TRADING";

/**
 * Schema version for the readiness payload. Bump when the gate shape
 * changes so the deployed-runtime marker on /admin/live-shared can
 * confirm the new gate is actually live.
 */
export const LIVE_ARMING_SCHEMA_VERSION = "v2-split-account-broker-server";
export const ARX_LIVE_HARD_WEEKLY_DRAWDOWN_PCT = 10;

// Wave-4 pre-gate caps (arxLiveUserSettings) — user-settable, tighten-only,
// clamped to these server-side ceilings. A user may set a STRICTER value
// than the ceiling; they can never loosen past it. Consistent with the
// weekly-drawdown pattern above (Math.min against the hard cap).
export const ARX_LIVE_HARD_MAX_ENTRY_DEVIATION_BPS = 50;   // 0.5% max collar
export const ARX_LIVE_HARD_MAX_SIGNAL_AGE_MS = 5 * 60_000; // 5 minutes
export const ARX_LIVE_HARD_MAX_CLUSTER_RISK_USD = 5_000;
export const ARX_LIVE_HARD_MAX_CLUSTER_POSITIONS = 10;

/**
 * Per-market sane defaults. Users can choose LOWER; server refuses to
 * accept HIGHER without admin override (Phase A: admin override deferred).
 * These are intentionally conservative — Phase A is "all UI works, but
 * blocks at chokepoint".
 */
export const ARX_LIVE_DEFAULT_MAX_LOT_PER_MARKET: Record<string, number> = {
  EURUSD: 0.10, GBPUSD: 0.10, USDJPY: 0.10, AUDUSD: 0.10, USDCAD: 0.10,
  NZDUSD: 0.10, USDCHF: 0.10, EURGBP: 0.05, EURJPY: 0.05, GBPJPY: 0.05,
  XAUUSD: 0.02, XAGUSD: 0.05,
  US30: 0.10, NAS100: 0.10, SPX500: 0.10,
  BTCUSD: 0.01, ETHUSD: 0.01,
  WTI: 0.10, UKOIL: 0.10,
};

export const ARX_LIVE_DEFAULT_ALLOWED_SYMBOLS: string[] =
  Object.keys(ARX_LIVE_DEFAULT_MAX_LOT_PER_MARKET);

export interface LiveArmingCheck {
  id: number;
  key: string;
  label: string;
  passed: boolean;
  reason: string | null;
  /** True if user-supplied (typed phrase, etc.); false if system-derived. */
  userInput: boolean;
  /**
   * True if this check is part of the **pre-arm** checklist (operator
   * setup). False if it's a runtime server-side dispatch gate (e.g.
   * `SERVER_LIVE_FLAG`) which is shown separately and does NOT count
   * toward the "READY TO ARM" state — only toward the final arm action.
   */
  preArm: boolean;
}

export interface LiveArmingCheckResult {
  checks: LiveArmingCheck[];
  /** Legacy: every check (incl. runtime dispatch flag) passes. */
  allPassed: boolean;
  /** All pre-arm operator checks pass. The READY-TO-ARM banner uses this. */
  preArmPassed: boolean;
  /** Alias for allPassed; the "ARM" button uses this. */
  armReady: boolean;
  /** Current state of the effective live broker execution flag. */
  serverDispatchEnabled: boolean;
  /** Whether the kill switch is engaged (overrides everything). */
  killSwitchEngaged: boolean;
  preArmPassedCount: number;
  preArmFailedCount: number;
  passedCount: number;
  failedCount: number;
  evaluatedAt: string;
  /** Bridge-detected facts the operator must confirm verbatim. */
  detected: {
    accountNumber: string | null;
    brokerName: string | null;
    serverName: string | null;
  };
  /**
   * Admin-only debug: exposes the *length* and trim/match status of the
   * received confirmation phrase so we can tell stale/placeholder/typo
   * issues apart. The phrase value itself is NEVER returned.
   */
  phraseDebug: {
    receivedLength: number;
    isEmpty: boolean;
    expectedLength: number;
    matchedAfterTrim: boolean;
  };
  evidence: {
    bridgeConnectionId: number | null;
    accountNumber: string | null;
    brokerServer: string | null;
    serverName: string | null;
    brokerName: string | null;
    accountType: string | null;
    eaVersion: string | null;
    heartbeatAgeSeconds: number | null;
    terminalConnected: boolean | null;
    algoTradingAllowed: boolean | null;
    readOnlyMode: boolean | null;
    eaLiveExecutionAllowed: boolean | null;
    serverLiveExecutionFlag: boolean;
  };
}

export interface LiveArmingInput {
  userId: number;
  isAdmin: boolean;
  confirmationPhrase: string;
  riskAcknowledged: boolean;
  accountNumberConfirmed: string;
  /** New split fields. Preferred over `brokerServerConfirmed`. */
  brokerConfirmed?: string;
  serverConfirmed?: string;
  /** Legacy combined field. Still accepted for backward compatibility. */
  brokerServerConfirmed?: string;
  maxLotConfirmed: number;
  dailyLossLimitConfirmed: number;
  killSwitchAcknowledged: boolean;
}

/**
 * Run the 15 acceptance checks. Returns one row per check with a precise
 * reason so the UI can render the exact failure.
 *
 * Check #9 (server live execution flag) ALWAYS fails in Phase A — the
 * server flag is pinned false until Phase B. This is intentional.
 */
export async function evaluateLiveArmingGate(
  input: LiveArmingInput,
): Promise<LiveArmingCheckResult> {
  const checks: LiveArmingCheck[] = [];
  const push = (
    id: number, key: string, label: string,
    passed: boolean, reason: string | null, userInput = false,
    preArm = true,
  ) => { checks.push({ id, key, label, passed, reason, userInput, preArm }); };

  // 1. Authenticated operator/admin user only.
  push(1, "AUTH_OPERATOR", "Authenticated operator / admin user",
    input.isAdmin === true,
    input.isAdmin ? null : "Only an admin/operator account may arm live trading.");

  // 2-8: derive from the user's active MT5 bridge.
  const bridges = await db
    .select()
    .from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.userId, input.userId));
  const nonRevoked = bridges.filter((b) => !b.tokenRevokedAt);
  const bridge = nonRevoked
    .slice()
    .sort((a, b) => {
      const ah = a.lastHeartbeat ? new Date(a.lastHeartbeat).getTime() : 0;
      const bh = b.lastHeartbeat ? new Date(b.lastHeartbeat).getTime() : 0;
      return bh - ah;
    })[0] ?? null;

  const hbAge = bridge?.lastHeartbeat
    ? Math.max(0, Math.floor((Date.now() - new Date(bridge.lastHeartbeat).getTime()) / 1000))
    : null;
  const caps = (bridge?.capabilities ?? {}) as {
    eaInputs?: {
      readOnlyMode?: unknown;
      enableDemoExecution?: unknown;
      enableLiveExecution?: unknown;
      terminalConnected?: unknown;
      algoTradingAllowed?: unknown;
    };
  };
  const ea = caps.eaInputs ?? {};

  // 2. MT5 account is confirmed LIVE (not demo) AND the bridge is a real
  // MT5 heartbeat (mode != MOCK). A MOCK bridge can never satisfy live
  // readiness even if its `accountType` column reads 'live' — the column
  // is informational; the `mode` column is the real-vs-placeholder
  // distinction set by the heartbeat ingest path.
  const isLiveAccount = bridge?.accountType === "live" || bridge?.accountType === "real";
  const isRealBridge = bridge != null && bridge.mode !== "MOCK";
  push(2, "ACCOUNT_TYPE_LIVE", "MT5 account is confirmed LIVE (real EA heartbeat, not MOCK)",
    isLiveAccount && isRealBridge,
    bridge == null ? "No bridge connection found." :
      !isRealBridge ? `Bridge is a MOCK placeholder (mode=${bridge.mode}). Attach EA v1.27 from a real MT5 terminal so a real heartbeat replaces the MOCK row.` :
      isLiveAccount ? null :
      `Bridge reports accountType=${bridge.accountType ?? "?"}. Must be 'live' or 'real'.`);

  // 3. Fresh EA heartbeat exists.
  const hbFresh = hbAge !== null && hbAge <= 15;
  push(3, "HEARTBEAT_FRESH", "Fresh EA heartbeat (≤15s)",
    hbFresh,
    hbAge === null ? "No heartbeat received yet." :
      hbFresh ? null : `Last heartbeat ${hbAge}s ago (max 15s).`);

  // 4. EA version is v1.27 or newer.
  // Phase A: pin to 1.27+ since that is the planned live-ready version.
  // v1.26 is demo-ready only.
  const ver = bridge?.eaVersion ?? "";
  const verNum = /^\d+\.\d+/.test(ver) ? Number(ver.split(".").slice(0, 2).join(".")) : 0;
  const verOk = verNum >= 1.27;
  push(4, "EA_VERSION_OK", "EA version is v1.27 or newer (live-ready EA)",
    verOk,
    !ver ? "EA has not reported its version." :
      verOk ? null : `EA reports v${ver}. Phase A requires v1.27+ for live readiness; v1.26 is demo-only.`);

  // 5. Terminal connected = true.
  const terminalConnected = ea.terminalConnected === true;
  push(5, "TERMINAL_CONNECTED", "MT5 terminal connected",
    terminalConnected,
    terminalConnected ? null : "EA did not report terminalConnected=true. Open MT5 terminal and check internet.");

  // 6. Algo trading allowed = true.
  const algoOk = ea.algoTradingAllowed === true;
  push(6, "ALGO_TRADING_ALLOWED", "Algo trading allowed in MT5",
    algoOk,
    algoOk ? null : "EA did not report algoTradingAllowed=true. Enable AutoTrading in the MT5 toolbar.");

  // 7. EA reports ReadOnlyMode=false.
  const roOk = ea.readOnlyMode === false;
  push(7, "EA_READ_ONLY_FALSE", "EA reports ReadOnlyMode=false",
    roOk,
    ea.readOnlyMode === undefined ? "EA has not reported ReadOnlyMode yet." :
      roOk ? null : "EA input ReadOnlyMode is true. Flip it to false in MT5 → EA Inputs.");

  // 8. EA reports live execution allowed.
  const liveAllowed = ea.enableLiveExecution === true;
  push(8, "EA_LIVE_EXECUTION_ALLOWED", "EA reports EnableLiveExecution=true",
    liveAllowed,
    ea.enableLiveExecution === undefined
      ? "EA has not reported EnableLiveExecution. This input ships in EA v1.27."
      : liveAllowed ? null : "EA input EnableLiveExecution is false.");

  // 9. Server dispatch status. This is NOT a pre-arm check — it is the
  // runtime live broker execution flag (env OR admin-armed DB flag). It
  // is reported here for visibility and gates the *arm* action, but it
  // does NOT count toward the READY-TO-ARM state. The OFF/default-deny
  // state is the safe ready-to-arm baseline, not a failing check.
  const serverDispatchEnabled = await resolveLiveBrokerExecutionEnabledAsync();
  push(9, "SERVER_LIVE_FLAG", "Server dispatch status",
    serverDispatchEnabled,
    serverDispatchEnabled
      ? null
      : "OFF — ready to arm after pre-arm checks pass. (Admin must flip the runtime arm flag from /admin/live-shared/activation before live orders dispatch.)",
    false, /* userInput */
    false  /* preArm — runtime gate, not part of pre-arm */);

  // 10. User accepts live trading risk confirmation.
  push(10, "RISK_ACKNOWLEDGED", "Live trading risk acknowledged",
    input.riskAcknowledged === true,
    input.riskAcknowledged ? null : "You must check the risk acknowledgement.", true);

  // 11. Confirmation phrase. Trim leading/trailing whitespace before
  // comparison; internal spaces must still match exactly.
  const rawPhrase = String(input.confirmationPhrase ?? "");
  const trimmedPhrase = rawPhrase.trim();
  const phraseOk = trimmedPhrase === LIVE_CONFIRMATION_PHRASE;
  push(11, "CONFIRMATION_PHRASE", `Type exactly: ${LIVE_CONFIRMATION_PHRASE}`,
    phraseOk,
    phraseOk
      ? null
      : trimmedPhrase.length === 0
        ? `Confirmation phrase is empty. Type exactly: ${LIVE_CONFIRMATION_PHRASE}`
        : `Confirmation phrase must be exactly: ${LIVE_CONFIRMATION_PHRASE} (received ${trimmedPhrase.length} chars after trim).`,
    true);

  // 12. Account / broker / server confirmed verbatim. Resolve the
  // legacy combined field if the new split fields are missing.
  const brokerConfirmedRaw = input.brokerConfirmed ?? input.brokerServerConfirmed ?? "";
  const serverConfirmedRaw = input.serverConfirmed ?? input.brokerServerConfirmed ?? "";
  const acctIn = String(input.accountNumberConfirmed ?? "").trim();
  const brokerIn = String(brokerConfirmedRaw).trim();
  const serverIn = String(serverConfirmedRaw).trim();
  const expectedAcct = bridge?.accountNumber != null ? String(bridge.accountNumber).trim() : null;
  const expectedBroker = bridge?.brokerName != null ? String(bridge.brokerName).trim() : null;
  const expectedServer = bridge?.serverName != null ? String(bridge.serverName).trim() : null;
  const acctMatch = expectedAcct != null && acctIn !== "" && acctIn === expectedAcct;
  const brokerMatch = expectedBroker != null && brokerIn !== "" && brokerIn === expectedBroker;
  const serverMatch = expectedServer != null && serverIn !== "" && serverIn === expectedServer;
  const mismatches: string[] = [];
  if (!acctMatch) mismatches.push(`Account mismatch: expected ${expectedAcct ?? "?"}`);
  if (!brokerMatch) mismatches.push(`Broker mismatch: expected ${expectedBroker ?? "?"}`);
  if (!serverMatch) mismatches.push(`Server mismatch: expected ${expectedServer ?? "?"}`);
  push(12, "ACCOUNT_BROKER_CONFIRMED",
    "Account, broker, and server confirmed (exact match)",
    acctMatch && brokerMatch && serverMatch,
    mismatches.length === 0 ? null : mismatches.join("; "), true);

  // 13. Max lot limit confirmed (and within sane default ceiling).
  const lotOk = input.maxLotConfirmed > 0 && input.maxLotConfirmed <= 1.0;
  push(13, "MAX_LOT_CONFIRMED", "Max lot limit confirmed (≤1.0 in Phase A)",
    lotOk,
    input.maxLotConfirmed <= 0 ? "Max lot must be > 0." :
      lotOk ? null : "Phase A caps max lot at 1.0 per order across all markets.", true);

  // 14. Daily loss limit confirmed (must be > 0, server hard-caps elsewhere).
  push(14, "DAILY_LOSS_CONFIRMED", "Daily loss limit confirmed",
    input.dailyLossLimitConfirmed > 0,
    input.dailyLossLimitConfirmed > 0 ? null : "Daily loss limit must be > 0.", true);

  // 15. Kill switch availability acknowledged.
  push(15, "KILL_SWITCH_ACKNOWLEDGED", "Kill switch acknowledged available",
    input.killSwitchAcknowledged === true,
    input.killSwitchAcknowledged ? null : "You must acknowledge the kill switch is available.", true);

  const failedCount = checks.filter((c) => !c.passed).length;
  const passedCount = checks.length - failedCount;
  const preArmChecks = checks.filter((c) => c.preArm);
  const preArmFailedCount = preArmChecks.filter((c) => !c.passed).length;
  const preArmPassedCount = preArmChecks.length - preArmFailedCount;
  // Kill switch overrides everything. We surface it here too so the UI's
  // 4-state banner can flip to KILL_SWITCH_ACTIVE regardless of pre-arm.
  const existingArming = await db
    .select({ k: arxLiveArmingTable.killSwitchEngaged })
    .from(arxLiveArmingTable)
    .where(eq(arxLiveArmingTable.userId, input.userId))
    .limit(1);
  const killSwitchEngaged = existingArming[0]?.k === true;

  return {
    checks,
    allPassed: failedCount === 0,
    preArmPassed: preArmFailedCount === 0,
    armReady: failedCount === 0 && !killSwitchEngaged,
    serverDispatchEnabled,
    killSwitchEngaged,
    preArmPassedCount,
    preArmFailedCount,
    passedCount,
    failedCount,
    evaluatedAt: new Date().toISOString(),
    detected: {
      accountNumber: bridge?.accountNumber ?? null,
      brokerName: bridge?.brokerName ?? null,
      serverName: bridge?.serverName ?? null,
    },
    phraseDebug: {
      receivedLength: rawPhrase.length,
      isEmpty: rawPhrase.length === 0,
      expectedLength: LIVE_CONFIRMATION_PHRASE.length,
      matchedAfterTrim: phraseOk,
    },
    evidence: {
      bridgeConnectionId: bridge?.id ?? null,
      accountNumber: bridge?.accountNumber ?? null,
      brokerServer: bridge?.brokerName ?? null,
      serverName: bridge?.serverName ?? null,
      brokerName: bridge?.brokerName ?? null,
      accountType: bridge?.accountType ?? null,
      eaVersion: bridge?.eaVersion ?? null,
      heartbeatAgeSeconds: hbAge,
      terminalConnected: ea.terminalConnected === undefined ? null : Boolean(ea.terminalConnected),
      algoTradingAllowed: ea.algoTradingAllowed === undefined ? null : Boolean(ea.algoTradingAllowed),
      readOnlyMode: ea.readOnlyMode === undefined ? null : Boolean(ea.readOnlyMode),
      eaLiveExecutionAllowed: ea.enableLiveExecution === undefined ? null : Boolean(ea.enableLiveExecution),
      serverLiveExecutionFlag: serverDispatchEnabled,
    },
  };
}

async function audit(args: {
  eventType: string; severity?: string; message: string;
  userId: number; actorRole?: string; metadata?: Record<string, unknown>;
}) {
  await db.insert(liveTradingAuditTable).values({
    eventId: randomUUID(),
    eventType: args.eventType,
    severity: args.severity ?? "INFO",
    mode: "READ_ONLY",
    message: args.message,
    actorRole: args.actorRole ?? "user",
    metadata: { userId: args.userId, ...(args.metadata ?? {}) },
  });
}

export async function getMyArming(userId: number) {
  const rows = await db
    .select().from(arxLiveArmingTable)
    .where(eq(arxLiveArmingTable.userId, userId)).limit(1);
  return rows[0] ?? null;
}

export async function armLiveForUser(input: LiveArmingInput & { ip?: string }) {
  const gate = await evaluateLiveArmingGate(input);
  if (!gate.allPassed) {
    await audit({
      eventType: "ARM_FAILURE",
      severity: "WARNING",
      userId: input.userId,
      message: `Live arming refused: ${gate.failedCount} check(s) failed.`,
      metadata: { failed: gate.checks.filter((c) => !c.passed).map((c) => c.key) },
    });
    return { ok: false as const, gate, reason: "GATE_FAILED" as const };
  }
  const existing = await getMyArming(input.userId);
  const hash = createHash("sha256").update(input.confirmationPhrase).digest("hex");
  const values = {
    userId: input.userId,
    isArmed: true,
    armedAt: new Date(),
    armedByUserId: input.userId,
    armedFromIp: input.ip ?? null,
    confirmationPhraseHash: hash,
    accountNumberConfirmed: input.accountNumberConfirmed,
    brokerServerConfirmed:
      input.brokerConfirmed != null && input.serverConfirmed != null
        ? `${input.brokerConfirmed} | ${input.serverConfirmed}`
        : (input.brokerServerConfirmed ?? ""),
    maxLotConfirmed: input.maxLotConfirmed,
    dailyLossLimitConfirmed: input.dailyLossLimitConfirmed,
    killSwitchAcknowledged: input.killSwitchAcknowledged,
    killSwitchEngaged: false,
    lastReadinessCheckAt: new Date(),
    lastReadinessSnapshot: gate as unknown as Record<string, unknown>,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(arxLiveArmingTable).set(values).where(eq(arxLiveArmingTable.userId, input.userId));
  } else {
    await db.insert(arxLiveArmingTable).values(values);
  }
  await audit({
    eventType: "ARM_SUCCESS", severity: "HIGH",
    userId: input.userId,
    message: "Live arming gate passed all 15 checks (Phase A — dispatch still blocked).",
    metadata: {
      accountNumber: input.accountNumberConfirmed,
      broker: input.brokerConfirmed ?? null,
      server: input.serverConfirmed ?? null,
      brokerServerLegacy: input.brokerServerConfirmed ?? null,
      maxLot: input.maxLotConfirmed,
    },
  });
  // Task #737 — the per-user arming confirmation phrase ("ENABLE LIVE TRADING")
  // IS the trader's personal live-confirmation. Completing it honestly
  // satisfies the new LIVE_EXECUTION_ACTIVATION_GATE precondition (source
  // `user_confirmation`). This never bypasses any of the 18 dispatch gates —
  // approval, allocation, heartbeat, kill-switch, etc. all still run. We only
  // UPDATE an existing access row (arming alone never creates approval state):
  // if no row exists the resolver still reports not-approved and the gate
  // blocks. Per spec, an admin LIVE_EXECUTION_DISABLED can be re-satisfied by
  // the trader completing this confirmation, so we always set it on arm.
  const now = new Date();
  await db
    .update(userMasterLiveAccessTable)
    .set({
      liveExecutionEnabled: true,
      liveConfirmationRequired: false,
      liveConfirmationCompletedAt: now,
      liveExecutionActivationSource: "user_confirmation",
      liveExecutionActivatedBy: input.userId,
      liveExecutionActivatedAt: now,
      updatedAt: now,
    })
    .where(eq(userMasterLiveAccessTable.userId, input.userId));
  return { ok: true as const, gate };
}

/**
 * Task #737 — honest, audited admin force-arm used by Full Live Activation.
 *
 * An admin completing Full Live Activation (typed phrase + real-money ack)
 * stands in for the trader's personal arming confirmation. This writes the
 * trader's OWN `arx_live_arming` row honestly:
 *   - a FRESH confirmation-phrase hash (the canonical phrase) — never copied
 *     from another user's row;
 *   - `armedByUserId = adminId` so the audit trail shows the operator bypass;
 *   - caps pulled from the trader's own access row (not faked);
 *   - a readiness snapshot that records this as an admin bypass, NOT a passed
 *     15-check gate.
 *
 * SAFETY: this is a precondition convenience only. It does NOT contact the EA,
 * insert into `arx_live_commands`, or weaken any dispatch gate. Every live
 * dispatch still re-checks heartbeat, EA version, account type, kill switch,
 * allocation, symbol, and the rest of the 23 Phase B gates in real time, so a
 * force-armed trader still cannot fire unless the live broker is genuinely
 * ready at dispatch.
 */
export async function adminForceArmLiveForUser(args: {
  userId: number;
  adminId: number;
  maxLotConfirmed: number;
  dailyLossLimitConfirmed: number;
  accountNumberConfirmed?: string | null;
  brokerServerConfirmed?: string | null;
  ip?: string | null;
}) {
  const now = new Date();
  const hash = createHash("sha256").update(LIVE_CONFIRMATION_PHRASE).digest("hex");
  const snapshot = {
    adminBypass: true,
    bypassedByAdminId: args.adminId,
    note: "Armed via admin Full Live Activation (typed phrase + ack). Dispatch still re-checks all 23 Phase B gates.",
    armedAt: now.toISOString(),
  } as unknown as Record<string, unknown>;
  const values = {
    userId: args.userId,
    isArmed: true,
    armedAt: now,
    armedByUserId: args.adminId,
    armedFromIp: args.ip ?? null,
    confirmationPhraseHash: hash,
    accountNumberConfirmed: args.accountNumberConfirmed ?? "ADMIN_FULL_ACTIVATION",
    brokerServerConfirmed: args.brokerServerConfirmed ?? "ADMIN_FULL_ACTIVATION",
    maxLotConfirmed: args.maxLotConfirmed,
    dailyLossLimitConfirmed: args.dailyLossLimitConfirmed,
    killSwitchAcknowledged: true,
    killSwitchEngaged: false,
    lastReadinessCheckAt: now,
    lastReadinessSnapshot: snapshot,
    updatedAt: now,
  };
  const existing = await getMyArming(args.userId);
  if (existing) {
    await db.update(arxLiveArmingTable).set(values).where(eq(arxLiveArmingTable.userId, args.userId));
  } else {
    await db.insert(arxLiveArmingTable).values(values);
  }
  await audit({
    eventType: "ARM_SUCCESS", severity: "HIGH",
    userId: args.userId,
    message: `Live armed by admin ${args.adminId} via Full Live Activation (operator bypass of personal confirmation).`,
    metadata: { adminBypass: true, adminId: args.adminId, maxLot: args.maxLotConfirmed },
  });
  return { ok: true as const };
}

export async function disarmLiveForUser(args: { userId: number; reason: string }) {
  const existing = await getMyArming(args.userId);
  if (!existing) return { ok: true as const, alreadyDisarmed: true };
  await db.update(arxLiveArmingTable).set({
    isArmed: false,
    disarmedAt: new Date(),
    disarmedReason: args.reason,
    updatedAt: new Date(),
  }).where(and(eq(arxLiveArmingTable.userId, args.userId)));
  await audit({
    eventType: "DISARM", severity: "INFO",
    userId: args.userId,
    message: `Live disarmed: ${args.reason}`,
  });
  return { ok: true as const };
}

export async function engageKillSwitchForUser(args: { userId: number; reason: string }) {
  const existing = await getMyArming(args.userId);
  const now = new Date();
  if (!existing) {
    await db.insert(arxLiveArmingTable).values({
      userId: args.userId,
      isArmed: false,
      killSwitchEngaged: true,
      killSwitchEngagedAt: now,
      killSwitchEngagedByUserId: args.userId,
      killSwitchReason: args.reason,
    });
  } else {
    await db.update(arxLiveArmingTable).set({
      isArmed: false,
      killSwitchEngaged: true,
      killSwitchEngagedAt: now,
      killSwitchEngagedByUserId: args.userId,
      killSwitchReason: args.reason,
      disarmedAt: now,
      disarmedReason: `KILL_SWITCH: ${args.reason}`,
      updatedAt: now,
    }).where(eq(arxLiveArmingTable.userId, args.userId));
  }
  await audit({
    eventType: "KILL_ENGAGE", severity: "CRITICAL",
    userId: args.userId,
    message: `Kill switch engaged: ${args.reason}`,
  });
  return { ok: true as const };
}

export async function releaseKillSwitchForUser(args: { userId: number }) {
  await db.update(arxLiveArmingTable).set({
    killSwitchEngaged: false,
    killSwitchEngagedAt: null,
    killSwitchEngagedByUserId: null,
    killSwitchReason: null,
    updatedAt: new Date(),
  }).where(eq(arxLiveArmingTable.userId, args.userId));
  await audit({
    eventType: "KILL_RESET", severity: "HIGH",
    userId: args.userId,
    message: "Kill switch released. Re-arm required before live trading.",
  });
  return { ok: true as const };
}
