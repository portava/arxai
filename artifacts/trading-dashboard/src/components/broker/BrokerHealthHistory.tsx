// Build G — Append-only history of broker health snapshots.
import { useGetBrokerHealthLogs, getGetBrokerHealthLogsQueryKey } from "@workspace/api-client-react";

export function BrokerHealthHistory({ limit = 25 }: { limit?: number }) {
  const { data, isLoading } = useGetBrokerHealthLogs({ limit }, { query: { queryKey: getGetBrokerHealthLogsQueryKey({ limit }), refetchInterval: 15_000 } });
  if (isLoading || !data) return <div className="text-xs text-txt-muted">Loading history…</div>;
  if (data.logs.length === 0) return <div className="text-xs text-txt-muted">No broker health snapshots yet — run a health check.</div>;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-xs">
        <thead className="bg-card text-txt-muted">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Time</th>
            <th className="px-3 py-2 text-left font-medium">Status</th>
            <th className="px-3 py-2 text-left font-medium">Latency</th>
            <th className="px-3 py-2 text-left font-medium">Reconnects</th>
            <th className="px-3 py-2 text-left font-medium">Error</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {data.logs.map((row) => (
            <tr key={row.id} className="bg-background/40">
              <td className="px-3 py-2 font-mono text-[11px] text-txt-muted">{new Date(row.createdAtIso).toLocaleTimeString()}</td>
              <td className="px-3 py-2 text-foreground">{row.status.replace(/_/g, " ")}</td>
              <td className="px-3 py-2 text-txt-secondary">{row.latencyMs == null ? "—" : `${row.latencyMs} ms`}</td>
              <td className="px-3 py-2 text-txt-secondary">{row.reconnectAttempts}</td>
              <td className="px-3 py-2 text-danger">{row.errorCode ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
