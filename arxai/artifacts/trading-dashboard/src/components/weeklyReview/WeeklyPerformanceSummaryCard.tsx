import type { WeeklyReview } from "@workspace/api-client-react";

export function WeeklyPerformanceSummaryCard({ r }: { r: WeeklyReview }) {
  const pnlOk = r.netProfitLoss >= 0;
  // The server says when its source had nothing for the week: the zeros are
  // then not a measurement, so they are not shown as one.
  const measured = r.performanceMeasured !== false;
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
      <div className="text-xs uppercase tracking-wide text-zinc-500">
        Week of {new Date(r.weekStartIso).toLocaleDateString()} – {new Date(r.weekEndIso).toLocaleDateString()}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Trades" value={measured ? String(r.totalTrades) : "—"} />
        <Stat label="Win rate" value={measured ? `${(r.winRate * 100).toFixed(0)}%` : "—"} />
        <Stat label="Avg R:R" value={measured ? r.averageRr.toFixed(2) : "—"} />
        <Stat
          label="Net P/L"
          value={measured ? `${pnlOk ? "+" : ""}${r.netProfitLoss.toFixed(2)}` : "—"}
          tone={measured ? (pnlOk ? "good" : "bad") : undefined}
        />
      </div>
      {!measured && (
        <div data-testid="weekly-performance-not-measured" className="mt-2 text-[11px] text-amber-300/90">
          Not measured for this week.
        </div>
      )}
      {r.performanceSourceNote && (
        <div data-testid="weekly-performance-source" className="mt-1 text-[11px] text-zinc-500">
          {r.performanceSourceNote}
        </div>
      )}
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
