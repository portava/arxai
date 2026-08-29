import type { AnalyticsSnapshot } from "./types";

export function ConsistencyTrendCard({ snapshot }: { snapshot: AnalyticsSnapshot }) {
  const items = [
    { label: "Discipline",  v: snapshot.disciplineScoreAvg },
    { label: "Execution",   v: snapshot.executionScoreAvg },
    { label: "Emotional",   v: snapshot.emotionalScoreAvg },
    { label: "Consistency", v: snapshot.consistencyScoreAvg },
  ];
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3">
      <h3 className="mb-2 text-sm font-semibold text-foreground">Behavior Consistency</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {items.map((it) => {
          const tone = it.v >= 70 ? "text-success"
                    : it.v >= 40 ? "text-warning"
                                  : "text-danger";
          return (
            <div key={it.label} className="rounded border border-border bg-background/40 p-2 text-center">
              <div className="text-[10px] uppercase tracking-wide text-txt-secondary">{it.label}</div>
              <div className={`text-lg font-bold ${tone}`}>{Math.round(it.v)}</div>
              <div className="text-[10px] text-txt-muted">/100</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
