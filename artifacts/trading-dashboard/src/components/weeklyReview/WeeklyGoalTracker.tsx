import { useQueryClient } from "@tanstack/react-query";
import {
  useUpdateWeeklyGoal, getGetLatestWeeklyReviewQueryKey, getListWeeklyGoalsQueryKey,
  type WeeklyGoal,
} from "@workspace/api-client-react";

const STATUS_LABEL: Record<WeeklyGoal["status"], string> = {
  ACTIVE: "Active", COMPLETED: "Completed", MISSED: "Missed", DROPPED: "Dropped",
};

export function WeeklyGoalTracker({ goals }: { goals: WeeklyGoal[] }) {
  const qc = useQueryClient();
  const upd = useUpdateWeeklyGoal({ mutation: {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getGetLatestWeeklyReviewQueryKey() });
      qc.invalidateQueries({ queryKey: getListWeeklyGoalsQueryKey() });
    },
  } });
  if (goals.length === 0) return <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 text-xs text-zinc-500">No goals.</div>;
  return (
    <div className="space-y-2">
      <div className="text-xs uppercase tracking-wide text-zinc-500">Improvement goals</div>
      <ul className="space-y-2">
        {goals.map((g) => (
          <li key={g.id} className="space-y-1.5 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-sm font-medium text-zinc-100">{g.goalTitle}</div>
                {g.goalDescription && <div className="text-[11px] text-zinc-400">{g.goalDescription}</div>}
                {g.targetMetric && (
                  <div className="text-[10px] text-zinc-500">
                    {g.targetMetric}: {g.startingValue ?? "—"} → {g.targetValue ?? "—"}
                  </div>
                )}
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ring-1 ${
                g.status === "COMPLETED" ? "bg-emerald-500/20 text-emerald-200 ring-emerald-500/40" :
                g.status === "MISSED"    ? "bg-rose-500/20 text-rose-200 ring-rose-500/40" :
                g.status === "DROPPED"   ? "bg-zinc-700/40 text-zinc-300 ring-zinc-600" :
                                           "bg-amber-500/20 text-amber-200 ring-amber-500/40"
              }`}>{STATUS_LABEL[g.status]}</span>
            </div>
            {g.status === "ACTIVE" && (
              <div className="flex gap-1.5 pt-1">
                <button type="button" onClick={() => upd.mutate({ id: g.id, data: { status: "COMPLETED" } })}
                  className="rounded-md bg-emerald-500/80 px-2 py-0.5 text-[10px] text-white hover:bg-emerald-500">Complete</button>
                <button type="button" onClick={() => upd.mutate({ id: g.id, data: { status: "MISSED" } })}
                  className="rounded-md bg-rose-500/80 px-2 py-0.5 text-[10px] text-white hover:bg-rose-500">Missed</button>
                <button type="button" onClick={() => upd.mutate({ id: g.id, data: { status: "DROPPED" } })}
                  className="rounded-md bg-zinc-700 px-2 py-0.5 text-[10px] text-zinc-200 hover:bg-zinc-600">Drop</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
