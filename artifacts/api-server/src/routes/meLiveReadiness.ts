// User-facing — Live Readiness Diagnostic (VIEW vs EXECUTION)
//
// GET /api/me/live-readiness
//
// A focused diagnostic that splits two distinct, independently-true
// questions the dashboard repeatedly conflates:
//
//   VIEW readiness      — can this user SEE the shared-bridge market
//                         context (master symbol directory, scanner,
//                         candles)? This is visibility scaffolding only;
//                         being attached to the shared master bridge
//                         (a live virtual-trading-account that is
//                         `active`) clears the "assignment pending" UI.
//
//   EXECUTION readiness — can this user actually DISPATCH a live trade?
//                         This still requires the per-user master-live
//                         access gate to PASS, the platform to permit
//                         live broker execution, AND the user to have
//                         MANUALLY armed (`arx_live_arming.is_armed`).
//                         Attachment NEVER implies execution — arming is
//                         always a separate, manual step, and every
//                         dispatch still re-runs the 23 Phase B gates.
//
// This route does NOT rewrite the readiness system: it composes the
// existing platform-bridge-mode + per-user access gate + arming
// evaluators and reports their split verdict.
//
// SECURITY:
//   - requireUser (no anonymous access)
//   - Scoped to req.authUser.id only; no :userId param
//   - No token/secret/account-number/broker-name ever in the payload
//   - Raw gate codes only under `details.rawCodes`
import express, { type IRouter, Router } from "express";
import { eq } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import {
  db,
  globalTradingSettingsTable,
  virtualTradingAccountsTable,
} from "@workspace/db";
import {
  derivePlatformBridgeMode,
  type PlatformBridgeMode,
} from "@workspace/domain/safety-contracts";
import { loadAndEvaluateUserMasterLiveAccessGate } from "../lib/mt5/userMasterLiveAccessGate.js";
import { liveBrokerExecutionEnabled } from "../lib/live/phaseBConfig.js";
import { getMyArming } from "../lib/live/liveArming.js";
import {
  buildApprovedTraderLiveState,
  type ApprovedTraderLiveState,
} from "../lib/live/approvedTraderLiveState.js";
import { buildUnifiedLiveReadiness } from "../lib/live/unifiedLiveReadiness.js";

// Task #737 — Project the shared approved-trader live-state resolver into a
// user-safe readiness block. ONLY honest derived fields; never raw gate codes,
// bridge ids, tokens, account numbers, or other-user data. `displayMode` mirrors
// the account-mode precedence pin (approved + bridge-attached human → LIVE_SHARED
// display even before arming/confirmation), while `canPlaceRealMoneyTrades`
// reflects the fully-gated execution readiness (dispatch still re-gates).
function projectLiveState(state: ApprovedTraderLiveState) {
  return {
    accountMode: state.intendedLiveDisplay ? "LIVE" : "DEMO",
    displayMode: state.approvedTraderBridgeAssigned
      ? "LIVE_SHARED"
      : state.armed
        ? "LIVE_SHARED"
        : "DEMO",
    approvedTrader: state.approvedForLive,
    liveBridgeApproved: state.liveBridgeAssigned,
    liveExecutionEnabled: state.liveExecutionEnabled,
    liveConfirmationRequired: state.liveConfirmationRequired,
    fullLiveActivation: state.executionActivated,
    activationSource: state.liveExecutionActivationSource,
    armed: state.armed,
    killSwitchEngaged: state.killSwitchEngaged,
    bridgeConnected: state.bridgeConnected,
    bridgeHeartbeatFresh: state.bridgeHeartbeatFresh,
    riskProfileReady: state.riskProfileReady,
    canPlaceRealMoneyTrades: state.executionReady,
    blockingReasonCode: state.blockingReasonCode,
    blockingReason: state.blockingReason,
  };
}

const router: IRouter = Router();
router.use(express.json());

// Plain-English headline for the single most-important EXECUTION blocker.
const EXEC_BLOCK_HEADLINES: Record<string, string> = {
  USER_NOT_APPROVED_FOR_MASTER_LIVE: "Admin approval required",
  USER_LIVE_BRIDGE_REQUEST_PENDING: "Your live-access request is pending review",
  USER_LIVE_BRIDGE_REQUEST_DENIED: "Your live-access request was declined",
  USER_MASTER_LIVE_REVOKED: "Live trading access was revoked",
  USER_MASTER_LIVE_TOGGLE_OFF: "Live trading is paused for your account",
  USER_MASTER_LIVE_SUSPENDED: "Live trading is suspended for your account",
  USER_MASTER_LIVE_RISK_LOCKED: "Live trading is risk-locked for your account",
  USER_MISSING_RISK_DISCLOSURE: "Accept the live risk disclosure to continue",
  USER_MISSING_RISK_SETTINGS: "Configure your risk settings to continue",
};

const EXEC_BLOCK_NEXT_STEPS: Record<string, string> = {
  USER_NOT_APPROVED_FOR_MASTER_LIVE: "Ask an admin to approve your account for master live trading.",
  USER_LIVE_BRIDGE_REQUEST_PENDING: "An admin will review your request shortly.",
  USER_LIVE_BRIDGE_REQUEST_DENIED: "Contact an admin to discuss your request.",
  USER_MASTER_LIVE_REVOKED: "Contact an admin to restore live access.",
  USER_MASTER_LIVE_TOGGLE_OFF: "An admin can re-enable live trading for your account.",
  USER_MASTER_LIVE_SUSPENDED: "Contact an admin to review the suspension.",
  USER_MASTER_LIVE_RISK_LOCKED: "Contact an admin to review the risk lock.",
  USER_MISSING_RISK_DISCLOSURE: "Open the live risk disclosure and accept it.",
  USER_MISSING_RISK_SETTINGS: "Open Risk Settings and complete the required fields.",
};

const PLATFORM_BLOCK_HEADLINES: Record<PlatformBridgeMode, string> = {
  demo: "Real broker execution is locked",
  per_user_live_bridge: "Per-user live bridge mode",
  master_live_bridge_readonly: "Master live bridge is read-only",
  master_live_bridge_execution_pending: "Live execution layer not yet enabled",
  master_live_bridge_execution_enabled: "Live execution layer enabled",
};

router.get("/me/live-readiness", requireUser, async (req, res) => {
  const userId = req.authUser!.id;

  const [settingsRows, vAccounts, userGate, arming, liveState] = await Promise.all([
    db.select().from(globalTradingSettingsTable).limit(1),
    db
      .select({
        status: virtualTradingAccountsTable.status,
        sharedMasterAccountId: virtualTradingAccountsTable.sharedMasterAccountId,
      })
      .from(virtualTradingAccountsTable)
      .where(eq(virtualTradingAccountsTable.userId, userId)),
    loadAndEvaluateUserMasterLiveAccessGate(userId),
    getMyArming(userId),
    buildApprovedTraderLiveState(userId),
  ]);

  const s = settingsRows[0];
  const platform = derivePlatformBridgeMode({
    platformMode: s?.platformMode,
    accountRoutingMode: s?.accountRoutingMode,
    masterBridgeLiveEnabled: !!s?.masterBridgeLiveEnabled,
    sharedLiveTradingEnabled: !!s?.sharedLiveTradingEnabled,
    liveBrokerExecutionEnabled: liveBrokerExecutionEnabled(),
  });

  // ---- Attached status (visibility scaffolding) -------------------------
  // Mirrors meAccountShell's `sharedMasterAssigned`: a shared-master VTA
  // that is `active`. No accountType filter — a live OR demo active VTA
  // flips this true, clearing the "assignment pending" UI.
  const attachedToSharedBridge = vAccounts.some(
    (a) => a.sharedMasterAccountId != null && String(a.status ?? "").toLowerCase() === "active",
  );

  // ---- VIEW readiness ---------------------------------------------------
  // The user can see the shared-bridge market context once an admin has
  // approved them (the per-user gate no longer reports "not approved"),
  // regardless of arming. Symbols/scanner/candles already resolve via the
  // effective shared-bridge owner for approved users, so VIEW does not
  // require execution readiness.
  const notApproved =
    userGate.decision === "BLOCKED" &&
    (userGate.primaryReason === "USER_NOT_APPROVED_FOR_MASTER_LIVE" ||
      userGate.primaryReason === "USER_LIVE_BRIDGE_REQUEST_PENDING" ||
      userGate.primaryReason === "USER_LIVE_BRIDGE_REQUEST_DENIED" ||
      userGate.primaryReason === "USER_MASTER_LIVE_REVOKED");
  const viewReady = !notApproved;
  const viewReason = viewReady
    ? attachedToSharedBridge
      ? "You're attached to the shared live bridge — market data and the scanner reflect the master directory."
      : "You can view the shared-bridge market context. Your account allocation is still being set up."
    : "Admin approval is required before you can view the shared live bridge context.";

  // ---- EXECUTION readiness ---------------------------------------------
  const userGateGovernsThisMode =
    platform.mode === "master_live_bridge_readonly" ||
    platform.mode === "master_live_bridge_execution_pending" ||
    platform.mode === "master_live_bridge_execution_enabled";
  const userBlocked = userGateGovernsThisMode && userGate.decision === "BLOCKED";
  const platformBlocked = !platform.liveBrokerExecutionPossible;
  const armed = arming?.isArmed === true;
  const killSwitchEngaged = arming?.killSwitchEngaged === true;

  // EXECUTION is ready ONLY when the platform permits live execution, the
  // per-user gate passes, the kill switch is clear, AND the user has
  // manually armed. Arming is never implied by approval/attachment.
  const executionReady = !platformBlocked && !userBlocked && armed && !killSwitchEngaged;

  let execHeadline: string;
  let execNextStep: string;
  if (userBlocked) {
    const code = userGate.decision === "BLOCKED" ? userGate.primaryReason : "";
    execHeadline = EXEC_BLOCK_HEADLINES[code] ?? "Live trading is unavailable for your account";
    execNextStep = EXEC_BLOCK_NEXT_STEPS[code] ?? "Contact an admin.";
  } else if (platformBlocked) {
    execHeadline = PLATFORM_BLOCK_HEADLINES[platform.mode];
    execNextStep =
      platform.mode === "master_live_bridge_execution_pending"
        ? "An admin must enable the server live-execution switch."
        : platform.mode === "master_live_bridge_readonly"
          ? "An admin must take the master bridge out of read-only mode."
          : "Real broker execution will become available once an admin enables it.";
  } else if (killSwitchEngaged) {
    execHeadline = "Live trading is halted by the kill switch";
    execNextStep = "Reset the kill switch before arming again.";
  } else if (!armed) {
    execHeadline = "Arm live trading to execute";
    execNextStep = "Open Live Arming and complete the manual arming gate. Every dispatch still re-checks all 23 safety gates.";
  } else {
    execHeadline = "Live execution is ready";
    execNextStep = "Place trades from the Live Trade Ticket. All 23 Phase B gates are re-checked per dispatch.";
  }

  // User-safe payload only. NO bridge tokens, account numbers, EA hashes,
  // or broker names ever appear here.
  return res.json({
    ok: true,
    platformBridgeMode: platform.mode,
    attachedToSharedBridge,
    // Task #737 — single shared resolver projection (display + execution truth).
    liveState: projectLiveState(liveState),
    view: {
      ready: viewReady,
      attachedToSharedBridge,
      reason: viewReason,
    },
    execution: {
      ready: executionReady,
      approved: !userBlocked && userGate.decision === "PASS",
      armed,
      killSwitchEngaged,
      blocked: userBlocked || platformBlocked,
      headline: execHeadline,
      nextStep: execNextStep,
    },
    // Raw codes are surfaced for an admin/debug view only — the primary UI
    // renders the plain-English headlines above. No secrets, no other-user
    // data.
    details: {
      platformHeadline: platform.headline,
      platformLiveExecutionPossible: platform.liveBrokerExecutionPossible,
      userGateDecision: userGate.decision,
      rawCodes: userGate.decision === "BLOCKED" ? userGate.blockReasons : [],
    },
  });
});

// Task #785 — Unified live-readiness resolver projection.
//
// GET /api/me/live-readiness/unified?symbol=...&timeframe=...
//
// ONE honest readiness verdict consumed by every live-capable surface and the
// feed-completeness debug panel. Self-scoped, never returns broker credentials,
// tokens, account numbers, or other-user data. DESCRIBE-only: every live order
// still re-runs the full instant-trade router → live pipeline → 18-gate dispatch.
router.get("/me/live-readiness/unified", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const symbol =
    typeof req.query.symbol === "string" && req.query.symbol.trim()
      ? req.query.symbol.trim()
      : null;
  const timeframe =
    typeof req.query.timeframe === "string" && req.query.timeframe.trim()
      ? req.query.timeframe.trim()
      : null;

  const state = await buildUnifiedLiveReadiness(userId, { symbol, timeframe });
  return res.json({ ok: true, readiness: state });
});

export default router;
