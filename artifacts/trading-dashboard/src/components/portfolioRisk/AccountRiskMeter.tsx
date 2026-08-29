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
  const fillCls = ratio >= 1 ? "bg-danger" : ratio >= 0.8 ? "bg-warning" : ratio >= 0.5 ? "bg-warning" : "bg-success";
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="text-txt-secondary font-semibold">Account Risk</span>
        <span className="font-mono text-txt-secondary">{pct.toFixed(2)}% / {capPct}% cap</span>
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded bg-secondary">
        <div className={`h-full ${fillCls} transition-all`} style={{ width: `${Math.min(100, (ratio / 1.5) * 100)}%` }} />
        <div className="absolute inset-y-0 left-2/3 w-px bg-muted" title="Cap" />
      </div>
    </div>
  );
}
