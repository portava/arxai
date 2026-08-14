interface Summary {
  status: string;
  totalPct: number; totalPnl: number; currentBalance: number;
  daysWorked: number; daysSinceStart: number;
  minTradingDays: number; maxTradingDays: number;
  tradeCount: number;
}
export function PropChallengeProgressCard({ summary }: { summary: Summary | null }) {
  if (!summary) return null;
  const cells = [
    { l: "Status", v: summary.status },
    { l: "Total P&L", v: `${summary.totalPnl >= 0 ? "+" : ""}${summary.totalPnl.toFixed(2)} (${(summary.totalPct*100).toFixed(2)}%)` },
    { l: "Balance", v: summary.currentBalance.toFixed(2) },
    { l: "Trading days", v: `${summary.daysWorked} / min ${summary.minTradingDays}` },
    { l: "Day", v: `${summary.daysSinceStart} / max ${summary.maxTradingDays}` },
    { l: "Trades", v: `${summary.tradeCount}` },
  ];
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-100">Challenge progress</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 text-xs">
        {cells.map((c) => (
          <div key={c.l} className="rounded border border-slate-800 bg-slate-950/40 p-2">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">{c.l}</div>
            <div className="font-mono text-slate-100">{c.v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
