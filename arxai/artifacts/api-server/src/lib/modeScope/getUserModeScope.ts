// T006 — Shared mode-scope resolver for user-facing data surfaces.
//
// Single source of truth that every read endpoint can use to decide
// "which rows belong to this user, in this mode, right now?".
//
// Reuses the T003 precedence helper so the answer is byte-for-byte
// consistent with /api/me/account-mode (which the frontend consumes
// via useTradingMode()). A surface that uses this helper to filter
// its rows is guaranteed to never show DEMO/PAPER rows to a
// LIVE_SHARED user, never show LIVE rows to a PAPER user, and never
// leak another user's data.
//
// SAFETY:
//   * Pure READ — no writes, no broker calls, no queue inserts.
//   * Strictly per-user (helpers it composes are all userId-scoped).
//   * Never returns master broker credentials, bridge tokens, raw
//     account numbers, IPs, or any other user's data.
//   * Admins get the same shape; the admin-only override is the
//     `adminOverrideMode` parameter — caller decides if/when to allow
//     it (e.g. an admin diagnostic endpoint).

import { db, globalTradingSettingsTable } from "@workspace/db";
import { computeAccountShell } from "../../routes/meAccountShell.js";
import { getMyArming } from "../live/liveArming.js";
import { resolveLiveBrokerExecutionEnabledAsync } from "../live/phaseBConfig.js";
import { isLiveBrokerExecutionEnabledEnv } from "@workspace/domain/safety-contracts/isLiveBrokerExecutionEnabled";
import {
  computeAccountModePrecedence,
  type CurrentAccountMode,
} from "../computeAccountModePrecedence.js";
import { buildApprovedTraderLiveState } from "../live/approvedTraderLiveState.js";

export type { CurrentAccountMode };

export interface UserModeScope {
  userId: number;
  /** The mode the UI is showing the user right now (from T003 precedence). */
  currentAccountMode: CurrentAccountMode;
  /** True when the user is armed for live execution. */
  liveExecutionArmed: boolean;
  /** True when the user has a SHARED_MASTER allocation attached. */
  sharedMasterAttached: boolean;
  /** True when the caller's session is a real admin (NOT preview-as-user). */
  isAdmin: boolean;
  /**
   * What table family the surface should read for "trade-like" data:
   *   LIVE_SHARED → "live"   (live_positions / shared_trade_attribution / arx_live_*)
   *   DEMO        → "demo"   (mt5_state / mt5_demo_commands)
   *   PAPER       → "paper"  (paper_trades)
   */
  primaryDataDomain: "live" | "demo" | "paper";
}

export interface ResolveOptions {
  /**
   * Admin diagnostic override — when truthy AND the caller is admin,
   * forces a specific mode (e.g. inspect another user's mode). Normal
   * users are silently ignored if they try to override.
   */
  adminOverrideMode?: CurrentAccountMode | null;
}

function modeToDomain(m: CurrentAccountMode): UserModeScope["primaryDataDomain"] {
  if (m === "LIVE_SHARED") return "live";
  if (m === "DEMO") return "demo";
  return "paper";
}

/**
 * Resolve the mode-scope for `userId`. Always returns a value — never
 * throws, so a degraded resolver never silently leaks the wrong rows.
 * On any internal failure, falls back to the safest mode (PAPER).
 */
export async function getUserModeScope(
  userId: number,
  opts: { isAdmin?: boolean; adminOverrideMode?: CurrentAccountMode | null } = {},
): Promise<UserModeScope> {
  const isAdmin = opts.isAdmin === true;

  try {
    const [accountShell, arming, serverEnvOn, effectiveOn, globalRow, traderState] =
      await Promise.all([
        // skipInvestorSnapshot breaks the otherwise-infinite mutual recursion
        // (computeAccountShell → buildInvestorLiveBalanceSnapshot → getUserModeScope).
        // This resolver only reads tradingMode/tradingStatus/notes below.
        computeAccountShell(userId, { skipInvestorSnapshot: true }),
        getMyArming(userId),
        Promise.resolve(isLiveBrokerExecutionEnabledEnv()),
        resolveLiveBrokerExecutionEnabledAsync(),
        db.select().from(globalTradingSettingsTable).limit(1).then((r) => r[0] ?? null),
        // Task #737 — display pin for admin-approved human traders attached to
        // the shared live bridge. Heartbeat read skipped: the display pin does
        // not depend on it, keeping this hot path cheap.
        buildApprovedTraderLiveState(userId, { includeBridgeHeartbeat: false }),
      ]);

    const operatorOn = globalRow?.liveBrokerExecutionArmed === true;
    const liveExecutionArmed = arming?.isArmed === true;
    const sharedMasterAttached = accountShell.notes.sharedMasterAccountAssigned === true;

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
      approvedTraderBridgeAssigned: traderState.approvedTraderBridgeAssigned,
    });

    let currentAccountMode: CurrentAccountMode = precedence.currentAccountMode;
    if (isAdmin && opts.adminOverrideMode != null) {
      currentAccountMode = opts.adminOverrideMode;
    }

    return {
      userId,
      currentAccountMode,
      liveExecutionArmed,
      sharedMasterAttached,
      isAdmin,
      primaryDataDomain: modeToDomain(currentAccountMode),
    };
  } catch {
    // Safest fallback — PAPER never reads live tables and never claims
    // to be live. A normal user seeing PAPER on a transient failure is
    // strictly safer than seeing LIVE_SHARED on a transient failure.
    return {
      userId,
      currentAccountMode: "PAPER",
      liveExecutionArmed: false,
      sharedMasterAttached: false,
      isAdmin,
      primaryDataDomain: "paper",
    };
  }
}

/**
 * Convenience: a tiny envelope every mode-scoped endpoint can spread
 * into its response so the frontend can verify which mode the backend
 * actually used to filter the rows.
 */
export function modeScopeEnvelope(scope: UserModeScope): {
  currentAccountMode: CurrentAccountMode;
  modeScopeApplied: true;
  primaryDataDomain: UserModeScope["primaryDataDomain"];
} {
  return {
    currentAccountMode: scope.currentAccountMode,
    modeScopeApplied: true,
    primaryDataDomain: scope.primaryDataDomain,
  };
}
