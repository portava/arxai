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
    { l: "Hard violations", v: `${summary.hardCount}`, tone: summary.hardCount > 0 ? "text-danger" : "text-foreground" },
    { l: "Warnings", v: `${summary.warnCount}`, tone: summary.warnCount > 0 ? "text-warning" : "text-foreground" },
    { l: "P&L (sim)", v: `${summary.totalPnl >= 0 ? "+" : ""}${summary.totalPnl.toFixed(2)}`, tone: summary.totalPnl >= 0 ? "text-success" : "text-danger" },
    { l: "Consec. losses", v: `${summary.consecLosses}` },
  ];
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4">
      <h3 className="mb-2 text-sm font-semibold text-foreground">Rule compliance — today</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 text-xs">
        {cells.map((c) => (
          <div key={c.l} className="rounded border border-border bg-background/40 p-2">
            <div className="text-[10px] uppercase tracking-wide text-txt-muted">{c.l}</div>
            <div className={`font-mono ${c.tone ?? "text-foreground"}`}>{c.v}</div>
          </div>
        ))}
      </div>
      {summary.cooldownTriggered && (
        <p className="mt-2 rounded bg-warning/40 p-2 text-[11px] text-warning">Cooldown advised — consider stepping away for a session.</p>
      )}
    </div>
  );
}
