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
  LOW:      "bg-success/15 text-white",
  MODERATE: "bg-warning/15 text-white",
  HIGH:     "bg-warning/15 text-white",
  CRITICAL: "bg-danger/15 text-white",
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
    <div className="rounded-lg border border-border bg-muted/40 p-4">
      <h3 className="mb-2 text-sm font-semibold text-foreground">Exposure breakdown</h3>
      {isLoading && <p className="text-xs text-txt-muted">Loading…</p>}
      {!isLoading && reports.length === 0 && (
        <p className="text-xs text-txt-muted">No correlated groups (each open position is in a unique group).</p>
      )}
      <div className="space-y-1">
        {reports.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background/40 p-2 text-xs">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${LEVEL_STYLES[r.riskLevel] ?? "bg-muted"}`}>{r.riskLevel}</span>
            <span className="font-mono text-txt-secondary w-32 truncate">{r.symbolGroup}</span>
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-txt-secondary">{r.directionBias}</span>
            <span className="text-txt-secondary">{r.positionsInGroup} pos</span>
            <span className="text-txt-secondary">{r.totalExposure.toFixed(2)} lots</span>
            <span className="flex-1 truncate text-txt-muted">{r.symbols.join(", ")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
