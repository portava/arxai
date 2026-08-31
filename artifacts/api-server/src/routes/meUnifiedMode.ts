// Unified per-user account-mode resolver — T003.
//
// Single source of truth that every page consumes via the
// `useTradingMode()` frontend hook. Composes existing read-only
// helpers (no schema changes, no writes):
//
//   * computeAccountShell(userId)          — meAccountShell.ts
//   * getMyArming(userId)                  — lib/live/liveArming.ts
//   * resolveLiveBrokerExecutionEnabledAsync() — lib/live/phaseBConfig.ts
//   * isLiveBrokerExecutionEnabledEnv()    — domain/safety-contracts
//   * detectCurrentConnectedBridge()       — lib/mt5/...
//   * getEnvelope(userId)                  — lib/adminTrading/safetyEnvelope
//
// SAFETY (inviolable):
//   * Pure READ. No DB writes. No queue inserts. No broker calls.
//   * Strictly per-user. Every embedded helper is already userId-scoped.
//   * Normal-user response strips raw booleans (canSubmitLiveIntent,
//     canExecuteRealBrokerOrder, mt5Connected, heartbeatFresh, the
//     full bridge evidence blob, the raw safety envelope) and any
//     master-switch literals. Only ADMIN/OWNER sessions get the
//     `adminDiagnostics` block.
//   * `isAdminPreviewingUserMode` is derived from the effective-view-mode
//     middleware: when a real ADMIN/OWNER toggles into "user" view, their
//     `req.authUser.role` is downgraded to "USER" and `realRole` is
//     preserved. We treat them as a normal user (no admin diagnostics)
//     but expose the preview flag so the UI can show the "previewing as
//     user" badge.
//   * Master switch is read via the narrow `isEnvTruthy("true")` helper.
//     When OFF, we surface an ADMIN-ONLY `envExpectedLiteral` so an
//     operator can see exactly what value the env var must hold; normal
//     users see a generic "live execution is currently disabled" string.
//   * Never returns: master broker credentials, bridge tokens, raw
//     account numbers, IP addresses, or any other user's data.

import { Router, type Request } from "express";
import { requireUser } from "../lib/auth/middleware.js";
import { computeAccountShell, type AccountShellResponse } from "./meAccountShell.js";
import { getMyArming } from "../lib/live/liveArming.js";
import {
  resolveLiveBrokerExecutionEnabledAsync,
} from "../lib/live/phaseBConfig.js";
import { isLiveBrokerExecutionEnabledEnv } from "@workspace/domain/safety-contracts/isLiveBrokerExecutionEnabled";
import {
  detectCurrentConnectedBridge,
  maskBridgeEvidenceForUser,
} from "../lib/mt5/currentConnectedBridgeDetector.js";
import { getEnvelope, type SafetyEnvelope } from "../lib/adminTrading/safetyEnvelope.js";
import { db, globalTradingSettingsTable } from "@workspace/db";
import {
  computeAccountModePrecedence,
  type CurrentAccountMode as PrecedenceMode,
} from "../lib/computeAccountModePrecedence.js";

const router = Router();

export type CurrentAccountMode = "LIVE_SHARED" | "DEMO" | "PAPER";
export type AccountModeRole = "OWNER" | "ADMIN" | "USER";

export interface UnifiedAccountModeResponse {
  ok: true;
  userId: number;
  currentAccountMode: CurrentAccountMode;
  cleanModeLabel: string;
  cleanUserMessage: string;
  /**
   * When live is desired but blocked by something, a user-safe
   * one-liner. NULL when nothing is blocking the current mode.
   * Admins additionally get the technical detail in
   * `adminDiagnostics.envExpectedLiteral` etc.
   */
  cleanBlockedReason: string | null;

  role: AccountModeRole;
  isAdmin: boolean;
  isAdminPreviewingUserMode: boolean;
  adminDiagnosticsAvailable: boolean;

  liveExecutionArmed: boolean;

  userSharedMasterAssignment: { attached: boolean };

  accountShellStatus: {
    accountMode: AccountShellResponse["accountMode"];
    tradingMode: AccountShellResponse["tradingMode"];
    tradingModeLabel: string;
    approvalStatus: AccountShellResponse["approvalStatus"];
    tradingStatus: AccountShellResponse["tradingStatus"];
  };

  userAllocation: {
    hasAllocation: boolean;
    currentBalance: number;
    assignedStartingBalance: number | null;
    // null = no marked-to-market equity read exists (never balance-as-equity).
    equity: number | null;
    marginUsed: number;
  };

  userRiskCaps: {
    maxLotSize: number | null;
    maxOpenTrades: number | null;
    maxDailyLossAmount: number | null;
    allowedSymbols: string[] | null;
    requireStopLoss: boolean;
  };

  userFrozenStatus: {
    isFrozen: boolean;
    freezeMessage: string | null;
  };

  userApprovalStatus: AccountShellResponse["approvalStatus"];
  userCanManualTrade: boolean;
  userCanAutoTrade: boolean;

  aiSleeveStatus: {
    enabled: boolean;
    autoEnabled: boolean;
  };

  demoAvailable: boolean;
  paperAvailable: boolean;
  modeSwitchOptions: CurrentAccountMode[];

  /**
   * Present ONLY for ADMIN/OWNER sessions that are NOT currently
   * previewing as user. Normal users always receive `null` here.
   */
  adminDiagnostics: AdminDiagnostics | null;
}

export interface AdminDiagnostics {
  envExpectedLiteral: "true";
  envCurrentParses: boolean;
  brokerExecutionStatus: {
    server: boolean;
    operator: boolean;
    effective: boolean;
  };
  liveBridge:
    | { ok: true; bridge: ReturnType<typeof maskBridgeEvidenceForUser> }
    | { ok: false; primaryReason: string; latestHint: ReturnType<typeof maskBridgeEvidenceForUser> | null };
  activeConnectionId: number | null;
  activeBridgeId: number | null;
  activeAccountType: string | null;
  mt5Connected: boolean;
  heartbeatFresh: boolean;
  rawEnvelope: SafetyEnvelope;
  rawAccountShell: AccountShellResponse;
}

function resolveRole(authUser: { role?: string; realRole?: string } | undefined): {
  role: AccountModeRole;
  isAdmin: boolean;
  isAdminPreviewingUserMode: boolean;
} {
  const effective = String(authUser?.role ?? "").toUpperCase();
  const real = String(authUser?.realRole ?? "").toUpperCase();
  const realIsAdmin = real === "ADMIN" || real === "OWNER";
  const effectiveIsAdmin = effective === "ADMIN" || effective === "OWNER";

  if (effectiveIsAdmin) {
    return {
      role: effective === "OWNER" ? "OWNER" : "ADMIN",
      isAdmin: true,
      isAdminPreviewingUserMode: false,
    };
  }
  if (realIsAdmin) {
    return {
      role: "USER",
      isAdmin: false,
      isAdminPreviewingUserMode: true,
    };
  }
  return { role: "USER", isAdmin: false, isAdminPreviewingUserMode: false };
}

router.get("/me/account-mode", requireUser, async (req: Request, res) => {
  const userId = req.authUser!.id;

  try {
    // All independent READ-ONLY reads in parallel. NOTE: getEnvelope()
    // has a seed-on-read side effect against global_trading_settings, so
    // we DO NOT call it here in the user path. It is invoked later inside
    // the admin-only branch where the write-on-read is acceptable (admins
    // already trigger that endpoint via /admin/* surfaces).
    const { role, isAdmin, isAdminPreviewingUserMode } = resolveRole(req.authUser);

    const [
      accountShell,
      arming,
      serverEnvOn,
      effectiveOn,
      globalRow,
    ] = await Promise.all([
      computeAccountShell(userId),
      getMyArming(userId),
      Promise.resolve(isLiveBrokerExecutionEnabledEnv()),
      resolveLiveBrokerExecutionEnabledAsync(),
      db.select().from(globalTradingSettingsTable).limit(1).then((r) => r[0] ?? null),
    ]);

    // Operator arm = effective requires env AND db arm. The pure
    // operator-controllable bit is just the DB flag.
    const operatorOn = globalRow?.liveBrokerExecutionArmed === true;

    const liveExecutionArmed = arming?.isArmed === true;
    const sharedMasterAttached = accountShell.notes.sharedMasterAccountAssigned === true;

    // ── Precedence (per T003 spec) ─────────────────────────────────────
    // Extracted into a pure helper so the matrix can be unit-tested
    // without seeding the DB. The behaviour is byte-for-byte preserved.
    const precedence = computeAccountModePrecedence({
      isAdmin,
      liveExecutionArmed,
      sharedMasterAttached,
      effectiveLiveBrokerOn: effectiveOn,
      serverEnvOn,
      operatorOn,
      accountShellTradingMode: accountShell.tradingMode,
      accountShellTradingStatus: accountShell.tradingStatus,
      needsReviewItems:
        typeof accountShell.notes.needsReviewItems === "number"
          ? accountShell.notes.needsReviewItems > 0
          : accountShell.notes.needsReviewItems === true,
    });
    const currentAccountMode: PrecedenceMode = precedence.currentAccountMode;
    const cleanBlockedReason = precedence.cleanBlockedReason;
    const cleanModeLabel = precedence.cleanModeLabel;
    const cleanUserMessage = precedence.cleanUserMessage;
    const userCanManualTrade = precedence.userCanManualTrade;
    const userCanAutoTrade = precedence.userCanAutoTrade;

    // Demo / paper / mode switch options
    const demoAvailable = true; // demo is always available
    const paperAvailable = accountShell.accountMode !== "SHARED_MASTER_MT5";
    const modeSwitchOptions: CurrentAccountMode[] = liveExecutionArmed
      ? ["LIVE_SHARED"] // armed users cannot switch off live without disarming first
      : paperAvailable
        ? ["DEMO", "PAPER"]
        : ["DEMO"];

    const allocation = accountShell.allocation;
    const hasAllocation =
      allocation.currentBalance > 0 || allocation.assignedStartingBalance != null;

    const userFrozenStatus = {
      isFrozen:
        accountShell.tradingStatus === "PAUSED" || accountShell.tradingStatus === "RESTRICTED",
      freezeMessage:
        accountShell.tradingStatus === "PAUSED"
          ? "Trading is paused on your account."
          : accountShell.tradingStatus === "RESTRICTED"
            ? "Trading is restricted on your account. Contact your operator."
            : null,
    };

    // Admin diagnostics (admin-only, never when previewing as user).
    // The seed-on-read getEnvelope() and the deep bridge detector are
    // only invoked here so the user-facing path stays pure read-only.
    let adminDiagnostics: AdminDiagnostics | null = null;
    if (isAdmin) {
      const [bridge, envelope] = await Promise.all([
        detectCurrentConnectedBridge(),
        getEnvelope(userId),
      ]);
      const liveBridge =
        bridge.ok === true
          ? { ok: true as const, bridge: maskBridgeEvidenceForUser(bridge.bridge) }
          : {
              ok: false as const,
              primaryReason: bridge.primaryReason,
              latestHint: bridge.latestHint ? maskBridgeEvidenceForUser(bridge.latestHint) : null,
            };
      const bridgeOk = liveBridge.ok === true;
      adminDiagnostics = {
        envExpectedLiteral: "true",
        envCurrentParses: serverEnvOn,
        brokerExecutionStatus: {
          server: serverEnvOn,
          operator: operatorOn,
          effective: effectiveOn,
        },
        liveBridge,
        activeConnectionId: bridgeOk ? liveBridge.bridge.bridgeId : null,
        activeBridgeId: bridgeOk ? liveBridge.bridge.bridgeId : null,
        activeAccountType: bridgeOk ? liveBridge.bridge.accountType : null,
        mt5Connected: bridgeOk,
        heartbeatFresh:
          bridgeOk &&
          liveBridge.bridge.heartbeatAgeSec != null &&
          liveBridge.bridge.heartbeatAgeSec <= 15,
        rawEnvelope: envelope,
        rawAccountShell: accountShell,
      };
    }

    const body: UnifiedAccountModeResponse = {
      ok: true,
      userId,
      currentAccountMode,
      cleanModeLabel,
      cleanUserMessage,
      cleanBlockedReason,
      role,
      isAdmin,
      isAdminPreviewingUserMode,
      adminDiagnosticsAvailable: isAdmin,
      liveExecutionArmed,
      userSharedMasterAssignment: { attached: sharedMasterAttached },
      accountShellStatus: {
        accountMode: accountShell.accountMode,
        tradingMode: accountShell.tradingMode,
        tradingModeLabel: accountShell.tradingModeLabel,
        approvalStatus: accountShell.approvalStatus,
        tradingStatus: accountShell.tradingStatus,
      },
      userAllocation: {
        hasAllocation,
        currentBalance: allocation.currentBalance,
        assignedStartingBalance: allocation.assignedStartingBalance,
        equity: allocation.equity,
        marginUsed: allocation.marginUsed,
      },
      userRiskCaps: {
        maxLotSize: accountShell.risk.maxLotSize,
        maxOpenTrades: accountShell.risk.maxOpenTrades,
        maxDailyLossAmount: accountShell.risk.maxDailyLossAmount,
        allowedSymbols: accountShell.risk.allowedSymbols,
        requireStopLoss: accountShell.risk.requireStopLoss,
      },
      userFrozenStatus,
      userApprovalStatus: accountShell.approvalStatus,
      userCanManualTrade,
      userCanAutoTrade,
      aiSleeveStatus: {
        // Best-effort surface; the deep ai-sleeve detail lives at
        // /api/me/allocation. This is a binary "is the sleeve enabled
        // at all" hint so banners can show/hide.
        enabled: currentAccountMode !== "PAPER",
        autoEnabled: userCanAutoTrade,
      },
      demoAvailable,
      paperAvailable,
      modeSwitchOptions,
      adminDiagnostics,
    };

    res.json(body);
  } catch (e) {
    req.log.warn(
      { err: (e as Error).message },
      "me_unified_account_mode_failed",
    );
    res.status(500).json({ ok: false, error: "ACCOUNT_MODE_UNAVAILABLE" });
  }
});

export default router;
