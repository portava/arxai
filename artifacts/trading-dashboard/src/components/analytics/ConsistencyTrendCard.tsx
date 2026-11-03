import type { AnalyticsFigures } from "./types";

export function ConsistencyTrendCard({ snapshot }: { snapshot: AnalyticsFigures }) {
  const items = [
    { key: "disciplineScoreAvg",  label: "Discipline",  v: snapshot.disciplineScoreAvg },
    { key: "executionScoreAvg",   label: "Execution",   v: snapshot.executionScoreAvg },
    { key: "emotionalScoreAvg",   label: "Emotional",   v: snapshot.emotionalScoreAvg },
    { key: "consistencyScoreAvg", label: "Consistency", v: snapshot.consistencyScoreAvg },
  ];
  const asOf = snapshot.behaviorAsOf ? new Date(snapshot.behaviorAsOf) : null;
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
      <h3 className="mb-2 text-sm font-semibold text-slate-200">Behavior Consistency</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {items.map((it) => {
          // null = not measured: "—" in a neutral colour with the reason, never a red 0/100.
          if (it.v == null) {
            return (
              <div key={it.label} className="rounded border border-slate-700 bg-slate-950/40 p-2 text-center" data-testid={`consistency-${it.label}`}>
                <div className="text-[10px] uppercase tracking-wide text-slate-400">{it.label}</div>
                <div className="text-lg font-bold text-slate-400">—</div>
                <div className="text-[10px] text-slate-500">{snapshot.unmeasured?.[it.key] ?? "Not measured"}</div>
              </div>
            );
          }
          const tone = it.v >= 70 ? "text-emerald-300"
                    : it.v >= 40 ? "text-amber-300"
                                  : "text-red-300";
          return (
            <div key={it.label} className="rounded border border-slate-700 bg-slate-950/40 p-2 text-center" data-testid={`consistency-${it.label}`}>
              <div className="text-[10px] uppercase tracking-wide text-slate-400">{it.label}</div>
              <div className={`text-lg font-bold ${tone}`}>{Math.round(it.v)}</div>
              <div className="text-[10px] text-slate-500">/100</div>
            </div>
          );
        })}
      </div>
      {asOf && !Number.isNaN(asOf.getTime()) ? (
        <p className="mt-2 text-[10px] text-slate-500" data-testid="consistency-asof">
          From your Trader Skill profile computed {asOf.toLocaleString()}.
        </p>
      ) : null}
    </div>
  );
}
