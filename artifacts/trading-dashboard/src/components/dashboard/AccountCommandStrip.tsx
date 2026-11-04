import {
  getGetMeSharedAccountSummaryQueryKey,
  useGetMeSharedAccountSummary,
  useGetPerformanceSummary,
} from "@workspace/api-client-react";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import { useLiveAccountSnapshotCtx } from "@/hooks/useLiveAccountSnapshotContext";
import { useTradingMode } from "@/hooks/useTradingMode";
import { riskUtilizationPercent } from "@/lib/risk-budget";
import { useRiskBudgetSnapshot } from "@/hooks/useRiskBudgetSnapshot";

function cash(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "Unavailable";
  const sign = value < 0 ? "−" : "";
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: string }) {
  return <div className="arx-strip-metric">
    <small>{label}</small>
    <b className={tone}>{value}</b>
    {detail && <span>{detail}</span>}
  </div>;
}

export function AccountCommandStrip() {
  const live = useLiveAccountSnapshotCtx();
  const mode = useTradingMode();
  const performance = useGetPerformanceSummary();
  const accountSummary = useGetMeSharedAccountSummary({
    query: { queryKey: getGetMeSharedAccountSummaryQueryKey(), refetchInterval: 5000 },
  });
  const risk = useRiskBudgetSnapshot();
  const canonical = mode.isLiveShared && live.snapshot?.accountMode === "LIVE_SHARED" ? live.live : null;
  const summary = accountSummary.data;
  const userAccounts = Array.isArray(summary?.accounts) ? summary.accounts : [];
  const summedUserEquity = userAccounts.length > 0 && userAccounts.every(account => finite(account.virtualEquity) != null)
    ? finite(userAccounts.reduce((total, account) => total + (finite(account.virtualEquity) ?? 0), 0))
    : null;
  const canShowMasterEquity = mode.isAdmin && Boolean(summary?.masterAccess && summary.masterMt5);
  const nonSharedEquity = canShowMasterEquity
    ? finite(summary?.masterMt5?.mt5Equity)
    : summedUserEquity;
  const equity = canonical?.liveEquity ?? (mode.isLiveShared ? null : nonSharedEquity);
  const margin = canonical?.freeMargin ?? null;
  const snapshotLoading = mode.isLoading || live.connectionStatus === "connecting" ||
    (live.connectionStatus === "polling" && live.snapshot == null);
  const equityLoading = mode.isLoading || (mode.isLiveShared
    ? snapshotLoading
    : accountSummary.isLoading && !accountSummary.data);
  const nonSharedEquityStale = !mode.isLiveShared && Boolean(accountSummary.data && accountSummary.isError);
  const equityLabel = (canonical && live.freshness !== "fresh") || nonSharedEquityStale
    ? "Last-known equity"
    : "Equity";
  const equityDetail = mode.isError
    ? "account mode unavailable"
    : canonical
      ? `canonical · ${live.freshness === "fresh" ? "fresh" : "last known"}`
      : mode.isLiveShared
        ? snapshotLoading ? "waiting for matching live account snapshot" : "matching live account equity unavailable"
        : nonSharedEquityStale
          ? "user account equity · refresh failed"
          : summedUserEquity != null || canShowMasterEquity
            ? canShowMasterEquity ? "authorized account equity" : "user virtual equity"
            : accountSummary.isLoading
              ? "loading user account equity"
              : accountSummary.isError
                ? "user account summary unavailable"
                : "user virtual equity unavailable";
  const equityValue = mode.isError ? "Unavailable" : equityLoading ? "Loading…" : cash(equity);
  const marginLoading = mode.isLoading || (mode.isLiveShared && snapshotLoading);
  const marginDetail = mode.isError
    ? "account mode unavailable"
    : canonical
      ? margin == null
        ? "authoritative active-account free margin unavailable"
        : `canonical free margin · ${live.freshness === "fresh" ? "fresh" : "last known"}`
      : mode.isLiveShared
        ? snapshotLoading ? "waiting for active account snapshot" : "active-account free margin unavailable"
        : "free margin not provided by DEMO/PAPER account summary";
  const perf = performance.data;
  const hasTodayPnl = !performance.isLoading && !performance.isError && typeof perf?.todayPnl === "number" && Number.isFinite(perf.todayPnl);
  const utilization = risk.data ? riskUtilizationPercent(risk.data) : null;

  return <section className="arx-account-strip" aria-label="Account overview">
    <Metric label={equityLabel} value={equityValue} detail={equityDetail}/>
    <Metric label="Today’s P/L · UTC" value={performance.isLoading ? "Loading…" : hasTodayPnl ? cash(perf!.todayPnl) : "Unavailable"} detail={performance.isError ? "performance data unavailable" : "realized today"} tone={hasTodayPnl ? perf!.todayPnl >= 0 ? "is-positive" : "is-negative" : undefined}/>
    <Metric label="Available margin" value={marginLoading ? "Loading…" : cash(margin)} detail={marginDetail}/>
    <Metric label="Risk utilization" value={risk.isLoading && !risk.data ? "Loading…" : utilization == null ? "Unavailable" : `${utilization}%`} detail={risk.isError ? risk.data ? "last known · refresh failed" : "risk budget unavailable" : risk.data ? `of ${cash(risk.data.dailyRiskLimit)} daily limit` : "account-scoped daily budget"}/>
    <div className="arx-strip-metric arx-strip-mode">
      <small>Account mode</small>
      <b>{mode.isLoading ? "Loading…" : mode.isError ? "Unavailable" : mode.cleanModeLabel}</b>
      {mode.isLiveShared && <FreshnessBadge freshness={live.freshness} lastUpdatedMs={live.lastUpdatedMs} isEstimate={live.isEstimate} compact/>}
    </div>
  </section>;
}
