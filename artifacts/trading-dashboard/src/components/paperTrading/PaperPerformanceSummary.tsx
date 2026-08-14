import { useQuery } from "@tanstack/react-query";

interface Hist { closedCount: number; wins: number; losses: number; winRate: number; netPnl: number; }

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good"|"bad" }) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/40 p-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-sm font-semibold ${tone==="good"?"text-green-400":tone==="bad"?"text-red-400":"text-slate-100"}`}>{value}</div>
    </div>
  );
}

export function PaperPerformanceSummary({ accountId }: { accountId: number | null }) {
  const { data } = useQuery<Hist>({
    queryKey: ["paper-history", accountId],
    queryFn: async () => {
      const r = await fetch(`/api/paper/history?accountId=${accountId}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: accountId != null,
    refetchInterval: 6000,
  });
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-100">Demo performance</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Closed" value={`${data?.closedCount ?? 0}`} />
        <Stat label="Wins" value={`${data?.wins ?? 0}`} tone="good" />
        <Stat label="Losses" value={`${data?.losses ?? 0}`} tone="bad" />
        <Stat label="Win rate" value={`${((data?.winRate ?? 0)*100).toFixed(1)}%`} tone={(data?.winRate ?? 0)>=0.5?"good":"bad"} />
        <Stat label="Net P&L" value={(data?.netPnl ?? 0).toFixed(2)} tone={(data?.netPnl ?? 0)>=0?"good":"bad"} />
      </div>
      <p className="mt-2 rounded border border-amber-700 bg-amber-950/30 p-2 text-[11px] text-amber-200">
        ⚠ Simulated — demo trading does not guarantee live results. Practice scores never affect live trading stats.
      </p>
    </div>
  );
}
