// (O) Correlation warning banner — displays HIGH/CRITICAL groups from the
// latest correlation report set. Fires its own scan if no recent reports.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

interface Report {
  id: number; symbolGroup: string;
  positionsInGroup: number; symbols: string[];
  totalExposure: number; directionBias: string;
  correlationWarning: string | null;
  riskLevel: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
  aiSummary: string;
  createdAt: string;
}

export function CorrelationWarningBanner() {
  const qc = useQueryClient();
  const { data } = useQuery<{ reports: Report[] }>({
    queryKey: ["correlation-risk-latest"],
    queryFn: async () => {
      const r = await fetch("/api/correlation-risk/latest");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    refetchInterval: 60_000,
  });
  const refresh = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/correlation-risk/generate", { method: "POST" });
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["correlation-risk-latest"] }),
  });
  const reports = (data?.reports ?? []).filter((r) => r.riskLevel === "HIGH" || r.riskLevel === "CRITICAL");
  if (reports.length === 0) return null;
  const hasCritical = reports.some((r) => r.riskLevel === "CRITICAL");
  return (
    <div className={`rounded-md border p-3 text-sm ${hasCritical ? "border-red-700 bg-red-950/60 text-red-100 animate-pulse" : "border-orange-700 bg-orange-950/40 text-orange-100"}`}>
      <div className="flex items-center justify-between">
        <div className="font-semibold">⚠ Correlated exposure detected</div>
        <button onClick={() => refresh.mutate()} className="rounded bg-slate-800/80 px-2 py-0.5 text-[10px] font-semibold text-slate-100 hover:bg-slate-700">
          Re-scan
        </button>
      </div>
      <ul className="mt-1 space-y-0.5 text-xs">
        {reports.slice(0, 5).map((r) => (
          <li key={r.id}>
            <span className="font-mono">{r.symbolGroup}</span> · {r.positionsInGroup} pos · {r.directionBias} · {r.totalExposure.toFixed(2)} lots
            {r.correlationWarning ? <> — {r.correlationWarning}</> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
