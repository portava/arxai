// (O) Compact open-risk summary — designed for sidebars / small dashboard
// slots. Shows count + total risk % + level pill.

import { useQuery } from "@tanstack/react-query";

interface Snapshot {
  openPositionsCount: number;
  totalRiskPercent: number;
  totalUnrealizedPnl: number;
  portfolioRiskLevel: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
}

const LEVEL_STYLES: Record<string, string> = {
  LOW: "bg-green-700", MODERATE: "bg-amber-700", HIGH: "bg-orange-700", CRITICAL: "bg-red-700 animate-pulse",
};

export function OpenRiskSummary() {
  const { data } = useQuery<Snapshot>({
    queryKey: ["portfolio-risk-latest"],
    queryFn: async () => {
      const r = await fetch("/api/portfolio-risk/latest");
      if (!r.ok) throw new Error("no-snap");
      return r.json();
    },
    retry: false, refetchInterval: 30_000,
  });
  if (!data) return null;
  return (
    <div className="flex items-center gap-3 rounded-md border border-slate-700 bg-slate-900/40 px-3 py-2 text-xs">
      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold text-white ${LEVEL_STYLES[data.portfolioRiskLevel] ?? "bg-slate-700"}`}>{data.portfolioRiskLevel}</span>
      <span className="text-slate-300">{data.openPositionsCount} open</span>
      <span className="text-slate-300">Risk {data.totalRiskPercent.toFixed(2)}%</span>
      <span className={data.totalUnrealizedPnl >= 0 ? "text-green-400" : "text-red-400"}>
        P&L {data.totalUnrealizedPnl >= 0 ? "+" : ""}{data.totalUnrealizedPnl.toFixed(2)}
      </span>
    </div>
  );
}
