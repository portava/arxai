// Unified trading-mode hook — T003.
//
// Single source of truth for "what mode is this user in?" across every
// page. Wraps /api/me/account-mode (see meUnifiedMode.ts) and exposes
// stable derived booleans + clean user-safe strings.
//
// SAFETY: read-only. Never dispatches trades. The raw envelope's
// `adminDiagnostics` is `null` for non-admin sessions by server-side
// design; the hook does NOT attempt to elevate.

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

export type CurrentAccountMode = "LIVE_SHARED" | "DEMO" | "PAPER";
export type AccountModeRole = "OWNER" | "ADMIN" | "USER";

export interface UnifiedAccountModeEnvelope {
  ok: true;
  userId: number;
  currentAccountMode: CurrentAccountMode;
  cleanModeLabel: string;
  cleanUserMessage: string;
  cleanBlockedReason: string | null;
  role: AccountModeRole;
  isAdmin: boolean;
  isAdminPreviewingUserMode: boolean;
  adminDiagnosticsAvailable: boolean;
  liveExecutionArmed: boolean;
  userSharedMasterAssignment: { attached: boolean };
  accountShellStatus: {
    accountMode: "DEMO" | "PERSONAL_MT5" | "SHARED_MASTER_MT5";
    tradingMode: "DISABLED" | "SIMULATED" | "DEMO" | "LIVE";
    tradingModeLabel: string;
    approvalStatus: string;
    tradingStatus: string;
  };
  userAllocation: {
    hasAllocation: boolean;
    currentBalance: number;
    assignedStartingBalance: number | null;
    equity: number;
    marginUsed: number;
  };
  userRiskCaps: {
    maxLotSize: number | null;
    maxOpenTrades: number | null;
    maxDailyLossAmount: number | null;
    allowedSymbols: string[] | null;
    requireStopLoss: boolean;
  };
  userFrozenStatus: { isFrozen: boolean; freezeMessage: string | null };
  userApprovalStatus: string;
  userCanManualTrade: boolean;
  userCanAutoTrade: boolean;
  aiSleeveStatus: { enabled: boolean; autoEnabled: boolean };
  demoAvailable: boolean;
  paperAvailable: boolean;
  modeSwitchOptions: CurrentAccountMode[];
  adminDiagnostics: unknown | null;
}

export interface UseTradingModeResult {
  isLoading: boolean;
  isError: boolean;
  envelope: UnifiedAccountModeEnvelope | null;

  // Mode booleans
  isLiveShared: boolean;
  isDemo: boolean;
  isPaper: boolean;
  isLiveArmed: boolean;
  isFrozen: boolean;

  // Role
  isAdmin: boolean;
  isAdminPreviewingUserMode: boolean;
  shouldShowAdminDiagnostics: boolean;

  // Permissions
  canManualTrade: boolean;
  canAutoTrade: boolean;

  // Allocation
  isSharedMasterAssigned: boolean;
  hasAllocation: boolean;
  hasRiskCaps: boolean;

  // Display
  cleanModeLabel: string;
  cleanUserMessage: string;
  cleanBlockedReason: string | null;

  // UI control
  /** Live pages must hide demo/paper copy when the user is live-armed. */
  shouldShowDemoPaperCopy: boolean;
}

async function fetchAccountMode(): Promise<UnifiedAccountModeEnvelope | null> {
  const res = await fetch("/api/me/account-mode", { credentials: "include" });
  if (!res.ok) return null;
  const json = (await res.json()) as UnifiedAccountModeEnvelope | { ok: false };
  if (!("ok" in json) || json.ok !== true) return null;
  return json;
}

export function useTradingMode(): UseTradingModeResult {
  // Account-mode rarely changes mid-session — arming/disarming, frozen
  // status flips, master-live approval. None of those need 15s polling.
  // 60s + 30s staleTime cuts /api/me/account-mode traffic 4x while still
  // surfacing arming changes within a minute. Critical surfaces that
  // need instant reflection (after arm/disarm mutations) should call
  // queryClient.invalidateQueries({queryKey:["me","account-mode"]}) in
  // their onSuccess handler.
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["me", "account-mode"],
    queryFn: fetchAccountMode,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // Foreground resync: when the tab becomes visible again after being
  // hidden, immediately refetch account-mode. This closes the freshness
  // gap introduced by background-polling pause + 60s interval — without
  // it, a user returning to the tab could see stale arming/freeze state
  // for up to a minute.
  useEffect(() => {
    const onVis = () => {
      if (!document.hidden) {
        void qc.invalidateQueries({ queryKey: ["me", "account-mode"] });
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [qc]);

  const env = q.data ?? null;

  const isLiveShared = env?.currentAccountMode === "LIVE_SHARED";
  const isDemo = env?.currentAccountMode === "DEMO";
  const isPaper = env?.currentAccountMode === "PAPER";
  const isLiveArmed = env?.liveExecutionArmed === true;
  const isFrozen = env?.userFrozenStatus.isFrozen === true;

  const isAdmin = env?.isAdmin === true;
  const isAdminPreviewingUserMode = env?.isAdminPreviewingUserMode === true;
  const shouldShowAdminDiagnostics = isAdmin && env?.adminDiagnosticsAvailable === true;

  const canManualTrade = env?.userCanManualTrade === true;
  const canAutoTrade = env?.userCanAutoTrade === true;

  const isSharedMasterAssigned = env?.userSharedMasterAssignment.attached === true;
  const hasAllocation = env?.userAllocation.hasAllocation === true;
  const hasRiskCaps = env?.userRiskCaps.maxLotSize != null;

  const cleanModeLabel = env?.cleanModeLabel ?? "Loading…";
  const cleanUserMessage = env?.cleanUserMessage ?? "";
  const cleanBlockedReason = env?.cleanBlockedReason ?? null;

  const shouldShowDemoPaperCopy = !isLiveShared && !isLiveArmed;

  return {
    isLoading: q.isLoading,
    isError: q.isError,
    envelope: env,
    isLiveShared,
    isDemo,
    isPaper,
    isLiveArmed,
    isFrozen,
    isAdmin,
    isAdminPreviewingUserMode,
    shouldShowAdminDiagnostics,
    canManualTrade,
    canAutoTrade,
    isSharedMasterAssigned,
    hasAllocation,
    hasRiskCaps,
    cleanModeLabel,
    cleanUserMessage,
    cleanBlockedReason,
    shouldShowDemoPaperCopy,
  };
}
