// Task #737 — Shared "approved-trader live state" resolver.
//
// ONE source of truth that answers, for a single user:
//   * Is this an eligible HUMAN trader (not investor / bot / agent / system)?
//   * Are they admin-approved for the shared live bridge AND attached to it?
//   * Has Full Live Activation been completed (live_execution_enabled === true
//     AND live_confirmation_required === false)?
//   * Are they honestly armed, kill-switch clear, risk-profile complete, and
//     is the platform live-execution switch on?
//   * Is the assigned master bridge connected with a fresh heartbeat?
//
// SAFETY (inviolable):
//   * Pure READ. No writes, no broker calls, no queue inserts.
//   * Strictly per-user (every query is userId-scoped). Never returns master
//     broker credentials, bridge tokens, raw account numbers, or IPs.
//   * This resolver NEVER grants execution. It only DESCRIBES state. The live
//     order path still routes instant-trade router → live pipeline → the 18
//     Phase B dispatch gates + the NEW LIVE_EXECUTION_ACTIVATION_GATE + kill
//     switch + allocation + risk + symbol + account-status checks. A user that
//     reads `executionReady: true` here is still fully re-gated at dispatch.
//   * `approvedTraderBridgeAssigned` is a DISPLAY pin only: it lets an approved,
//     bridge-attached human trader SHOW as LIVE_SHARED in the UI even before
//     they have armed/confirmed — execution stays blocked with an honest
//     `blockingReason`. Frontend display can never override backend readiness.
//   * Fail-closed: on any internal error the resolver returns a non-approved,
//     not-ready state (never a falsely-permissive one).
//
// NOTE on `isSystemUser`: the column is documented as a UI filter and is NOT an
// auth gate. Here it is used ONLY as the bot/agent/system *classifier* for this
// additive, default-deny live-activation eligibility. It never grants access and
// never weakens any existing auth/trading gate — it only further restricts who
// may be live-activated.

import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  userMasterLiveAccessTable,
  virtualTradingAccountsTable,
  globalTradingSettingsTable,
  mt5ConnectionTable,
} from "@workspace/db";
import { getMyArming } from "./liveArming.js";
import { resolveRouting } from "../adminTrading/routingResolver.js";
import { resolveLiveBrokerExecutionEnabledAsync } from "./phaseBConfig.js";
import { normalizeProductRole, type ProductRole } from "../auth/productRole.js";
import { logger } from "../logger.js";

const HEARTBEAT_FRESH_SECONDS = 15;

export interface ApprovedTraderLiveState {
  userId: number;

  // ---- Classification -------------------------------------------------
  productRole: ProductRole;
  isHumanTrader: boolean;
  isInvestor: boolean;
  isBotAgentSystem: boolean;

  // ---- Approval + bridge attachment -----------------------------------
  approvedForLive: boolean;
  masterLiveStatus: string;
  liveBridgeAssigned: boolean;
  assignedLiveBridgeId: number | null;

  // ---- Full Live Activation -------------------------------------------
  liveExecutionEnabled: boolean;
  liveConfirmationRequired: boolean;
  liveConfirmationBypassedByAdmin: number | null;
  liveExecutionActivationSource: string | null;
  /** true ONLY when liveExecutionEnabled === true AND liveConfirmationRequired === false */
  executionActivated: boolean;

  // ---- Arming / kill switch -------------------------------------------
  armed: boolean;
  killSwitchEngaged: boolean;

  // ---- Platform live posture ------------------------------------------
  serverLiveExecutionOn: boolean;
  operatorLiveArmed: boolean;
  emergencyKillSwitch: boolean;
  sharedLiveTradingEnabled: boolean;

  // ---- Risk profile ---------------------------------------------------
  riskProfileReady: boolean;
  approvedSymbols: string[];
  maxLot: number | null;
  dailyLossLimitUsd: number | null;

  // ---- Assigned master bridge heartbeat (only when requested) ---------
  bridgeConnectionId: number | null;
  bridgeConnected: boolean;
  bridgeHeartbeatFresh: boolean;
  bridgeHeartbeatAgeSeconds: number | null;

  // ---- Derived display + readiness ------------------------------------
  /**
   * Precedence input: an approved, bridge-attached HUMAN trader. When true the
   * account-mode precedence pins LIVE_SHARED for DISPLAY even if the user has
   * not yet armed/confirmed. Execution remains separately gated.
   */
  approvedTraderBridgeAssigned: boolean;
  /** Convenience: would the UI show a live badge (display pin OR already armed). */
  intendedLiveDisplay: boolean;
  /** Diagnostic readiness summary — NOT an execution grant (dispatch re-gates). */
  executionReady: boolean;
  blockingReasonCode: string | null;
  /** User-safe plain-English blocker (no operator/admin diagnostics). */
  blockingReason: string | null;
}

export interface BuildApprovedTraderLiveStateOptions {
  /**
   * When true (default) the resolver reads the assigned master bridge
   * heartbeat. Hot read paths (e.g. getUserModeScope) pass false to skip the
   * extra query — `approvedTraderBridgeAssigned` does not depend on heartbeat.
   */
  includeBridgeHeartbeat?: boolean;
}

const USER_SAFE_BLOCK_COPY: Record<string, string> = {
  INVESTOR_NOT_ALLOWED: "Investor accounts are view-only and cannot place or manage trades.",
  BOT_AGENT_NOT_ALLOWED:
    "Automated, agent, and system accounts are not eligible for live execution.",
  NOT_APPROVED_FOR_LIVE: "Admin approval is required before you can trade live.",
  LIVE_BRIDGE_ASSIGNMENT_PENDING:
    "Your live shared-bridge allocation is still being set up. Contact your operator to finish onboarding.",
  KILL_SWITCH_ENGAGED: "Live trading is halted by the kill switch. Reset it before arming again.",
  EMERGENCY_STOP_ACTIVE: "Live trading is paused platform-wide. Trades will resume once your operator re-enables it.",
  LIVE_CONFIRMATION_REQUIRED:
    "Complete live confirmation to start placing live orders. Your operator can enable Full Live Activation on your behalf.",
  LIVE_ARMING_PENDING:
    "Arm live trading to execute. Every dispatch still re-checks all Phase B safety gates.",
  SERVER_LIVE_EXECUTION_OFF:
    "Live execution is currently paused for maintenance. It will resume automatically once re-enabled.",
  RISK_PROFILE_INCOMPLETE: "Complete your risk settings (max lot, daily loss limit, symbols) to continue.",
};

function failClosedState(userId: number): ApprovedTraderLiveState {
  return {
    userId,
    productRole: "USER",
    isHumanTrader: false,
    isInvestor: false,
    isBotAgentSystem: false,
    approvedForLive: false,
    masterLiveStatus: "UNKNOWN",
    liveBridgeAssigned: false,
    assignedLiveBridgeId: null,
    liveExecutionEnabled: false,
    liveConfirmationRequired: true,
    liveConfirmationBypassedByAdmin: null,
    liveExecutionActivationSource: null,
    executionActivated: false,
    armed: false,
    killSwitchEngaged: false,
    serverLiveExecutionOn: false,
    operatorLiveArmed: false,
    emergencyKillSwitch: true,
    sharedLiveTradingEnabled: false,
    riskProfileReady: false,
    approvedSymbols: [],
    maxLot: null,
    dailyLossLimitUsd: null,
    bridgeConnectionId: null,
    bridgeConnected: false,
    bridgeHeartbeatFresh: false,
    bridgeHeartbeatAgeSeconds: null,
    approvedTraderBridgeAssigned: false,
    intendedLiveDisplay: false,
    executionReady: false,
    blockingReasonCode: "RESOLVER_UNAVAILABLE",
    blockingReason: "Live readiness is temporarily unavailable. Please try again shortly.",
  };
}

/**
 * Resolve the full approved-trader live state for `userId`. Never throws — on
 * any internal failure it returns a fail-closed (non-approved, not-ready)
 * state so a degraded resolver can never falsely show or permit live.
 */
export async function buildApprovedTraderLiveState(
  userId: number,
  opts: BuildApprovedTraderLiveStateOptions = {},
): Promise<ApprovedTraderLiveState> {
  const includeBridgeHeartbeat = opts.includeBridgeHeartbeat !== false;

  try {
    const [userRow, accessRow, vAccounts, arming, settingsRow, serverLiveOn] =
      await Promise.all([
        db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1).then((r) => r[0] ?? null),
        db
          .select()
          .from(userMasterLiveAccessTable)
          .where(eq(userMasterLiveAccessTable.userId, userId))
          .limit(1)
          .then((r) => r[0] ?? null),
        db
          .select({
            status: virtualTradingAccountsTable.status,
            sharedMasterAccountId: virtualTradingAccountsTable.sharedMasterAccountId,
          })
          .from(virtualTradingAccountsTable)
          .where(eq(virtualTradingAccountsTable.userId, userId)),
        getMyArming(userId),
        db.select().from(globalTradingSettingsTable).limit(1).then((r) => r[0] ?? null),
        resolveLiveBrokerExecutionEnabledAsync(),
      ]);

    // ---- Classification ------------------------------------------------
    const productRole = normalizeProductRole(userRow?.role);
    const isInvestor = productRole === "INVESTOR";
    const isBotAgentSystem = userRow?.isSystemUser === true;
    const isHumanTrader = !!userRow && !isInvestor && !isBotAgentSystem;

    // ---- Approval + bridge attachment ---------------------------------
    const masterLiveStatus = String(accessRow?.masterLiveStatus ?? "NOT_APPROVED");
    const approvedForLive =
      accessRow?.approvedForMasterLive === true && masterLiveStatus === "APPROVED";
    const liveBridgeAssigned = vAccounts.some(
      (a) =>
        a.sharedMasterAccountId != null &&
        String(a.status ?? "").toLowerCase() === "active",
    );
    const assignedLiveBridgeId =
      accessRow?.assignedLiveBridgeId ??
      vAccounts.find(
        (a) =>
          a.sharedMasterAccountId != null &&
          String(a.status ?? "").toLowerCase() === "active",
      )?.sharedMasterAccountId ??
      null;

    // ---- Full Live Activation -----------------------------------------
    const liveExecutionEnabled = accessRow?.liveExecutionEnabled === true;
    const liveConfirmationRequired = accessRow?.liveConfirmationRequired !== false; // default true
    const executionActivated = liveExecutionEnabled && !liveConfirmationRequired;

    // ---- Arming / kill -------------------------------------------------
    const armed = arming?.isArmed === true;
    const killSwitchEngaged = arming?.killSwitchEngaged === true;

    // ---- Platform posture ---------------------------------------------
    const operatorLiveArmed = settingsRow?.liveBrokerExecutionArmed === true;
    const emergencyKillSwitch = settingsRow?.emergencyKillSwitch !== false; // default true (fail-closed)
    const sharedLiveTradingEnabled = settingsRow?.sharedLiveTradingEnabled === true;

    // ---- Risk profile -------------------------------------------------
    const approvedSymbols = Array.isArray(accessRow?.allowedSymbols)
      ? (accessRow!.allowedSymbols as unknown[]).map((s) => String(s)).filter(Boolean)
      : [];
    const maxLot =
      typeof accessRow?.maxLot === "number" ? accessRow.maxLot : null;
    const dailyLossLimitUsd =
      typeof accessRow?.dailyLossLimitUsd === "number" ? accessRow.dailyLossLimitUsd : null;
    const riskProfileReady =
      (maxLot ?? 0) > 0 && (dailyLossLimitUsd ?? 0) > 0 && approvedSymbols.length > 0;

    // ---- Assigned master bridge heartbeat (optional) ------------------
    let bridgeConnectionId: number | null = null;
    let bridgeConnected = false;
    let bridgeHeartbeatFresh = false;
    let bridgeHeartbeatAgeSeconds: number | null = null;
    if (includeBridgeHeartbeat) {
      try {
        const routing = await resolveRouting({ userId, mode: "LIVE" });
        if (routing.ok && routing.connectionId) {
          bridgeConnectionId = routing.connectionId;
          const [conn] = await db
            .select({ lastHeartbeat: mt5ConnectionTable.lastHeartbeat })
            .from(mt5ConnectionTable)
            .where(eq(mt5ConnectionTable.id, routing.connectionId))
            .limit(1);
          bridgeHeartbeatAgeSeconds = conn?.lastHeartbeat
            ? Math.floor((Date.now() - new Date(conn.lastHeartbeat).getTime()) / 1000)
            : null;
          bridgeHeartbeatFresh =
            bridgeHeartbeatAgeSeconds !== null &&
            bridgeHeartbeatAgeSeconds <= HEARTBEAT_FRESH_SECONDS;
          bridgeConnected = bridgeHeartbeatFresh;
        }
      } catch (err) {
        logger.warn(
          { err, userId },
          "approvedTraderLiveState: bridge heartbeat read failed (non-fatal)",
        );
      }
    }

    // ---- Derived display pin ------------------------------------------
    const approvedTraderBridgeAssigned =
      isHumanTrader && approvedForLive && liveBridgeAssigned;
    const intendedLiveDisplay = approvedTraderBridgeAssigned || armed;

    // ---- Single execution-readiness blocker (precedence order) --------
    let blockingReasonCode: string | null = null;
    if (isInvestor) blockingReasonCode = "INVESTOR_NOT_ALLOWED";
    else if (isBotAgentSystem) blockingReasonCode = "BOT_AGENT_NOT_ALLOWED";
    else if (!approvedForLive) blockingReasonCode = "NOT_APPROVED_FOR_LIVE";
    else if (!liveBridgeAssigned) blockingReasonCode = "LIVE_BRIDGE_ASSIGNMENT_PENDING";
    else if (killSwitchEngaged) blockingReasonCode = "KILL_SWITCH_ENGAGED";
    else if (emergencyKillSwitch) blockingReasonCode = "EMERGENCY_STOP_ACTIVE";
    else if (!executionActivated) blockingReasonCode = "LIVE_CONFIRMATION_REQUIRED";
    else if (!armed) blockingReasonCode = "LIVE_ARMING_PENDING";
    else if (!serverLiveOn) blockingReasonCode = "SERVER_LIVE_EXECUTION_OFF";
    else if (!riskProfileReady) blockingReasonCode = "RISK_PROFILE_INCOMPLETE";

    const executionReady = blockingReasonCode === null;
    const blockingReason = blockingReasonCode
      ? USER_SAFE_BLOCK_COPY[blockingReasonCode] ?? "Live trading is unavailable for your account."
      : null;

    return {
      userId,
      productRole,
      isHumanTrader,
      isInvestor,
      isBotAgentSystem,
      approvedForLive,
      masterLiveStatus,
      liveBridgeAssigned,
      assignedLiveBridgeId,
      liveExecutionEnabled,
      liveConfirmationRequired,
      liveConfirmationBypassedByAdmin: accessRow?.liveConfirmationBypassedByAdmin ?? null,
      liveExecutionActivationSource: accessRow?.liveExecutionActivationSource ?? null,
      executionActivated,
      armed,
      killSwitchEngaged,
      serverLiveExecutionOn: serverLiveOn,
      operatorLiveArmed,
      emergencyKillSwitch,
      sharedLiveTradingEnabled,
      riskProfileReady,
      approvedSymbols,
      maxLot,
      dailyLossLimitUsd,
      bridgeConnectionId,
      bridgeConnected,
      bridgeHeartbeatFresh,
      bridgeHeartbeatAgeSeconds,
      approvedTraderBridgeAssigned,
      intendedLiveDisplay,
      executionReady,
      blockingReasonCode,
      blockingReason,
    };
  } catch (err) {
    logger.error({ err, userId }, "buildApprovedTraderLiveState failed — returning fail-closed state");
    return failClosedState(userId);
  }
}

/**
 * Reason codes the LIVE_EXECUTION_ACTIVATION_GATE can fail with. These are
 * additive PRE-conditions on the live order path — they never weaken, skip, or
 * OR any of the existing 18 Phase B dispatch gates. The order path still runs
 * the full instant-trade router → live pipeline → 18-gate dispatch on top of a
 * PASS here.
 */
export type LiveExecutionActivationGateReason =
  | "LIVE_EXECUTION_ACTIVATION_GATE"
  | "BOT_AGENT_NOT_ALLOWED"
  | "INVESTOR_NOT_ALLOWED";

export interface LiveExecutionActivationGateResult {
  passed: boolean;
  /** null when passed. */
  reason: LiveExecutionActivationGateReason | null;
  detail: string | null;
  state: ApprovedTraderLiveState;
}

/**
 * Evaluate the NEW live-execution activation gate for `userId`. This is a thin,
 * fail-closed wrapper over `buildApprovedTraderLiveState` so the gate, the
 * readiness endpoints, and the display surfaces all share ONE truth.
 *
 * PASSES ONLY when the resolver reports `executionActivated === true`, i.e.
 * `live_execution_enabled === true` AND `live_confirmation_required === false`.
 * Bots / agents / system and investor accounts are rejected outright. Any
 * resolver failure yields a fail-closed BLOCK (the resolver returns a non-
 * approved state, so `executionActivated` is false).
 */
export async function evaluateLiveExecutionActivationGate(
  userId: number,
): Promise<LiveExecutionActivationGateResult> {
  const state = await buildApprovedTraderLiveState(userId, {
    includeBridgeHeartbeat: false,
  });
  const decision = decideLiveExecutionActivationGate(state);
  return { ...decision, state };
}

/**
 * PURE decision for the activation gate given an already-resolved state. Split
 * out so the gate semantics can be tested deterministically without a DB. The
 * precedence is fixed and fail-closed: bot/agent/system → investor →
 * not-activated → PASS. This NEVER weakens or ORs any existing Phase B gate.
 */
export function decideLiveExecutionActivationGate(
  state: ApprovedTraderLiveState,
): Omit<LiveExecutionActivationGateResult, "state"> {
  if (state.isBotAgentSystem) {
    return {
      passed: false,
      reason: "BOT_AGENT_NOT_ALLOWED",
      detail: USER_SAFE_BLOCK_COPY.BOT_AGENT_NOT_ALLOWED,
    };
  }
  if (state.isInvestor) {
    return {
      passed: false,
      reason: "INVESTOR_NOT_ALLOWED",
      detail: USER_SAFE_BLOCK_COPY.INVESTOR_NOT_ALLOWED,
    };
  }
  if (!state.executionActivated) {
    return {
      passed: false,
      reason: "LIVE_EXECUTION_ACTIVATION_GATE",
      detail: "Live execution is not activated for this trader.",
    };
  }
  return { passed: true, reason: null, detail: null };
}
