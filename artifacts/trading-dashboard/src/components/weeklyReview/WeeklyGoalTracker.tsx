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
  if (goals.length === 0) return <div className="rounded-lg border border-border bg-background/50 p-3 text-xs text-txt-muted">No goals.</div>;
  return (
    <div className="space-y-2">
      <div className="text-xs uppercase tracking-wide text-txt-muted">Improvement goals</div>
      <ul className="space-y-2">
        {goals.map((g) => (
          <li key={g.id} className="space-y-1.5 rounded-xl border border-border bg-background/50 p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-sm font-medium text-foreground">{g.goalTitle}</div>
                {g.goalDescription && <div className="text-[11px] text-txt-secondary">{g.goalDescription}</div>}
                {g.targetMetric && (
                  <div className="text-[10px] text-txt-muted">
                    {g.targetMetric}: {g.startingValue ?? "—"} → {g.targetValue ?? "—"}
                  </div>
                )}
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ring-1 ${
                g.status === "COMPLETED" ? "bg-success/20 text-success ring-success/40" :
                g.status === "MISSED"    ? "bg-danger/20 text-danger ring-danger/40" :
                g.status === "DROPPED"   ? "bg-muted/40 text-txt-secondary ring-border" :
                                           "bg-warning/20 text-warning ring-warning/40"
              }`}>{STATUS_LABEL[g.status]}</span>
            </div>
            {g.status === "ACTIVE" && (
              <div className="flex gap-1.5 pt-1">
                <button type="button" onClick={() => upd.mutate({ id: g.id, data: { status: "COMPLETED" } })}
                  className="rounded-md bg-success/80 px-2 py-0.5 text-[10px] text-white hover:bg-success">Complete</button>
                <button type="button" onClick={() => upd.mutate({ id: g.id, data: { status: "MISSED" } })}
                  className="rounded-md bg-danger/80 px-2 py-0.5 text-[10px] text-white hover:bg-danger">Missed</button>
                <button type="button" onClick={() => upd.mutate({ id: g.id, data: { status: "DROPPED" } })}
                  className="rounded-md bg-muted px-2 py-0.5 text-[10px] text-foreground hover:bg-muted">Drop</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
