// Trade Command Room — mode / permission → plain-English labels.
//
// Pure so the labels can be pinned by tests. Inputs come from useTradingMode()
// (the server's unified account-mode envelope).
//
// Truth rule: `cleanBlockedReason` is an account / permission / arming blocker
// produced by the server's mode precedence (operator pause, tradingMode,
// live confirmation, master switch, assignment pending …). It never reads a
// bridge heartbeat, so it is labelled as a block, never as "Bridge
// Disconnected".

import { resolveLiveActionCapabilities } from "@/lib/liveActionCapabilities";
import type { BridgeObservation } from "@/components/dashboard/cockpit/bridgeObservation";

export interface TradeRoomModeInput {
  isLiveShared: boolean;
  isDemo: boolean;
  isFrozen: boolean;
  canManualTrade: boolean;
  cleanBlockedReason: string | null;
  cleanModeLabel: string;
  /** The account-mode envelope is still loading (nothing read yet). */
  isLoading?: boolean;
  /** The account-mode check failed: mode, approval, pause and blockers are unknown. */
  isModeUnknown?: boolean;
}

export interface TradeRoomStatus {
  canTrade: boolean;
  modeLabel: string;
  gatesLabel: string;
  blockedLabel: string;
  /** The account route's mode (LIVE / Demo / Sim / Blocked) — not a connection observation. */
  connStatus: string;
  rgStatus: { label: string; tone: "warning" | "success" | "danger" };
  /** Bridge row value, from the bridge observation (never from the envelope). */
  bridge: string;
  /** Risk Governor "Approval" row: the read permission, or that it was not read. */
  approval: string;
}

export function resolveTradeRoomStatus(m: TradeRoomModeInput, bridgeObs: BridgeObservation): TradeRoomStatus {
  // No envelope (still loading, or the check failed): the mode, approval,
  // pause flag and blockers were not read. Say so, instead of falling through
  // to "Sim" / "Risk lock active" / "Waiting for approval" / "Pending" — the
  // user may be LIVE_SHARED. Trading stays closed (canManualTrade is false).
  const modeUnknown = m.isModeUnknown === true;
  if (modeUnknown || m.isLoading === true) {
    return {
      canTrade: false,
      modeLabel: m.cleanModeLabel || (modeUnknown ? "Mode unknown" : "Loading…"),
      gatesLabel: modeUnknown ? "Account mode could not be checked" : "Checking account mode…",
      blockedLabel: modeUnknown ? "Account mode could not be checked" : "Checking account mode",
      connStatus: modeUnknown ? "Mode unknown" : "Checking",
      rgStatus: { label: modeUnknown ? "Could not be checked" : "Checking", tone: "warning" },
      bridge: bridgeObs.label,
      approval: modeUnknown ? "Could not be checked" : "Checking",
    };
  }

  const isLive = m.isLiveShared;
  const blocked = Boolean(m.cleanBlockedReason);
  const frozen = m.isFrozen;
  const caps = resolveLiveActionCapabilities({
    canManualTrade: m.canManualTrade,
    isFrozen: frozen,
    // The capability resolver still fails closed on any server blocker…
    bridgeBlocked: blocked,
  });
  const canTrade = caps.canOpen;

  const modeLabel = blocked ? "Trading blocked" : frozen ? "Trading Paused" : isLive ? "LIVE · Shared Master MT5" : m.isDemo ? "Demo" : (m.cleanModeLabel || "Simulator");
  // canTrade is a permission (approved, not frozen, no blocker). No gate,
  // bridge heartbeat or risk read stands behind it, so it is never worded as
  // "All safety gates enforced".
  const gatesLabel = blocked ? (m.cleanBlockedReason || "Trading blocked") : frozen ? "Trading paused" : canTrade ? "Approved to trade" : "Waiting for approval";
  // …but its "Bridge disconnected" wording is not what a server blocker means.
  const blockedLabel = blocked && !canTrade ? "Trading blocked" : caps.blockedLabel;

  const connStatus = blocked ? "Blocked" : isLive ? "LIVE" : m.isDemo ? "Demo" : "Sim";

  const rgStatus = frozen ? { label: "Trading paused", tone: "warning" as const }
    : blocked ? { label: "Trading blocked", tone: "warning" as const }
    // canManualTrade is permission only (status + approval + no blocker).
    : canTrade ? { label: "Approved to trade", tone: "success" as const }
    // Not frozen, no blocker, not approved: no risk lock was read. Same words
    // as the status bar (gatesLabel) for the same state.
    : { label: "Waiting for approval", tone: "warning" as const };

  const bridge = bridgeObs.label;

  const approval = m.canManualTrade ? "Approved" : "Pending";

  return { canTrade, modeLabel, gatesLabel, blockedLabel, connStatus, rgStatus, bridge, approval };
}

/**
 * Connection-card heading for the account route the user actually trades
 * through (envelope accountShellStatus.accountMode), and whether the shared
 * master summary's broker / account lines describe that route.
 */
export function resolveTradeRoomRoute(m: {
  isLiveShared: boolean;
  envelope: { accountShellStatus?: { accountMode?: string } | null } | null;
}): { heading: string; onSharedRoute: boolean } {
  const routing = m.envelope?.accountShellStatus?.accountMode ?? null;
  if (m.isLiveShared || routing === "SHARED_MASTER_MT5") return { heading: "Shared Master MT5", onSharedRoute: true };
  if (routing === "PERSONAL_MT5") return { heading: "Your MT5 account", onSharedRoute: false };
  if (routing === "DEMO") return { heading: "Demo account", onSharedRoute: false };
  return { heading: "Account route not loaded", onSharedRoute: false };
}
