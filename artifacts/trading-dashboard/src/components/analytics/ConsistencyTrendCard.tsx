import type { AnalyticsSnapshot } from "./types";

export function ConsistencyTrendCard({ snapshot }: { snapshot: AnalyticsSnapshot }) {
  const items = [
    { label: "Discipline",  v: snapshot.disciplineScoreAvg },
    { label: "Execution",   v: snapshot.executionScoreAvg },
    { label: "Emotional",   v: snapshot.emotionalScoreAvg },
    { label: "Consistency", v: snapshot.consistencyScoreAvg },
  ];
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
      <h3 className="mb-2 text-sm font-semibold text-slate-200">Behavior Consistency</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {items.map((it) => {
          const tone = it.v >= 70 ? "text-emerald-300"
                    : it.v >= 40 ? "text-amber-300"
                                  : "text-red-300";
          return (
            <div key={it.label} className="rounded border border-slate-700 bg-slate-950/40 p-2 text-center">
              <div className="text-[10px] uppercase tracking-wide text-slate-400">{it.label}</div>
              <div className={`text-lg font-bold ${tone}`}>{Math.round(it.v)}</div>
              <div className="text-[10px] text-slate-500">/100</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
