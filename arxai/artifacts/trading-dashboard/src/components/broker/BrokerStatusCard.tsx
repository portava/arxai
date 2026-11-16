// Build G — Broker Status Card. One-glance read of the broker/MT5 link.
import { useGetBrokerHealth, getGetBrokerHealthQueryKey } from "@workspace/api-client-react";

const STATUS_TONE: Record<string, string> = {
  CONNECTED: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  DEGRADED: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  PRICE_FEED_DELAYED: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  DISCONNECTED: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  AUTH_ERROR: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  EXECUTION_DISABLED: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  MAINTENANCE_MODE: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
};

export function BrokerStatusCard() {
  const { data, isLoading } = useGetBrokerHealth({ query: { queryKey: getGetBrokerHealthQueryKey(), refetchInterval: 5_000 } });
  if (isLoading || !data) return <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4 text-sm text-zinc-500">Loading broker status…</div>;
  const tone = STATUS_TONE[data.status] ?? "bg-zinc-700/40 text-zinc-300 ring-zinc-700";
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">Broker / MT5</div>
          <div className="mt-1 text-base font-semibold text-zinc-100">{data.brokerName ?? "Not linked"}</div>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${tone}`}>{data.status.replace(/_/g, " ")}</span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-zinc-500">Account</dt><dd className="text-zinc-300">{data.accountNumber ?? "—"}</dd>
        <dt className="text-zinc-500">Latency</dt><dd className="text-zinc-300">{data.latencyMs == null ? "—" : `${Math.round(data.latencyMs)} ms`}</dd>
        <dt className="text-zinc-500">Execution</dt><dd className="text-zinc-300">{data.executionEnabled ? "Enabled" : "Disabled"}</dd>
        <dt className="text-zinc-500">Reconnects</dt><dd className="text-zinc-300">{data.reconnectAttempts}</dd>
      </dl>
    </div>
  );
}
