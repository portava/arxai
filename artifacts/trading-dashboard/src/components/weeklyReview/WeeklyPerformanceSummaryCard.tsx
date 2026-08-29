import type { WeeklyReview } from "@workspace/api-client-react";

export function WeeklyPerformanceSummaryCard({ r }: { r: WeeklyReview }) {
  const pnlOk = r.netProfitLoss >= 0;
  return (
    <div className="rounded-xl border border-border bg-background/50 p-4">
      <div className="text-xs uppercase tracking-wide text-txt-muted">
        Week of {new Date(r.weekStartIso).toLocaleDateString()} – {new Date(r.weekEndIso).toLocaleDateString()}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Trades" value={String(r.totalTrades)} />
        <Stat label="Win rate" value={`${(r.winRate * 100).toFixed(0)}%`} />
        <Stat label="Avg R:R" value={r.averageRr.toFixed(2)} />
        <Stat label="Net P/L" value={`${pnlOk ? "+" : ""}${r.netProfitLoss.toFixed(2)}`} tone={pnlOk ? "good" : "bad"} />
      </div>
    </div>
  );
}
function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  const c = tone === "good" ? "text-success" : tone === "bad" ? "text-danger" : "text-foreground";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-txt-muted">{label}</div>
      <div className={`text-lg font-semibold ${c}`}>{value}</div>
    </div>
  );
}
