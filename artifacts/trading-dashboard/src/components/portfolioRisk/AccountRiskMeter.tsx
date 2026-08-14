// (O) Compact horizontal meter showing total open risk % vs the account's
// daily-loss cap. Reads latest snapshot.

import { useQuery } from "@tanstack/react-query";

interface Snapshot { totalRiskPercent: number; portfolioRiskLevel: string; }

export function AccountRiskMeter({ capPct = 2 }: { capPct?: number }) {
  const { data } = useQuery<Snapshot>({
    queryKey: ["portfolio-risk-latest"],
    queryFn: async () => {
      const r = await fetch("/api/portfolio-risk/latest");
      if (!r.ok) throw new Error("no-snap");
      return r.json();
    },
    retry: false, refetchInterval: 30_000,
  });
  const pct = data?.totalRiskPercent ?? 0;
  const ratio = capPct > 0 ? Math.min(1.5, pct / capPct) : 0;
  const fillCls = ratio >= 1 ? "bg-red-600" : ratio >= 0.8 ? "bg-orange-500" : ratio >= 0.5 ? "bg-amber-500" : "bg-green-500";
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="text-slate-300 font-semibold">Account Risk</span>
        <span className="font-mono text-slate-400">{pct.toFixed(2)}% / {capPct}% cap</span>
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded bg-slate-800">
        <div className={`h-full ${fillCls} transition-all`} style={{ width: `${Math.min(100, (ratio / 1.5) * 100)}%` }} />
        <div className="absolute inset-y-0 left-2/3 w-px bg-slate-500" title="Cap" />
      </div>
    </div>
  );
}
