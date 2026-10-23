interface Summary {
  tradesEvaluated: number; respectedCount: number; accountabilityScore: number;
  totalPnl: number; consecLosses: number; cooldownTriggered: boolean;
  hardCount: number; warnCount: number;
}
export function RuleComplianceCard({ summary }: { summary: Summary | null }) {
  if (!summary) return null;
  const cells = [
    { l: "Trades today", v: `${summary.tradesEvaluated}` },
    { l: "Trades respected", v: `${summary.respectedCount}` },
    { l: "Hard violations", v: `${summary.hardCount}`, tone: summary.hardCount > 0 ? "text-red-300" : "text-slate-100" },
    { l: "Warnings", v: `${summary.warnCount}`, tone: summary.warnCount > 0 ? "text-amber-300" : "text-slate-100" },
    { l: "P&L (sim)", v: `${summary.totalPnl >= 0 ? "+" : ""}${summary.totalPnl.toFixed(2)}`, tone: summary.totalPnl >= 0 ? "text-emerald-300" : "text-red-300" },
    { l: "Consec. losses", v: `${summary.consecLosses}` },
  ];
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-100">Rule compliance — today</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 text-xs">
        {cells.map((c) => (
          <div key={c.l} className="rounded border border-slate-800 bg-slate-950/40 p-2">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">{c.l}</div>
            <div className={`font-mono ${c.tone ?? "text-slate-100"}`}>{c.v}</div>
          </div>
        ))}
      </div>
      {summary.cooldownTriggered && (
        <p className="mt-2 rounded bg-amber-950/40 p-2 text-[11px] text-amber-300">Cooldown advised — consider stepping away for a session.</p>
      )}
    </div>
  );
}
