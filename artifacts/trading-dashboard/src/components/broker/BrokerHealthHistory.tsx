// Build G — Append-only history of broker health snapshots.
import { useGetBrokerHealthLogs, getGetBrokerHealthLogsQueryKey } from "@workspace/api-client-react";

export function BrokerHealthHistory({ limit = 25 }: { limit?: number }) {
  const { data, isLoading } = useGetBrokerHealthLogs({ limit }, { query: { queryKey: getGetBrokerHealthLogsQueryKey({ limit }), refetchInterval: 15_000 } });
  if (isLoading || !data) return <div className="text-xs text-zinc-500">Loading history…</div>;
  if (data.logs.length === 0) return <div className="text-xs text-zinc-500">No broker health snapshots yet — run a health check.</div>;
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full text-xs">
        <thead className="bg-zinc-900 text-zinc-500">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Time</th>
            <th className="px-3 py-2 text-left font-medium">Status</th>
            <th className="px-3 py-2 text-left font-medium">Latency</th>
            <th className="px-3 py-2 text-left font-medium">Reconnects</th>
            <th className="px-3 py-2 text-left font-medium">Error</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {data.logs.map((row) => (
            <tr key={row.id} className="bg-zinc-950/40">
              <td className="px-3 py-2 font-mono text-[11px] text-zinc-500">{new Date(row.createdAtIso).toLocaleTimeString()}</td>
              <td className="px-3 py-2 text-zinc-200">{row.status.replace(/_/g, " ")}</td>
              <td className="px-3 py-2 text-zinc-300">{row.latencyMs == null ? "—" : `${row.latencyMs} ms`}</td>
              <td className="px-3 py-2 text-zinc-300">{row.reconnectAttempts}</td>
              <td className="px-3 py-2 text-rose-300">{row.errorCode ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
