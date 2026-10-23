// (O) Per-group exposure breakdown — shows every group from the latest
// correlation report set with bias, position count, lot total, risk label.

import { useQuery } from "@tanstack/react-query";

interface Report {
  id: number; symbolGroup: string;
  positionsInGroup: number; symbols: string[];
  totalExposure: number; directionBias: string;
  correlationWarning: string | null;
  riskLevel: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
  createdAt: string;
}

const LEVEL_STYLES: Record<string, string> = {
  LOW:      "bg-green-700 text-white",
  MODERATE: "bg-amber-700 text-white",
  HIGH:     "bg-orange-700 text-white",
  CRITICAL: "bg-red-700 text-white",
};

export function ExposureBreakdownPanel() {
  const { data, isLoading } = useQuery<{ reports: Report[] }>({
    queryKey: ["correlation-risk-latest"],
    queryFn: async () => {
      const r = await fetch("/api/correlation-risk/latest");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    refetchInterval: 60_000,
  });
  const reports = data?.reports ?? [];
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-100">Exposure breakdown</h3>
      {isLoading && <p className="text-xs text-slate-500">Loading…</p>}
      {!isLoading && reports.length === 0 && (
        <p className="text-xs text-slate-500">No correlated groups (each open position is in a unique group).</p>
      )}
      <div className="space-y-1">
        {reports.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-md border border-slate-800 bg-slate-950/40 p-2 text-xs">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${LEVEL_STYLES[r.riskLevel] ?? "bg-slate-700"}`}>{r.riskLevel}</span>
            <span className="font-mono text-slate-300 w-32 truncate">{r.symbolGroup}</span>
            <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300">{r.directionBias}</span>
            <span className="text-slate-300">{r.positionsInGroup} pos</span>
            <span className="text-slate-300">{r.totalExposure.toFixed(2)} lots</span>
            <span className="flex-1 truncate text-slate-500">{r.symbols.join(", ")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
