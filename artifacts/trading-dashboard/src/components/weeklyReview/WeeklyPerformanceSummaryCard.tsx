import type { WeeklyReview } from "@workspace/api-client-react";

export function WeeklyPerformanceSummaryCard({ r }: { r: WeeklyReview }) {
  const pnlOk = r.netProfitLoss >= 0;
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
      <div className="text-xs uppercase tracking-wide text-zinc-500">
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
  const c = tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-rose-300" : "text-zinc-100";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`text-lg font-semibold ${c}`}>{value}</div>
    </div>
  );
}
