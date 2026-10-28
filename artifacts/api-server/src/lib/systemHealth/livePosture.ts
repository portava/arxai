// Live-trading posture, worded from the ONE source the cockpit uses.
//
// Many older modules (help, why-blocked, readiness gate, system health,
// command center) were written when the whole app was paper-only and still
// return constants like liveTradingStatus "DISABLED" / mode "PAPER_ONLY" or
// say "Live trading is disabled and cannot be enabled here". The cockpit's
// Trading Permission card and the MT5 bridge page instead show the real
// per-account posture from GET /api/me/account-mode, so an armed LIVE_SHARED
// trader saw "Live trading is active" there and "live trading is disabled"
// here.
//
// This module is the only place those modules get their live-trading words:
//   * per account: the same reads and the same pure resolver as
//     /api/me/account-mode (computeAccountShell + getMyArming +
//     readPlatformSwitches → computeAccountModePrecedence, non-admin wording),
//     so the sentence is the cockpit's own cleanModeLabel/cleanUserMessage;
//   * for the platform (reports that are not about one account): see
//     ./platformLivePosture.ts (the live-execution master switch).
//
// It describes; it decides nothing. No gate reads it, nothing here can arm,
// enable or loosen anything, and a read that fails is reported as UNKNOWN —
// never as paper, never as live.

import { computeAccountShell } from "../../routes/meAccountShell.js";
import { getMyArming } from "../live/liveArming.js";
import { readPlatformSwitches, type PlatformSwitches } from "../safety/platformSwitches.js";
import { hhmm } from "./platformLivePosture.js";
import {
  computeAccountModePrecedence,
  type CurrentAccountMode,
} from "../computeAccountModePrecedence.js";

export const ACCOUNT_POSTURE_SOURCE =
  "Account mode check (the same resolver as /api/me/account-mode and the dashboard's Trading Permission card)";

export interface AccountLivePosture {
  /** LIVE_ARMED: armed and no account blocker. LIVE_BLOCKED: shown as live but a blocker stops live orders. NOT_LIVE: demo or paper. UNKNOWN: could not be read. */
  state: "LIVE_ARMED" | "LIVE_BLOCKED" | "NOT_LIVE" | "UNKNOWN";
  currentAccountMode: CurrentAccountMode | null;
  liveExecutionArmed: boolean | null;
  modeLabel: string | null;
  /** One plain-English sentence: what was read, from where, as of when — or that it could not be read. */
  plainEnglish: string;
  source: string;
  checkedAt: string;
}

export interface AccountPostureReads {
  accountShell: {
    tradingMode: "DISABLED" | "SIMULATED" | "DEMO" | "LIVE";
    tradingStatus: string;
    notes: { sharedMasterAccountAssigned?: boolean; needsReviewItems?: number | boolean };
  };
  arming: { isArmed?: boolean | null } | null;
  switches: Pick<PlatformSwitches, "liveBrokerExecution">;
}

/** Pure: the account posture from the same inputs /api/me/account-mode reads. */
export function accountPostureFrom(reads: AccountPostureReads, at: Date = new Date()): AccountLivePosture {
  const lbe = reads.switches.liveBrokerExecution;
  const liveExecutionArmed = reads.arming?.isArmed === true;
  const nri = reads.accountShell.notes.needsReviewItems;
  const p = computeAccountModePrecedence({
    isAdmin: false,
    liveExecutionArmed,
    sharedMasterAttached: reads.accountShell.notes.sharedMasterAccountAssigned === true,
    effectiveLiveBrokerOn: lbe.enabled,
    serverEnvOn: lbe.envEnabled,
    operatorOn: lbe.operatorArmed,
    accountShellTradingMode: reads.accountShell.tradingMode,
    accountShellTradingStatus: reads.accountShell.tradingStatus,
    needsReviewItems: typeof nri === "number" ? nri > 0 : nri === true,
  });
  const state: AccountLivePosture["state"] =
    p.currentAccountMode !== "LIVE_SHARED"
      ? "NOT_LIVE"
      : liveExecutionArmed && p.cleanBlockedReason == null
        ? "LIVE_ARMED"
        : "LIVE_BLOCKED";
  return {
    state,
    currentAccountMode: p.currentAccountMode,
    liveExecutionArmed,
    modeLabel: p.cleanModeLabel,
    plainEnglish: `Your account mode (checked ${hhmm(at)}, the same check as the dashboard's Trading Permission card): ${p.cleanModeLabel}. ${p.cleanUserMessage}`,
    source: ACCOUNT_POSTURE_SOURCE,
    checkedAt: at.toISOString(),
  };
}

export function unknownAccountPosture(at: Date = new Date()): AccountLivePosture {
  return {
    state: "UNKNOWN",
    currentAccountMode: null,
    liveExecutionArmed: null,
    modeLabel: null,
    plainEnglish:
      `Your account mode could not be read (tried ${hhmm(at)}), so this cannot say whether your account is set up for live trading. ` +
      "Check the Trading Permission card on your dashboard before trading.",
    source: ACCOUNT_POSTURE_SOURCE,
    checkedAt: at.toISOString(),
  };
}

/** The caller's account posture, read the way the cockpit reads it. Never throws. */
export async function readAccountLivePosture(userId: number): Promise<AccountLivePosture> {
  try {
    const [accountShell, arming, switches] = await Promise.all([
      // skipInvestorSnapshot: the resolver only reads tradingMode/tradingStatus/notes.
      computeAccountShell(userId, { skipInvestorSnapshot: true }),
      getMyArming(userId),
      readPlatformSwitches(),
    ]);
    return accountPostureFrom({ accountShell, arming, switches });
  } catch {
    return unknownAccountPosture();
  }
}
