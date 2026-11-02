import { useGetPerformanceSummary } from "@workspace/api-client-react";
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
  const risk = useRiskBudgetSnapshot();
  const canonical = mode.isLiveShared && live.snapshot?.accountMode === "LIVE_SHARED" ? live.live : null;
  const equity = canonical?.liveEquity ?? null;
  const margin = canonical?.freeMargin ?? null;
  const snapshotLoading = mode.isLoading || live.connectionStatus === "connecting" ||
    (live.connectionStatus === "polling" && live.snapshot == null);
  const perf = performance.data;
  const hasTodayPnl = !performance.isLoading && !performance.isError && typeof perf?.todayPnl === "number" && Number.isFinite(perf.todayPnl);
  const utilization = risk.data ? riskUtilizationPercent(risk.data) : null;

  return <section className="arx-account-strip" aria-label="Account overview">
    <Metric label={live.freshness === "fresh" ? "Equity" : "Last-known equity"} value={snapshotLoading ? "Loading…" : cash(equity)} detail={canonical ? `canonical · ${live.freshness}` : snapshotLoading ? "waiting for account snapshot" : "account snapshot unavailable"}/>
    <Metric label="Today’s P/L · UTC" value={performance.isLoading ? "Loading…" : hasTodayPnl ? cash(perf!.todayPnl) : "Unavailable"} detail={performance.isError ? "performance data unavailable" : "realized today"} tone={hasTodayPnl ? perf!.todayPnl >= 0 ? "is-positive" : "is-negative" : undefined}/>
    <Metric label="Available margin" value={snapshotLoading ? "Loading…" : cash(margin)} detail={canonical ? "canonical free margin" : snapshotLoading ? "waiting for account snapshot" : "account snapshot unavailable"}/>
    <Metric label="Risk utilization" value={risk.isLoading && !risk.data ? "Loading…" : utilization == null ? "Unavailable" : `${utilization}%`} detail={risk.isError ? risk.data ? "last known · refresh failed" : "risk budget unavailable" : risk.data ? `of ${cash(risk.data.dailyRiskLimit)} daily limit` : "account-scoped daily budget"}/>
    <div className="arx-strip-metric arx-strip-mode">
      <small>Account mode</small>
      <b>{mode.isLoading ? "Loading…" : mode.isError ? "Unavailable" : mode.cleanModeLabel}</b>
      {mode.isLiveShared && <FreshnessBadge freshness={live.freshness} lastUpdatedMs={live.lastUpdatedMs} isEstimate={live.isEstimate} compact/>}
    </div>
  </section>;
}
