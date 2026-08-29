type Status = "READY"|"CAUTION"|"NOT_READY"|"LOCKED";
const grad: Record<Status, string> = {
  READY:     "from-success to-success text-success",
  CAUTION:   "from-warning to-warning text-warning",
  NOT_READY: "from-warning/15 to-warning text-warning",
  LOCKED:    "from-danger/15 to-danger text-danger",
};
export function ReadinessScoreCard({ score, status }: { score: number; status: Status }) {
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Readiness score</h3>
        <span className="text-[10px] uppercase tracking-wide text-txt-muted">advisory</span>
      </div>
      <div className={`mt-2 rounded-lg bg-gradient-to-br p-4 text-center ${grad[status]}`}>
        <div className="text-4xl font-bold">{score}</div>
        <div className="text-[11px] opacity-90">of 100 — {status}</div>
      </div>
    </div>
  );
}
