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

export interface TradeRoomModeInput {
  isLiveShared: boolean;
  isDemo: boolean;
  isFrozen: boolean;
  canManualTrade: boolean;
  cleanBlockedReason: string | null;
  cleanModeLabel: string;
}

export interface TradeRoomStatus {
  canTrade: boolean;
  modeLabel: string;
  gatesLabel: string;
  blockedLabel: string;
  connStatus: string;
  rgStatus: { label: string; tone: "warning" | "success" | "danger" };
  bridge: string;
}

export function resolveTradeRoomStatus(m: TradeRoomModeInput): TradeRoomStatus {
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
  const gatesLabel = blocked ? (m.cleanBlockedReason || "Trading blocked") : frozen ? "Trading paused" : canTrade ? "All safety gates enforced" : "Waiting for approval";
  // …but its "Bridge disconnected" wording is not what a server blocker means.
  const blockedLabel = blocked && !canTrade ? "Trading blocked" : caps.blockedLabel;

  const connStatus = blocked ? "Disconnected" : isLive ? "LIVE" : m.isDemo ? "Demo" : "Sim";

  const rgStatus = frozen ? { label: "Trading paused", tone: "warning" as const }
    : blocked ? { label: "Trading blocked", tone: "warning" as const }
    : canTrade ? { label: "Trading available", tone: "success" as const }
    : { label: "Risk lock active", tone: "danger" as const };

  const bridge = blocked ? "Disconnected" : "Connected";

  return { canTrade, modeLabel, gatesLabel, blockedLabel, connStatus, rgStatus, bridge };
}
