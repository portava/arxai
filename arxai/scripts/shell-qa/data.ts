// Fixture-only hook adapters. No real API, auth, account or trading provider mounts.
export const useAllUnlocks = () => ({ mt5: false, paper: false, analysis: false, simulator: false });
export const useTradingMode = () => ({
  isLoading: false, isDemo: true, isLiveShared: false,
  isAdminPreviewingUserMode: true, cleanBlockedReason: "",
});
export const useChartSymbol = () => ["EURUSD"];
export const getGetAlertUnreadCountQueryKey = () => ["isolated-shell-unread"];
export const useGetAlertUnreadCount = () => ({
  data: {
    unreadCount: Number(new URLSearchParams(location.search).get("count") ?? 999),
    criticalCount: 12,
  },
});
