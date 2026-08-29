// Build G — Broker Status Card. One-glance read of the broker/MT5 link.
import { useGetBrokerHealth, getGetBrokerHealthQueryKey } from "@workspace/api-client-react";

const STATUS_TONE: Record<string, string> = {
  CONNECTED: "bg-success/15 text-success ring-success/30",
  DEGRADED: "bg-warning/15 text-warning ring-warning/30",
  PRICE_FEED_DELAYED: "bg-warning/15 text-warning ring-warning/30",
  DISCONNECTED: "bg-danger/15 text-danger ring-danger/30",
  AUTH_ERROR: "bg-danger/15 text-danger ring-danger/30",
  EXECUTION_DISABLED: "bg-danger/15 text-danger ring-danger/30",
  MAINTENANCE_MODE: "bg-danger/15 text-danger ring-danger/30",
};

export function BrokerStatusCard() {
  const { data, isLoading } = useGetBrokerHealth({ query: { queryKey: getGetBrokerHealthQueryKey(), refetchInterval: 5_000 } });
  if (isLoading || !data) return <div className="rounded-xl border border-border bg-background/50 p-4 text-sm text-txt-muted">Loading broker status…</div>;
  const tone = STATUS_TONE[data.status] ?? "bg-muted/40 text-txt-secondary ring-border";
  return (
    <div className="rounded-xl border border-border bg-background/50 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-txt-muted">Broker / MT5</div>
          <div className="mt-1 text-base font-semibold text-foreground">{data.brokerName ?? "Not linked"}</div>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${tone}`}>{data.status.replace(/_/g, " ")}</span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-txt-muted">Account</dt><dd className="text-txt-secondary">{data.accountNumber ?? "—"}</dd>
        <dt className="text-txt-muted">Latency</dt><dd className="text-txt-secondary">{data.latencyMs == null ? "—" : `${Math.round(data.latencyMs)} ms`}</dd>
        <dt className="text-txt-muted">Execution</dt><dd className="text-txt-secondary">{data.executionEnabled ? "Enabled" : "Disabled"}</dd>
        <dt className="text-txt-muted">Reconnects</dt><dd className="text-txt-secondary">{data.reconnectAttempts}</dd>
      </dl>
    </div>
  );
}
