export function AccountabilityScoreCard({ score, hardCount }: { score: number; hardCount: number }) {
  const tone = score >= 90 ? "from-success to-success text-success"
              : score >= 70 ? "from-warning to-warning text-warning"
              : "from-danger/15 to-danger text-danger";
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Accountability score</h3>
        <span className="text-[10px] uppercase tracking-wide text-txt-muted">soft signal</span>
      </div>
      <div className={`mt-2 rounded-lg bg-gradient-to-br ${tone} p-4 text-center`}>
        <div className="text-4xl font-bold">{score}</div>
        <div className="text-[11px] opacity-80">of 100</div>
      </div>
      <p className="mt-2 text-[11px] text-txt-secondary">
        {hardCount > 0
          ? `${hardCount} hard rule violation${hardCount === 1 ? "" : "s"} today — review and reset.`
          : "Accountability is built rep by rep."}
      </p>
    </div>
  );
}
