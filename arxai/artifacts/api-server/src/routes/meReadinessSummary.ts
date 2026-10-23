// User-facing — Live Readiness Summary
//
// GET /api/me/readiness/summary
//
// Joins (platform bridge mode) + (per-user master live access gate) +
// (server master switch) into a single plain-English payload the
// dashboard can render WITHOUT exposing raw codes, tokens, account
// numbers, broker names, or server names. Raw codes are returned only
// behind `details.rawCodes` so an admin debug view can opt in; the
// normal user UI ignores them.
//
// SECURITY:
//   - requireUser (no anonymous access)
//   - Scoped to req.authUser.id only; no :userId param
//   - No token/secret/account-number ever in the payload
import express, { type IRouter, Router } from "express";
import { requireUser } from "../lib/auth/middleware.js";
import { db, globalTradingSettingsTable } from "@workspace/db";
import {
  derivePlatformBridgeMode,
  type PlatformBridgeMode,
} from "@workspace/domain/safety-contracts";
import { loadAndEvaluateUserMasterLiveAccessGate } from "../lib/mt5/userMasterLiveAccessGate.js";
import { liveBrokerExecutionEnabled } from "../lib/live/phaseBConfig.js";

const router: IRouter = Router();
router.use(express.json());

const USER_BLOCK_HEADLINES: Record<string, string> = {
  USER_NOT_APPROVED_FOR_MASTER_LIVE: "Admin approval required",
  USER_MASTER_LIVE_TOGGLE_OFF: "Live trading is paused for your account",
  USER_MASTER_LIVE_SUSPENDED: "Live trading is suspended for your account",
  USER_MASTER_LIVE_RISK_LOCKED: "Live trading is risk-locked for your account",
  USER_MISSING_RISK_DISCLOSURE: "Accept the live risk disclosure to continue",
  USER_MISSING_RISK_SETTINGS: "Configure your risk settings to continue",
};

const USER_BLOCK_NEXT_STEPS: Record<string, string> = {
  USER_NOT_APPROVED_FOR_MASTER_LIVE: "Ask an admin to approve your account for master live trading.",
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

router.get("/me/readiness/summary", requireUser, async (req, res) => {
  const userId = req.authUser!.id;

  const settingsRows = await db.select().from(globalTradingSettingsTable).limit(1);
  const s = settingsRows[0];
  const platform = derivePlatformBridgeMode({
    platformMode: s?.platformMode,
    accountRoutingMode: s?.accountRoutingMode,
    masterBridgeLiveEnabled: !!s?.masterBridgeLiveEnabled,
    sharedLiveTradingEnabled: !!s?.sharedLiveTradingEnabled,
    liveBrokerExecutionEnabled: liveBrokerExecutionEnabled(),
  });

  const userGate = await loadAndEvaluateUserMasterLiveAccessGate(userId);

  // The per-user master-live access gate ONLY governs the shared-master
  // routing path. When the platform is in demo or per-user-bridge mode,
  // a user-gate block is not the true blocker — surfacing it would
  // mislead the user. Only let it take precedence when the platform is
  // actually using shared-master routing.
  const userGateGovernsThisMode =
    platform.mode === "master_live_bridge_readonly" ||
    platform.mode === "master_live_bridge_execution_pending" ||
    platform.mode === "master_live_bridge_execution_enabled";
  const userBlocked = userGateGovernsThisMode && userGate.decision === "BLOCKED";
  const platformBlocked = !platform.liveBrokerExecutionPossible;

  let primaryHeadline: string;
  let primaryNextStep: string;
  let primaryReasonPlain: string;

  if (userBlocked) {
    const code = userGate.primaryReason;
    primaryHeadline = USER_BLOCK_HEADLINES[code] ?? "Live trading is unavailable for your account";
    primaryNextStep = USER_BLOCK_NEXT_STEPS[code] ?? "Contact an admin.";
    primaryReasonPlain = primaryHeadline;
  } else if (platformBlocked) {
    primaryHeadline = PLATFORM_BLOCK_HEADLINES[platform.mode];
    primaryNextStep =
      platform.mode === "master_live_bridge_execution_pending"
        ? "An admin must enable the server live-execution switch."
        : platform.mode === "master_live_bridge_readonly"
        ? "An admin must take the master bridge out of read-only mode."
        : "Real broker execution will become available once an admin enables it.";
    primaryReasonPlain = platform.headline;
  } else {
    primaryHeadline = "Live trading is available for your account";
    primaryNextStep = "Place trades from the Live Trade Ticket. All Phase B gates are re-checked per dispatch.";
    primaryReasonPlain = platform.headline;
  }

  // User-safe payload only. NO raw bridge tokens, account numbers, EA
  // hashes, or broker names ever appear here.
  return res.json({
    ok: true,
    platformBridgeMode: platform.mode,
    plainEnglish: {
      headline: primaryHeadline,
      demoAvailable: platform.demoAvailable,
      liveBrokerExecutionPossible: platform.liveBrokerExecutionPossible && !userBlocked,
      primaryReason: primaryReasonPlain,
      nextStep: primaryNextStep,
    },
    userStatus: userGate.decision === "PASS" ? userGate.access.masterLiveStatus : userGate.status,
    masterLiveTradingEnabled:
      userGate.decision === "PASS" ? userGate.access.masterLiveTradingEnabled : false,
    scannerLiveEnabled:
      userGate.decision === "PASS" ? !!userGate.access.scannerLiveEnabled : false,
    // Raw codes are surfaced so debug views CAN render them, but the
    // primary UI ignores them. No secrets, no other-user data.
    details: {
      platformHeadline: platform.headline,
      platformNextStep: platform.nextPlatformStep,
      userBlockReasons: userGate.decision === "BLOCKED" ? userGate.blockReasons : [],
    },
  });
});

export default router;
