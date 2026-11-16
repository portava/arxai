import { useQuery } from "@tanstack/react-query";

interface Hist { closedCount: number; wins: number; losses: number; winRate: number; netPnl: number; }

function Stat({ label, value, tone, testId }: { label: string; value: string; tone?: "good"|"bad"; testId?: string }) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/40 p-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-sm font-semibold ${tone==="good"?"text-green-400":tone==="bad"?"text-red-400":"text-slate-100"}`} data-testid={testId}>{value}</div>
    </div>
  );
}

export function PaperPerformanceSummary({ accountId }: { accountId: number | null }) {
  const { data, isError, isLoading, dataUpdatedAt } = useQuery<Hist>({
    queryKey: ["paper-history", accountId],
    queryFn: async () => {
      const r = await fetch(`/api/paper/history?accountId=${accountId}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: accountId != null,
    refetchInterval: 6000,
  });
  // Stats are shown only from a successful read. No account, a pending read or
  // a failed first read each say so instead of rendering zeros.
  const state = accountId == null
    ? "No demo account selected, so demo performance is not shown."
    : data == null && isError
      ? "Demo performance could not be loaded. These are not zero results."
      : data == null || isLoading
        ? "Loading demo performance…"
        : null;
  // With no closed trades the win rate is undefined, not 0%.
  const hasClosed = (data?.closedCount ?? 0) > 0;
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-100">Demo performance</h3>
      {isError && data ? (
        <p className="mb-2 text-[11px] text-amber-300" role="alert" data-testid="paper-performance-refresh-failed">
          Could not refresh demo performance. Showing the last successful read
          {dataUpdatedAt > 0 ? ` from ${new Date(dataUpdatedAt).toLocaleTimeString()}` : ""}; totals may have changed since.
        </p>
      ) : null}
      {state != null || data == null ? (
        <p className={`text-xs ${isError ? "text-amber-300" : "text-slate-500"}`} data-testid="paper-performance-state">{state}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Closed" value={`${data.closedCount}`} />
            <Stat label="Wins" value={`${data.wins}`} tone="good" />
            <Stat label="Losses" value={`${data.losses}`} tone="bad" />
            <Stat
              label="Win rate"
              value={hasClosed ? `${(data.winRate * 100).toFixed(1)}%` : "—"}
              tone={hasClosed ? (data.winRate >= 0.5 ? "good" : "bad") : undefined}
              testId="paper-performance-winrate"
            />
            <Stat
              label="Net P&L"
              value={data.netPnl.toFixed(2)}
              tone={data.netPnl > 0 ? "good" : data.netPnl < 0 ? "bad" : undefined}
              testId="paper-performance-netpnl"
            />
          </div>
          {!hasClosed ? (
            <p className="mt-2 text-[11px] text-slate-500" data-testid="paper-performance-no-closed">
              No closed demo trades yet, so there is no win rate.
            </p>
          ) : null}
        </>
      )}
      <p className="mt-2 rounded border border-amber-700 bg-amber-950/30 p-2 text-[11px] text-amber-200">
        ⚠ Simulated — demo trading does not guarantee live results. Practice scores never affect live trading stats.
      </p>
    </div>
  );
}
